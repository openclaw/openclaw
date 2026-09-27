// Chat attachment tests cover inbound image/file parsing, media-store cleanup,
// warning surfaces, size limits, and outbound message block assembly.

import assert from "node:assert/strict";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  getWorkerComputeCapacity,
} from "../infra/worker-task-capacity.js";
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
import { sanitizeChatHistoryMessages } from "./chat-display-projection.js";
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

async function parseWithWarnings(
  message: string,
  attachments: ChatAttachment[],
  opts: Parameters<typeof parseMessageWithAttachments>[2] = {},
) {
  const logs: string[] = [];
  const parsed = await parseMessageWithAttachments(message, attachments, {
    log: { warn: (warning) => logs.push(warning) },
    ...opts,
  });
  return { parsed, logs };
}

async function parseTextOnlyAttachments(
  message: string,
  attachments: ChatAttachment[],
  logs: string[],
  infos?: string[],
) {
  const log: NonNullable<Parameters<typeof parseMessageWithAttachments>[2]>["log"] = {
    warn: (warning) => logs.push(warning),
  };
  if (infos) {
    log.info = (info) => infos.push(info);
  }
  return parseMessageWithAttachments(message, attachments, { log, supportsImages: false });
}

async function cleanupOffloadedRefs(refs: { id: string }[]) {
  await Promise.allSettled(refs.map((ref) => deleteMediaBufferMock(ref.id, "inbound")));
}

function savedMime() {
  return saveMediaBufferMock.mock.calls[0]?.[1];
}

function expectSingleInlinePng(parsed: ParsedAttachments) {
  expect(parsed.images).toHaveLength(1);
  expect(parsed.images[0]?.mimeType).toBe("image/png");
}

