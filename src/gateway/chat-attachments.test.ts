import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

const saveMediaBufferMock = vi.hoisted(() =>
  vi.fn(async (_buffer: Buffer, mime?: string, _subdir?: string) => ({
    id: `fake-id-${Math.random().toString(36).slice(2, 10)}`,
    path: `/tmp/openclaw-test-media/inbound/fake.${mime?.split("/")[1] ?? "bin"}`,
    size: 0,
    contentType: mime,
  })),
);
const deleteMediaBufferMock = vi.hoisted(() =>
  vi.fn(async (_id: string, _subdir?: string) => undefined),
);
const probeMediaFilesWithinBudgetMock = vi.hoisted(() =>
  vi.fn(async (inputs: readonly unknown[]) => inputs.map(() => ({}))),
);

vi.mock("../media/store.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    saveMediaBuffer: saveMediaBufferMock,
    deleteMediaBuffer: deleteMediaBufferMock,
  };
});
vi.mock("../media/media-probe.js", () => ({
  probeMediaFilesWithinBudget: probeMediaFilesWithinBudgetMock,
}));

import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  getWorkerComputeCapacity,
} from "../infra/worker-task-capacity.js";
import { resizeToJpeg } from "../media/image-ops.js";
import {
  canonicalizePersistedUserMessageMedia,
  readPersistedMediaFacts,
} from "../media/media-facts.js";
import {
  buildPersistedUserTurnMediaInputsFromFields,
  buildPersistedUserTurnMessage,
} from "../sessions/user-turn-transcript.message.js";
import { resolveChatAttachmentPolicy } from "./chat-attachment-policy.js";
import {
  type ChatAttachment,
  discardPreparedInboundMedia,
  MediaOffloadError,
  type OffloadedRef,
  parseMessageWithAttachments,
  persistInboundImagesForTranscript,
  stripImageMediaMarkers,
  UnsupportedAttachmentError,
} from "./chat-attachments.js";
import { sanitizeChatHistoryMessages } from "./chat-display-projection.sanitize.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./server-methods/attachment-normalize.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
// ISO-BMFF's generic brand identifies the container, not its audio/video tracks.
const GENERIC_MP4 = Buffer.from(
  "0000001c6674797069736f6d0000020069736f6d69736f326d70343100000008",
  "hex",
).toString("base64");

type ParsedAttachments = Awaited<ReturnType<typeof parseMessageWithAttachments>>;

function pngAttachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    type: "image",
    mimeType: "image/png",
    fileName: "dot.png",
    content: PNG_1x1,
    ...overrides,
  };
}

function pdfAttachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    type: "file",
    mimeType: "application/pdf",
    fileName: "report.pdf",
    content: Buffer.from("%PDF-1.4\n").toString("base64"),
    ...overrides,
  };
}

function pngBase64OfBytes(bytes: number): string {
  const pngHeader = PNG_1x1.slice(0, 64);
  let base64Length = Math.ceil((bytes * 4) / 3);
  base64Length += (4 - (base64Length % 4)) % 4;
  return `${pngHeader}${"A".repeat(base64Length - pngHeader.length)}`;
}

function parseRpc(
  message: string,
  attachments: Parameters<typeof normalizeRpcAttachmentsToChatAttachments>[0],
) {
  return parseMessageWithAttachments(
    message,
    normalizeRpcAttachmentsToChatAttachments(attachments),
  );
}

function savedMedia(id: string, contentType: string, size: number, path = `/media/inbound/${id}`) {
  saveMediaBufferMock.mockResolvedValueOnce({ id, path, size, contentType });
}

function inlineImage(overrides: Partial<ParsedAttachments["images"][number]> = {}) {
  return {
    type: "image" as const,
    data: PNG_1x1,
    mimeType: "image/png",
    sourceIndex: 0,
    ...overrides,
  };
}

function offloadedRef(overrides: Partial<OffloadedRef> = {}): OffloadedRef {
  return {
    mediaRef: "https://signed.example/private",
    id: "managed-id",
    path: "/external/user-owned.png",
    kind: "image",
    mimeType: "image/png",
    label: "user-owned.png",
    sizeBytes: 42,
    sourceIndex: 0,
    ...overrides,
  };
}