async function expectUnsupportedAttachmentReason(
  attachments: ChatAttachment[],
  opts: Parameters<typeof parseMessageWithAttachments>[2],
  reason: UnsupportedAttachmentError["reason"],
) {
  let caught: unknown;
  try {
    await parseMessageWithAttachments("x", attachments, {
      log: { warn: () => {} },
      ...opts,
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UnsupportedAttachmentError);
  expect((caught as UnsupportedAttachmentError).name).toBe("UnsupportedAttachmentError");
  expect((caught as UnsupportedAttachmentError).reason).toBe(reason);
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

describe("discardPreparedInboundMedia", () => {
  it("deletes only the managed inbound id and reports cleanup failures", async () => {
    const error = new Error("unlink denied");
    deleteMediaBufferMock.mockRejectedValueOnce(error);
    const warn = vi.fn();
    const prepared: OffloadedRef = {
      mediaRef: "media://inbound/managed-id",
      id: "managed-id",
      path: "/external/user-owned.png",
      kind: "image",
      mimeType: "image/png",
      label: "user-owned.png",
      sizeBytes: 42,
      sourceIndex: 0,
    };

    await expect(discardPreparedInboundMedia([prepared], { warn })).resolves.toBeUndefined();

    expect(deleteMediaBufferMock).toHaveBeenCalledOnce();
    expect(deleteMediaBufferMock).toHaveBeenCalledWith("managed-id", "inbound");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to discard prepared inbound media managed-id: unlink denied"),
    );
  });
});

describe("composer attachment origin", () => {
  it.each([
    { origin: "paste", expected: "paste" },
    { origin: "file", expected: "file" },
    { origin: undefined, expected: undefined },
    { origin: "clipboard", expected: undefined },
    { origin: 42, expected: undefined },
  ])(
    "retains bounded origin $origin through transcript and history without changing content",
    async ({ origin, expected }) => {
      const bytes = Buffer.from("First line\nSecond line\n", "utf8");
      const fileName = "pasted-text-123.txt";
      saveMediaBufferMock.mockResolvedValueOnce({
        id: "pasted-text-123---11111111-2222-3333-4444-555555555555.txt",
        path: "/tmp/openclaw-test-media/inbound/pasted-text-123.txt",
        size: bytes.length,
        contentType: "text/plain",
      });
      const parsed = await parseMessageWithAttachments(
        "Read this",
        normalizeRpcAttachmentsToChatAttachments([
          { mimeType: "text/plain", fileName, origin, content: bytes.toString("base64") },
        ]),
      );
      expect(saveMediaBufferMock).toHaveBeenCalledWith(
        bytes,
        "text/plain",
        "inbound",
        expect.any(Number),
        fileName,
      );
      expect(parsed.message).toBe(
        `Read this\n[media attached: ${parsed.offloadedRefs[0]?.mediaRef}]`,
      );
      expect(parsed.images).toEqual([]);
      const persisted = await persistInboundImagesForTranscript({
        images: parsed.images,
        offloadedRefs: parsed.offloadedRefs,
        log: { warn: vi.fn() },
        logContext: "chat.send",
      });
      const message = buildPersistedUserTurnMessage({
        text: "Read this",
        timestamp: 123,
        media: persisted.entries.map((entry) => entry.fact),
      });
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
});

describe("persistInboundImagesForTranscript", () => {
  it("preserves original mixed-media order in claim-only transcript facts", async () => {
    const fileName = "bands café 雪 🦞.png";
    saveMediaBufferMock.mockResolvedValueOnce({
      id: "video",
      path: "/media/inbound/video.mp4",
      size: 100,
      contentType: "video/mp4",
    });
    const parsed = await parseMessageWithAttachments("Compare these", [
      { fileName: "video.mp4", mimeType: "video/mp4", content: GENERIC_MP4, durationMs: 2_000 },
      pngAttachment({ fileName }),
    ]);
    saveMediaBufferMock.mockResolvedValueOnce({
      id: "inline",
      path: "/media/inbound/inline.png",
      size: 5,
      contentType: "image/png",
    });

    const result = await persistInboundImagesForTranscript({
      images: parsed.images,
      offloadedRefs: [
        { ...parsed.offloadedRefs[0]!, mediaRef: "https://signed.example/private-video" },
      ],
      log: { warn: vi.fn() },
      logContext: "test",
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
      },
    ]);
    expect(saveMediaBufferMock).toHaveBeenLastCalledWith(
      Buffer.from(PNG_1x1, "base64"),
      "image/png",
      "inbound",
      undefined,
      fileName,
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
    expect(durable).not.toContain("/media/");
    expect(durable).not.toContain("signed.example");
    expect(durable).not.toContain("sourceIndex");
  });

  it("reports an inline image whose durable managed save fails", async () => {
    saveMediaBufferMock.mockRejectedValueOnce(new Error("disk unavailable"));
    const warn = vi.fn();

    const result = await persistInboundImagesForTranscript({
      images: [
        {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/jpeg",
          sourceIndex: 0,
        },
      ],
      offloadedRefs: [],
      log: { warn },
      logContext: "test",
    });

    expect(result).toEqual({ entries: [], omission: "inline-image-save-failed" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk unavailable"));
  });

  it.each(["nested/id", String.raw`nested\id`, "bad\0id", ".", "..", "claim?sig", "claim#part"])(
    "rejects an unsafe saved media id %j before projecting a durable claim",
    async (id) => {
      await expect(
        persistInboundImagesForTranscript({
          images: [],
          offloadedRefs: [
            {
              mediaRef: "https://signed.example/private",
              id,
              path: "/media/inbound/private",
              kind: "video",
              mimeType: "video/mp4",
              label: "private.mp4",
              sizeBytes: 10,
              sourceIndex: 0,
            },
          ],
          log: { warn: vi.fn() },
          logContext: "test",
        }),
      ).rejects.toThrow();
    },
  );
});

describe("parseMessageWithAttachments", () => {
  it("offloads a multi-megabyte PDF data URL with the exact decoded bytes", async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024);
    bytes.write("%PDF-1.4\n");
    const { parsed } = await parseWithWarnings("read this", [
      pdfAttachment({ content: `data:application/pdf;base64,${bytes.toString("base64")}` }),
    ]);
    expect(parsed.offloadedRefs).toHaveLength(1);
    // Node compares Buffer bytes without Vitest's per-byte object traversal.
    assert.deepStrictEqual(saveMediaBufferMock.mock.calls[0]?.[0], bytes);
  });

  it("parses large clipboard data URL images without full base64 decoding", async () => {
    const png = Buffer.concat([Buffer.from(PNG_1x1, "base64"), Buffer.alloc(1_900_000)]);
    const base64 = png.toString("base64");
    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      const parsed = await parseMessageWithAttachments(
        "see screenshot",
        [pngAttachment({ content: `data:image/png;base64,${base64}`, fileName: "screenshot.png" })],
        { log: { warn: () => {} } },
      );

      expectSingleInlinePng(parsed);
      expect(parsed.images[0]?.data).toBe(base64);
      expect(
        fromSpy.mock.calls.some((call) => {
          const [value, encoding] = call as unknown[];
          return value === base64 && encoding === "base64";
        }),
      ).toBe(false);
      expect(saveMediaBufferMock).not.toHaveBeenCalled();
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("sniffs mime when missing", async () => {
    const { parsed, logs } = await parseWithWarnings("see this", [
      pngAttachment({ mimeType: undefined }),
    ]);
    expect(parsed.message).toBe("see this");
    expectSingleInlinePng(parsed);
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(logs).toHaveLength(0);
  });

  it("accepts non-image payloads and offloads them via the media store", async () => {
    const { parsed, logs } = await parseWithWarnings("read this", [pdfAttachment()]);
    expect(parsed.images).toHaveLength(0);
    expect(parsed.imageOrder).toStrictEqual([]);
    expect(parsed.offloadedRefs).toHaveLength(1);
    const ref = expectDefined(parsed.offloadedRefs[0], "parsed.offloadedRefs[0] test invariant");
    expect(ref.mimeType).toBe("application/pdf");
    expect(ref.label).toBe("report.pdf");
    expect(ref.mediaRef).toMatch(/^media:\/\/inbound\//);
    expect(parsed.message).toBe(`read this\n[media attached: ${ref.mediaRef}]`);
    expect(stripImageMediaMarkers(parsed.message, parsed.offloadedRefs)).toBe(parsed.message);
    expect(saveMediaBufferMock).toHaveBeenCalledOnce();
    expect(savedMime()).toBe("application/pdf");
    expect(logs).toHaveLength(0);
  });

  it("offloads opaque binary when sniff and provided mime are both absent", async () => {
    const unknown = Buffer.from("just some bytes that do not match any signature").toString(
      "base64",
    );
    const { parsed, logs } = await parseWithWarnings("take a look", [
      { type: "file", fileName: "blob.dat", content: unknown },
    ]);
    expect(parsed.offloadedRefs).toHaveLength(1);
    expect(parsed.offloadedRefs[0]?.mimeType).toBe("application/octet-stream");
    expect(savedMime()).toBe("application/octet-stream");
    expect(parsed.message).toBe(
      `take a look\n[media attached: ${parsed.offloadedRefs[0]?.mediaRef}]`,
    );
    expect(stripImageMediaMarkers(parsed.message, parsed.offloadedRefs)).toBe(parsed.message);
    expect(logs).toHaveLength(0);
  });

  it("prefers sniffed mime type and logs mismatch", async () => {
    const { parsed, logs } = await parseWithWarnings("x", [
      pngAttachment({ mimeType: "image/jpeg" }),
    ]);
    expectSingleInlinePng(parsed);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/mime mismatch/i);
  });

  it("keeps mixed image/PDF markers in normal and image-stripped routing order", async () => {
    // Regression: a prior revision pushed "offloaded" for every offload,
    // including non-image files. In a [non-image, inline, offloaded-image]
    // batch that produced imageOrder=["offloaded","inline","offloaded"] even
    // though only one image offload existed. Structural facts and imageOrder
    // must agree so hydration cannot swap it ahead of the inline image.
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const bigPng = Buffer.alloc(2_100_000);
    bigPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const { parsed } = await parseWithWarnings("x", [
      pdfAttachment({ content: pdf }),
      pngAttachment(),
      pngAttachment({ fileName: "big.png", content: bigPng.toString("base64") }),
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.offloadedRefs.map((ref) => ref.mimeType)).toEqual([
      "application/pdf",
      "image/png",
    ]);
    expect(parsed.imageOrder).toEqual(["inline", "offloaded"]);
    expect(parsed.images[0]?.sourceIndex).toBe(1);
    expect(parsed.offloadedRefs.map((ref) => ref.sourceIndex)).toEqual([0, 2]);
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

  it("preserves specific OOXML mime when sniff returns generic zip (docx)", async () => {
    const docx = Buffer.from("PK\u0003\u0004fake-docx-content").toString("base64");
    const { parsed } = await parseWithWarnings("x", [
      {
        type: "file",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: "spec.docx",
        content: docx,
      },
    ]);
    expect(parsed.offloadedRefs).toHaveLength(1);
    expect(parsed.offloadedRefs[0]?.label).toBe("spec.docx");
    // Docx sniffs as application/zip; the provided OOXML mime must win so the
    // agent sees the real document type, not a generic archive.
    expect(parsed.offloadedRefs[0]?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("recovers specific mime from filename extension when sniff is generic and provided mime is absent", async () => {
    const xlsx = Buffer.from("PK\u0003\u0004fake-xlsx").toString("base64");
    const { parsed } = await parseWithWarnings("x", [
      { type: "file", fileName: "sheet.xlsx", content: xlsx },
    ]);
    expect(parsed.offloadedRefs).toHaveLength(1);
    expect(parsed.offloadedRefs[0]?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it.each(["application/zip", "application/pdf"])(
    "keeps ZIP bytes as an archive with %s metadata",
    async (mimeType) => {
      const zip = Buffer.from("PK\u0003\u0004zip-archive-bytes").toString("base64");
      const { parsed } = await parseWithWarnings("x", [
        {
          type: "file",
          mimeType,
          fileName: "bundle.zip",
          content: zip,
        },
      ]);
      expect(parsed.offloadedRefs).toHaveLength(1);
      expect(parsed.offloadedRefs[0]?.label).toBe("bundle.zip");
      expect(parsed.offloadedRefs[0]?.mimeType).toBe("application/zip");
    },
  );

  it("does not let image filenames override generic non-image byte sniffing", async () => {
    const zip = Buffer.from("PK\u0003\u0004zip-archive-bytes").toString("base64");
    const { parsed, logs } = await parseWithWarnings("x", [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "fake.png",
        content: zip,
      },
    ]);
    expect(parsed.images).toHaveLength(0);
    expect(parsed.offloadedRefs).toHaveLength(1);
    expect(parsed.offloadedRefs[0]?.mimeType).toBe("application/zip");
    expect(savedMime()).toBe("application/zip");
    expect(logs[0]).toMatch(/mime mismatch/i);
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
    { name: "whitespace-only content", attachment: { content: "   " } },
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

  it("throws UnsupportedAttachmentError on non-image when acceptNonImage is false", async () => {
    await expectUnsupportedAttachmentReason(
      [pdfAttachment({ fileName: "a.pdf" })],
      { acceptNonImage: false },
      "unsupported-non-image",
    );
  });

  it("rejects declared text with an image filename on image-only entrypoints", async () => {
    await expectUnsupportedAttachmentReason(
      [
        {
          type: "file",
          mimeType: "text/plain",
          fileName: "note.png",
          content: Buffer.from("ordinary text attachment").toString("base64"),
        },
      ],
      { acceptNonImage: false },
      "unsupported-non-image",
    );
  });

  it.each([
    { mimeType: "text/plain; charset=utf-8", fileName: "note.png", expected: "text/plain" },
    { mimeType: "audio/webm", fileName: "voice.webm", expected: "audio/webm" },
    { mimeType: "audio/mp4", fileName: "voice.mp4", expected: "audio/mp4" },
    {
      mimeType: "application/octet-stream",
      fileName: "bundle.zip",
      expected: "application/octet-stream",
    },
    { mimeType: "application/octet-stream", fileName: "note.txt", expected: "text/plain" },
    { mimeType: undefined, fileName: "bundle.zip", expected: "application/zip" },
  ])(
    "preserves metadata precedence for inconclusive bytes: $mimeType/$fileName",
    async ({ mimeType, fileName, expected }) => {
      const { parsed } = await parseWithWarnings("read this", [
        {
          type: "file",
          mimeType,
          fileName,
          content: Buffer.from("ordinary text attachment").toString("base64"),
        },
      ]);
      expect(parsed.images).toEqual([]);
      expect(parsed.offloadedRefs).toEqual([
        expect.objectContaining({ mimeType: expected, label: fileName }),
      ]);
    },
  );

  it("rejects generic-container payloads mislabeled as images when acceptNonImage is false", async () => {
    const docx = Buffer.from("PK\u0003\u0004fake-docx-content").toString("base64");
    await expectUnsupportedAttachmentReason(
      [pdfAttachment({ mimeType: "image/png", fileName: "report.docx", content: docx })],
      { acceptNonImage: false },
      "unsupported-non-image",
    );
  });

  it("rejects generic-container payloads with image mime and image filename when acceptNonImage is false", async () => {
    const zip = Buffer.from("PK\u0003\u0004zip-archive-bytes").toString("base64");
    await expectUnsupportedAttachmentReason(
      [pngAttachment({ fileName: "fake.png", content: zip })],
      { acceptNonImage: false },
      "unsupported-non-image",
    );
  });

  it("throws UnsupportedAttachmentError on image when supportsInlineImages is false", async () => {
    await expectUnsupportedAttachmentReason(
      [pngAttachment()],
      { supportsInlineImages: false },
      "text-only-image",
    );
  });

  it("still offloads non-image attachments when supportsInlineImages is false", async () => {
    const { parsed } = await parseWithWarnings("x", [pdfAttachment({ fileName: "a.pdf" })], {
      supportsInlineImages: false,
    });
    expect(parsed.offloadedRefs).toHaveLength(1);
    expect(parsed.offloadedRefs[0]?.mimeType).toBe("application/pdf");
    expect(saveMediaBufferMock).toHaveBeenCalledOnce();
  });

  it("adds best-effort metadata to offloaded audio facts", async () => {
    probeMediaFilesWithinBudgetMock.mockResolvedValueOnce([{ durationMs: 2345 }]);
    const { parsed } = await parseWithWarnings(
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
    expect(parsed.offloadedRefs[0]).toMatchObject({ durationMs: 2345 });
    expect(parsed.media[0]).toMatchObject({ durationMs: 2345 });
  });

  it("passes through unchanged on text-only session with no attachments", async () => {
    const { parsed } = await parseWithWarnings("hello", [], { supportsInlineImages: false });
    expect(parsed.message).toBe("hello");
    expect(stripImageMediaMarkers(parsed.message, parsed.offloadedRefs)).toBe("hello");
    expect(parsed.images).toHaveLength(0);
    expect(parsed.offloadedRefs).toHaveLength(0);
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
      mimeType: "video/mp4",
      expectedMimeType: "video/mp4",
      fileName: "clip.mp4",
      content: GENERIC_MP4,
    },
    ...["audio/mp4", undefined].map((mimeType) => ({
      kind: "audio",
      mimeType,
      expectedMimeType: mimeType ?? "audio/x-m4a",
      fileName: "voice.m4a",
      content: GENERIC_MP4,
    })),
    {
      kind: "audio",
      mimeType: undefined,
      expectedMimeType: "audio/x-m4a",
      fileName: "voice.m4a",
      content: Buffer.from(
        "0000001c667479704d344120000002004d34412069736f6d69736f3200000008",
        "hex",
      ).toString("base64"),
    },
    {
      kind: "audio",
      mimeType: "audio/webm",
      expectedMimeType: "audio/webm",
      fileName: "voice.webm",
      content: Buffer.from("1a45dfa3874282847765626d", "hex").toString("base64"),
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
      const parsed = await parseMessageWithAttachments(
        "play this",
        [{ type: kind, mimeType, fileName, content, durationMs: 1_500 }],
        { log: { warn: () => {} } },
      );

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

  it("keeps image sniff fallback for generic image attachments", async () => {
    const { parsed, logs } = await parseWithWarnings("see this", [
      pngAttachment({ type: "file", mimeType: "application/octet-stream", fileName: "dot" }),
    ]);
    expectSingleInlinePng(parsed);
    expect(parsed.offloadedRefs).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it("offloads images for text-only models instead of dropping them", async () => {
    const logs: string[] = [];
    const infos: string[] = [];
    const parsed = await parseTextOnlyAttachments("see this", [pngAttachment()], logs, infos);

    try {
      expect(parsed.images).toHaveLength(0);
      expect(parsed.imageOrder).toEqual(["offloaded"]);
      expect(parsed.offloadedRefs).toHaveLength(1);
      const offloaded = expectDefined(parsed.offloadedRefs[0], "offloaded image ref");
      expect(offloaded.mimeType).toBe("image/png");
      expect(parsed.message).toBe(`see this\n[media attached: ${offloaded.mediaRef}]`);
      expect(stripImageMediaMarkers(parsed.message, parsed.offloadedRefs)).toBe("see this");
      expect(parsed.media).toEqual([
        {
          path: offloaded.path,
          url: offloaded.mediaRef,
          contentType: "image/png",
          kind: "image",
          fileName: "dot.png",
          sizeBytes: 68,
        },
      ]);
      expect(infos[0]).toMatch(/Offloaded image for text-only model/i);
      expect(logs).toHaveLength(0);
    } finally {
      await cleanupOffloadedRefs(parsed.offloadedRefs);
    }
  });

  it("caps text-only image offloads", async () => {
    const logs: string[] = [];
    const attachments = Array.from({ length: 11 }, (_, index): ChatAttachment => ({
      type: "image",
      mimeType: "image/png",
      fileName: `dot-${index}.png`,
      content: PNG_1x1,
    }));
    const parsed = await parseTextOnlyAttachments("see these", attachments, logs);

    try {
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
    } finally {
      await cleanupOffloadedRefs(parsed.offloadedRefs);
    }
  });
});

describe("advertised attachment policy matches enforcement", () => {
  const MB = 1024 * 1024;

  const cfgWithMediaMaxMb = (value: number): OpenClawConfig =>
    ({ agents: { defaults: { mediaMaxMb: value } } }) as unknown as OpenClawConfig;

  async function parseImageWithPolicy(cfg: OpenClawConfig, imageBytes: number) {
    const policy = resolveChatAttachmentPolicy(cfg);
    const parse = parseMessageWithAttachments(
      "x",
      [pngAttachment({ fileName: "big.png", content: pngBase64OfBytes(imageBytes) })],
      { maxBytes: policy.maxBytes, log: { warn: () => {} } },
    );
    return { policy, parse };
  }

  it("rejects images above the advertised maxImageBytes when the config ceiling is the smaller limit", async () => {
    const { policy, parse } = await parseImageWithPolicy(cfgWithMediaMaxMb(1), 3 * MB);
    expect(policy.maxImageBytes).toBe(MB);
    await expect(parse).rejects.toThrow(/exceeds size limit/i);
  });

  it("accepts images under the advertised maxImageBytes", async () => {
    const { policy, parse } = await parseImageWithPolicy(cfgWithMediaMaxMb(20), 3 * MB);
    expect(policy.maxImageBytes).toBe(MAX_IMAGE_BYTES);
    const parsed = await parse;
    try {
      expect(parsed.offloadedRefs).toHaveLength(1);
    } finally {
      await cleanupOffloadedRefs(parsed.offloadedRefs);
    }
  });

  it("rejects images above the advertised maxImageBytes when the hydration cap is the smaller limit", async () => {
    const { policy, parse } = await parseImageWithPolicy(
      cfgWithMediaMaxMb(20),
      MAX_IMAGE_BYTES + 3,
    );
    expect(policy.maxImageBytes).toBe(MAX_IMAGE_BYTES);
    await expect(parse).rejects.toThrow(/image exceeds size limit/i);
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });
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

  it.each([true, false])(
    "cleans earlier offloads when cancelled capability resolution returns %s",
    async (supportsImages) => {
      const controller = new AbortController();
      const reason = new Error("upload cancelled");
      await expect(
        parseMessageWithAttachments("read these", [pdfAttachment(), pngAttachment()], {
          signal: controller.signal,
          supportsImages: async () => {
            controller.abort(reason);
            return supportsImages;
          },
        }),
      ).rejects.toBe(reason);
      expect(saveMediaBufferMock).toHaveBeenCalledOnce();
      const saved = await saveMediaBufferMock.mock.results[0]?.value;
      expect(deleteMediaBufferMock).toHaveBeenCalledWith(saved?.id, "inbound");
    },
  );

  it("accepts nonzero pad bits without using them for MIME inference", async () => {
    const parsed = await parseMessageWithAttachments("x", [pngAttachment({ content: "ZE==" })]);
    expect(parsed.images).toEqual([]);
    expect(parsed.offloadedRefs[0]).toMatchObject({
      mimeType: "application/octet-stream",
      sizeBytes: 1,
    });
    expect(saveMediaBufferMock.mock.calls[0]?.[0]).toEqual(Buffer.from("d"));
  });

  it.each(["QQ", "Q Q=", "QQ==\nQQ==", "QQ=Q", "%not-base64%"])(
    "rejects attachment dialect violations %j",
    async (content) => {
      await expect(parseMessageWithAttachments("x", [pdfAttachment({ content })])).rejects.toThrow(
        /invalid base64/,
      );
      expect(saveMediaBufferMock).not.toHaveBeenCalled();
    },
  );

  it("trims outer whitespace while retaining the exact decoded byte limit", async () => {
    await expect(
      parseMessageWithAttachments("x", [pdfAttachment({ content: " \tQUI=\n " })], { maxBytes: 2 }),
    ).resolves.toMatchObject({ offloadedRefs: [expect.objectContaining({ sizeBytes: 2 })] });
    expect(saveMediaBufferMock.mock.calls[0]?.[0]).toEqual(Buffer.from("AB"));
  });

  it("rejects images over limit without decoding base64", async () => {
    const big = "A".repeat(10_000);
    const att: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "big.png",
      content: big,
    };

    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      await expect(
        parseMessageWithAttachments("x", [att], { maxBytes: 16, log: { warn: () => {} } }),
      ).rejects.toThrow(/exceeds size limit/i);
      const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
      expect(base64Calls).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
  });
});