function persistParsed(
  parsed: Partial<Pick<ParsedAttachments, "images" | "offloadedRefs">>,
  overrides: Partial<Parameters<typeof persistInboundImagesForTranscript>[0]> = {},
) {
  return persistInboundImagesForTranscript({
    images: parsed.images ?? [],
    offloadedRefs: parsed.offloadedRefs ?? [],
    log: { warn: vi.fn() },
    logContext: "chat.send",
    ...overrides,
  });
}

async function persistedMessage(parsed: ParsedAttachments, text: string) {
  const persisted = await persistParsed(parsed);
  return buildPersistedUserTurnMessage({
    text,
    media: persisted.entries.map((entry) => entry.fact),
  });
}

async function expectUnsupportedAttachmentReason(
  attachments: ChatAttachment[],
  opts: Parameters<typeof parseMessageWithAttachments>[2],
  reason: UnsupportedAttachmentError["reason"],
) {
  const parsing = parseMessageWithAttachments("x", attachments, opts);
  await expect(parsing).rejects.toBeInstanceOf(UnsupportedAttachmentError);
  await expect(parsing).rejects.toMatchObject({ name: "UnsupportedAttachmentError", reason });
  expect(saveMediaBufferMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  saveMediaBufferMock.mockClear();
  deleteMediaBufferMock.mockClear();
  probeMediaFilesWithinBudgetMock.mockReset();
  probeMediaFilesWithinBudgetMock.mockImplementation(async (inputs: readonly unknown[]) =>
    inputs.map(() => ({})),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("deletes only the managed inbound id and reports cleanup failures", async () => {
  deleteMediaBufferMock.mockRejectedValueOnce(new Error("unlink denied"));
  const warn = vi.fn();
  const prepared = offloadedRef({ mediaRef: "media://inbound/managed-id" });

  await expect(discardPreparedInboundMedia([prepared], { warn })).resolves.toBeUndefined();

  expect(deleteMediaBufferMock).toHaveBeenCalledOnce();
  expect(deleteMediaBufferMock).toHaveBeenCalledWith("managed-id", "inbound");
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("failed to discard prepared inbound media managed-id: unlink denied"),
  );
});
it.each([
  { origin: "paste", expected: "paste" },
  { origin: "file", expected: "file" },
  { origin: "clipboard", expected: undefined },
])(
  "retains bounded origin $origin through transcript and history without changing content",
  async ({ origin, expected }) => {
    const bytes = Buffer.from("First line\nSecond line\n", "utf8");
    const fileName = "pasted-text-123.txt";
    savedMedia(
      "pasted-text-123---11111111-2222-3333-4444-555555555555.txt",
      "text/plain",
      bytes.length,
      "/tmp/openclaw-test-media/inbound/pasted-text-123.txt",
    );
    const parsed = await parseRpc("Read this", [
      { mimeType: "text/plain", fileName, origin, content: bytes.toString("base64") },
    ]);
    expect(saveMediaBufferMock).toHaveBeenCalledWith(
      bytes,
      "text/plain",
      "inbound",
      expect.any(Number),
      fileName,
      undefined,
      { assertCommitAllowed: undefined },
    );
    expect(parsed.message).toBe(
      `Read this\n[media attached: ${parsed.offloadedRefs[0]?.mediaRef}]`,
    );
    expect(parsed.images).toEqual([]);
    const message = await persistedMessage(parsed, "Read this");
    const canonical = canonicalizePersistedUserMessageMedia(message).message;
    const recovered = buildPersistedUserTurnMediaInputsFromFields(canonical);
    expect(recovered[0]).toMatchObject({
      fileName,
      contentType: "text/plain",
      sizeBytes: bytes.length,
    });
    const history = expectDefined(
      asOptionalRecord(sanitizeChatHistoryMessages([canonical])[0]),
      "projected history message",
    );
    for (const fact of [parsed.media[0], recovered[0], readPersistedMediaFacts(history)?.[0]]) {
      if (expected === undefined) {
        expect(fact).not.toHaveProperty("origin");
      } else {
        expect(fact).toHaveProperty("origin", expected);
      }
    }
    expect(canonical.content).toBe("Read this");
    expect(history).toMatchObject({ role: "user", content: "Read this" });
  },
);
describe("persistInboundImagesForTranscript", () => {
  it.each([
    { storage: "inline", suppliedDimensions: {} },
    { storage: "offloaded", suppliedDimensions: { width: 999, height: 777 } },
  ])(
    "retains byte-derived dimensions in $storage upload transcript facts",
    async ({ storage, suppliedDimensions }) => {
      const png = createSolidPngBuffer(32, 16, { r: 12, g: 34, b: 56 });
      const bytes = storage === "offloaded" ? Buffer.concat([png, Buffer.alloc(2_000_000)]) : png;
      const parsed = await parseRpc("Inspect this", [
        {
          fileName: "upload.png",
          mimeType: "image/png",
          content: bytes.toString("base64"),
          ...suppliedDimensions,
        },
      ]);
      expect(parsed.imageOrder).toEqual([storage]);
      expect(storage === "inline" ? parsed.images[0] : parsed.offloadedRefs[0]).toMatchObject({
        width: 32,
        height: 16,
      });
      const message = await persistedMessage(parsed, "Inspect this");
      expect(message).toMatchObject({
        __openclaw: {
          media: [{ kind: "image", fileName: "upload.png", width: 32, height: 16 }],
        },
      });
      expect(readPersistedMediaFacts(message)?.[0]).toMatchObject({ width: 32, height: 16 });
    },
  );

  it("persists displayed JPEG axes after EXIF rotation rather than caller dimensions", async () => {
    const jpeg = await resizeToJpeg({
      buffer: createSolidPngBuffer(32, 16, { r: 12, g: 34, b: 56 }),
      maxSide: 32,
      quality: 92,
      withoutEnlargement: true,
    });
    const orientation = Buffer.from(
      "ffe1002245786966000049492a0008000000010012010300010000000600000000000000",
      "hex",
    );
    const bytes = Buffer.concat([jpeg.subarray(0, 2), orientation, jpeg.subarray(2)]);
    const parsed = await parseMessageWithAttachments("Portrait", [
      {
        fileName: "portrait.jpg",
        mimeType: "image/jpeg",
        content: bytes.toString("base64"),
        width: 32,
        height: 16,
      },
    ]);
    const persisted = await persistParsed(parsed);
    expect(parsed.images[0]).toMatchObject({ width: 16, height: 32 });
    expect(persisted.entries[0]?.fact).toMatchObject({ width: 16, height: 32 });
    expect(saveMediaBufferMock.mock.calls[0]?.[0]).toEqual(bytes);
  });

  it("leaves unreadable image dimensions unknown instead of persisting caller guesses", async () => {
    const parsed = await parseMessageWithAttachments(
      "Inspect",
      [
        pngAttachment({
          content: Buffer.from("89504e470d0a1a0a0000000000000000", "hex").toString("base64"),
          width: 999,
          height: 777,
        }),
      ],
      { supportsImages: false },
    );
    const persisted = await persistParsed(parsed);
    expect(parsed.offloadedRefs[0]).toMatchObject({ mimeType: "image/png" });
    for (const fact of [parsed.offloadedRefs[0], persisted.entries[0]?.fact]) {
      expect(fact?.width).toBeUndefined();
      expect(fact?.height).toBeUndefined();
    }
  });

  it("does not turn a rejected upload commit into a best-effort omission after policy re-enables", async () => {
    const denied = new SessionMutationAuthorizationChangedError({
      code: "FORBIDDEN",
      message: "File and image uploads are disabled",
      details: { code: "UPLOADS_DISABLED" },
    });
    saveMediaBufferMock.mockRejectedValueOnce(denied);
    const warn = vi.fn();
    await expect(
      persistParsed(
        { images: [inlineImage()] },
        {
          log: { warn },
          assertCurrent: () => {},
        },
      ),
    ).rejects.toBe(denied);
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves original mixed-media order in claim-only transcript facts", async () => {
    const fileName = "bands café 雪 🦞.png";
    savedMedia("video", "video/mp4", 100, "/media/inbound/video.mp4");
    const parsed = await parseMessageWithAttachments("Compare these", [
      { fileName: "video.mp4", mimeType: "video/mp4", content: GENERIC_MP4, durationMs: 2_000 },
      pngAttachment({ fileName }),
    ]);
    savedMedia("inline", "image/png", 5, "/media/inbound/inline.png");

    const result = await persistParsed(parsed, {
      offloadedRefs: [
        { ...parsed.offloadedRefs[0]!, mediaRef: "https://signed.example/private-video" },
      ],
    });

    expect(result.entries.map((entry) => entry.sourceIndex)).toEqual([0, 1]);
    expect(result.entries.map((entry) => entry.fact)).toEqual([
      {
        url: "media://inbound/video",
        contentType: "video/mp4",
        kind: "video",
        fileName: "video.mp4",
        sizeBytes: Buffer.from(GENERIC_MP4, "base64").length,
        durationMs: 2_000,
        hydrationSuppressed: true,
      },
      {
        url: "media://inbound/inline",
        contentType: "image/png",
        kind: "image",
        fileName,
        sizeBytes: 5,
        width: 1,
        height: 1,
      },
    ]);
    expect(saveMediaBufferMock).toHaveBeenLastCalledWith(
      Buffer.from(PNG_1x1, "base64"),
      "image/png",
      "inbound",
      undefined,
      fileName,
      undefined,
      { assertCommitAllowed: undefined },
    );
    const persisted = buildPersistedUserTurnMessage({
      text: parsed.message,
      media: result.entries.map((entry) => entry.fact),
    });
    expect(readPersistedMediaFacts(persisted)?.map((fact) => fact.fileName)).toEqual([
      "video.mp4",
      fileName,
    ]);
    expect(result.omission).toBe("none");
    const durable = JSON.stringify(result.entries.map((entry) => entry.fact));
    for (const forbidden of ["/media/", "signed.example", "sourceIndex"]) {
      expect(durable).not.toContain(forbidden);
    }
  });

  it("reports an inline image whose durable managed save fails", async () => {
    saveMediaBufferMock.mockRejectedValueOnce(new Error("disk unavailable"));
    const warn = vi.fn();

    const result = await persistParsed(
      {
        images: [inlineImage({ data: "aGVsbG8=", mimeType: "image/jpeg" })],
      },
      { log: { warn } },
    );

    expect(result).toEqual({ entries: [], omission: "inline-image-save-failed" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk unavailable"));
  });
});

describe("parseMessageWithAttachments", () => {
  it("parses large clipboard data URL images without full base64 decoding on the caller thread", async () => {
    const png = Buffer.concat([Buffer.from(PNG_1x1, "base64"), Buffer.alloc(1_900_000)]);
    const base64 = png.toString("base64");
    const fromSpy = vi.spyOn(Buffer, "from");
    const parsed = await parseMessageWithAttachments("see screenshot", [
      pngAttachment({ content: `data:image/png;base64,${base64}`, fileName: "screenshot.png" }),
    ]);
    expect(parsed.images).toMatchObject([{ mimeType: "image/png", data: base64 }]);
    expect(
      fromSpy.mock.calls.some((call) => {
        const [value, encoding] = call as unknown[];
        return value === base64 && encoding === "base64";
      }),
    ).toBe(false);
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("keeps mixed image/PDF markers in normal and image-stripped routing order", async () => {
    // Non-image offloads must not shift hydration's image order.
    const bigPng = Buffer.alloc(2_100_000);
    bigPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const parsed = await parseMessageWithAttachments("x", [
      pdfAttachment(),
      pngAttachment(),
      pngAttachment({ fileName: "big.png", content: bigPng.toString("base64") }),
    ]);
    expect(parsed).toMatchObject({
      images: [{ sourceIndex: 1 }],
      imageOrder: ["inline", "offloaded"],
      offloadedRefs: [
        { mimeType: "application/pdf", sourceIndex: 0 },
        { mimeType: "image/png", sourceIndex: 2 },
      ],
    });
    const pdfRef = expectDefined(parsed.offloadedRefs[0], "offloaded PDF ref");
    const imageRef = expectDefined(parsed.offloadedRefs[1], "offloaded image ref");
    expect(parsed.message).toBe(
      `x\n[media attached: ${pdfRef.mediaRef}]\n[media attached: ${imageRef.mediaRef}]`,
    );
    expect(stripImageMediaMarkers(parsed.message, parsed.offloadedRefs)).toBe(
      `x\n[media attached: ${pdfRef.mediaRef}]`,
    );
    const trailingMediaLines = parsed.message
      .split("\n")
      .filter((line) => line.trim().startsWith("[media attached: media://inbound/"));
    expect(trailingMediaLines).toHaveLength(2);
  });
});

describe("parseMessageWithAttachments validation errors", () => {
  it.each([
    { name: "an empty string", attachment: { content: "" } },
    { name: "an empty typed array", attachment: { content: new Uint8Array(0) } },
    { name: "an empty array buffer", attachment: { content: new ArrayBuffer(0) } },
    {
      name: "an empty nested base64 source",
      attachment: { source: { type: "base64", media_type: "application/pdf", data: "" } },
    },
  ])("rejects normalized RPC attachments with $name", async ({ attachment }) => {
    const normalized = normalizeRpcAttachmentsToChatAttachments([
      {
        type: "file",
        mimeType: "application/pdf",
        fileName: "empty.pdf",
        ...attachment,
      },
    ]);

    await expectUnsupportedAttachmentReason(normalized, {}, "empty-payload");
  });

  it("continues to omit RPC attachments without recognized content", () => {
    expect(
      normalizeRpcAttachmentsToChatAttachments([
        { content: undefined },
        { content: null },
        { mimeType: "image/png" },
        { source: { type: "base64", media_type: "application/pdf", data: null } },
      ]),
    ).toEqual([]);
  });

  it.each([
    {
      reason: "unsupported-non-image" as const,
      opts: { acceptNonImage: false },
      attachment: pngAttachment({
        fileName: "fake.png",
        content: Buffer.from("PK\u0003\u0004zip-archive-bytes").toString("base64"),
      }),
    },
    {
      reason: "text-only-image" as const,
      opts: { supportsInlineImages: false },
      attachment: pngAttachment(),
    },
  ])("rejects $reason attachments before saving", async ({ reason, opts, attachment }) => {
    await expectUnsupportedAttachmentReason([attachment], opts, reason);
  });

  it("adds best-effort metadata to offloaded audio facts", async () => {
    probeMediaFilesWithinBudgetMock.mockResolvedValueOnce([{ durationMs: 2345 }]);
    const parsed = await parseMessageWithAttachments(
      "listen",
      [
        {
          type: "audio",
          mimeType: "audio/mpeg",
          fileName: "song.mp3",
          content: Buffer.from("audio-fixture").toString("base64"),
        },
      ],
      { supportsInlineImages: false },
    );

    expect(probeMediaFilesWithinBudgetMock).toHaveBeenCalledWith(
      [{ filePath: parsed.offloadedRefs[0]?.path, kind: "audio" }],
      { budgetMs: 3000, concurrency: 2, maxProbes: 8 },
    );
    expect(parsed).toMatchObject({
      offloadedRefs: [{ durationMs: 2345 }],
      media: [{ durationMs: 2345 }],
    });
  });

  it("passes through unchanged on text-only session with no attachments", async () => {
    const parsed = await parseMessageWithAttachments("hello", [], { supportsInlineImages: false });
    expect(parsed).toMatchObject({ message: "hello", images: [], offloadedRefs: [] });
    expect(stripImageMediaMarkers(parsed.message, parsed.offloadedRefs)).toBe("hello");
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: "audio",
      mimeType: "audio/mpeg",
      expectedMimeType: "audio/mpeg",
      fileName: "voice.mp3",
      content: Buffer.from([0xff, 0xfb, 0x90, 0x00]).toString("base64"),
    },
    {
      kind: "video",
      mimeType: "audio/aac",
      expectedMimeType: "video/mp4",
      fileName: "clip.mp4",
      content: GENERIC_MP4,
    },
  ])(
    "surfaces structured inbound $kind facts %#",
    async ({ kind, mimeType, expectedMimeType, fileName, content }) => {
      const parsed = await parseMessageWithAttachments("play this", [
        { type: kind, mimeType, fileName, content, durationMs: 1_500 },
      ]);

      expect(parsed.offloadedRefs).toEqual([
        expect.objectContaining({
          kind,
          mimeType: expectedMimeType,
          label: fileName,
          durationMs: 1_500,
          mediaRef: expect.stringMatching(/^media:\/\/inbound\//u),
        }),
      ]);
      expect(parsed.media[0]).toMatchObject({ kind, contentType: expectedMimeType });
    },
  );

  it("caps text-only image offloads", async () => {
    const logs: string[] = [];
    const infos: string[] = [];
    const attachments = Array.from({ length: 11 }, (_, index) =>
      pngAttachment({ fileName: `dot-${index}.png` }),
    );
    const parsed = await parseMessageWithAttachments("see these", attachments, {
      supportsImages: false,
      log: { warn: (warning) => logs.push(warning), info: (info) => infos.push(info) },
    });
    expect(parsed.images).toHaveLength(0);
    expect(parsed.offloadedRefs).toHaveLength(10);
    expect(parsed.imageOrder).toHaveLength(10);
    expect(parsed.message.match(/\[media attached: media:\/\/inbound\//g)).toHaveLength(10);
    expect(parsed.message).toContain(
      "[image attachment omitted: text-only attachment limit reached]",
    );
    expect(stripImageMediaMarkers(parsed.message, parsed.offloadedRefs)).toBe(
      "see these\n[image attachment omitted: text-only attachment limit reached]",
    );
    expect(logs).toEqual([
      "attachment dot-10.png: dropping image because text-only offload limit 10 was reached",
    ]);
    expect(infos[0]).toMatch(/Offloaded image for text-only model/i);
  });
});

it("rejects images above the advertised maxImageBytes when the hydration cap is the smaller limit", async () => {
  const policy = resolveChatAttachmentPolicy({ agents: { defaults: { mediaMaxMb: 20 } } });
  const parse = parseMessageWithAttachments(
    "x",
    [pngAttachment({ fileName: "big.png", content: pngBase64OfBytes(MAX_IMAGE_BYTES + 3) })],
    { maxBytes: policy.maxBytes },
  );
  expect(policy.maxImageBytes).toBe(MAX_IMAGE_BYTES);
  await expect(parse).rejects.toThrow(/image exceeds size limit/i);
  expect(saveMediaBufferMock).not.toHaveBeenCalled();
});
describe("attachment validation", () => {
  it("reports compute saturation as retryable without writing media", async () => {
    const capacity = getWorkerComputeCapacity();
    expect(capacity.admit(DEFAULT_WORKER_PENDING_BYTES)).toBe(true);
    try {
      await expect(
        parseMessageWithAttachments("x", [
          pdfAttachment({
            content: Buffer.alloc(256 * 1024).toString("base64"),
          }),
        ]),
      ).rejects.toBeInstanceOf(MediaOffloadError);
      expect(saveMediaBufferMock).not.toHaveBeenCalled();
    } finally {
      capacity.finish(DEFAULT_WORKER_PENDING_BYTES);
    }
  });

  it("cancels queued attachment computation before writing media", async () => {
    const controller = new AbortController();
    const reason = new Error("upload cancelled");
    const parsing = parseMessageWithAttachments(
      "read this",
      [pdfAttachment({ content: Buffer.alloc(256 * 1024).toString("base64") })],
      { signal: controller.signal },
    );
    controller.abort(reason);
    await expect(parsing).rejects.toBe(reason);
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("cleans earlier offloads when cancelled capability resolution returns false", async () => {
    const controller = new AbortController();
    const reason = new Error("upload cancelled");
    await expect(
      parseMessageWithAttachments("read these", [pdfAttachment(), pngAttachment()], {
        signal: controller.signal,
        supportsImages: async () => {
          controller.abort(reason);
          return false;
        },
      }),
    ).rejects.toBe(reason);
    expect(saveMediaBufferMock).toHaveBeenCalledOnce();
    const saved = await saveMediaBufferMock.mock.results[0]?.value;
    expect(deleteMediaBufferMock).toHaveBeenCalledWith(saved?.id, "inbound");
  });

  it("rejects attachment dialect violations", async () => {
    await expect(
      parseMessageWithAttachments("x", [pdfAttachment({ content: "%not-base64%" })]),
    ).rejects.toThrow(/invalid base64/);
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("rejects images over limit without decoding base64", async () => {
    const big = "A".repeat(10_000);
    const att = pngAttachment({ fileName: "big.png", content: big });

    const fromSpy = vi.spyOn(Buffer, "from");
    await expect(parseMessageWithAttachments("x", [att], { maxBytes: 16 })).rejects.toThrow(
      /exceeds size limit/i,
    );
    const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
    expect(base64Calls).toHaveLength(0);
  });
});
