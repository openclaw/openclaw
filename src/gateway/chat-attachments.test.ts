import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoisyPngBuffer, createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { detectAndLoadPromptImages } from "../agents/embedded-agent-runner/run/images.js";
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
  parseMessageWithAttachments,
  persistInboundImagesForTranscript,
  stripImageMediaMarkers,
} from "./chat-attachments.js";
import { sanitizeChatHistoryMessages } from "./chat-display-projection.sanitize.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./server-methods/attachment-normalize.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// ISO-BMFF's generic brand identifies the container, not its audio/video tracks.
const GENERIC_MP4 = Buffer.from(
  "0000001c6674797069736f6d0000020069736f6d69736f326d70343100000008",
  "hex",
).toString("base64");

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

function savedMedia(id: string, contentType: string, size: number) {
  return { id, path: `/media/inbound/${id}`, size, contentType };
}

function boundedImageFixture(kind: string): Buffer {
  const fixedHeaders: Record<string, string> = {
    gif:
      "47494638396120001000800000000000ffffff" +
      "21f90400000000002c0000000001000100000202440100".repeat(2) +
      "3b",
    webp: "52494646b8d4010057454250565038200a0000000000009d012a20001000",
    "webp-lossless": "52494646b8d40100574542505650384c0a0000002f1fc00300000000000000",
    "webp-extended": "52494646b8d4010057454250565038580a000000000000001f00000f0000",
  };
  const exif = "ffe1002245786966000049492a0008000000010012010300010000000600000000000000";
  // TIFF IFD offset 59,970 puts the orientation entry at APP1 byte 59,980.
  const orientation =
    kind === "jpeg-large-exif"
      ? "ffe1ea6245786966000049492a0042ea0000" +
        "00".repeat(59_962) +
        exif.slice(36) +
        "00".repeat(6)
      : kind === "jpeg-rotated" || kind === "jpeg-fallback"
        ? exif
        : "";
  // Five APP2 segments put SOF and EXIF beyond the 256KiB prefix cap.
  const app2 = kind === "jpeg-fallback" ? ("ffe2ea62" + "00".repeat(60_000)).repeat(5) : "";
  const frame = kind === "jpeg-progressive" ? "ffc2" : "ffc0";
  const header = Buffer.from(
    fixedHeaders[kind] ??
      `ffd8${app2}${frame}000b080010002001011100${orientation}ffda0008010100003f00`,
    "hex",
  );

  return Buffer.concat([header, Buffer.alloc(Math.max(0, 120_000 - header.length))]);
}

function persist(
  media: Pick<Awaited<ReturnType<typeof parseMessageWithAttachments>>, "images" | "offloadedRefs">,
  options: Partial<
    Pick<Parameters<typeof persistInboundImagesForTranscript>[0], "log" | "assertCurrent">
  > = {},
) {
  return persistInboundImagesForTranscript({
    ...media,
    log: { warn: vi.fn() },
    logContext: "chat.send",
    ...options,
  });
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
    const prepared = { id: "managed-id", path: "/external/user-owned.png" };

    await expect(discardPreparedInboundMedia([prepared], { warn })).resolves.toBeUndefined();

    expect(deleteMediaBufferMock).toHaveBeenCalledExactlyOnceWith("managed-id", "inbound");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to discard prepared inbound media managed-id: unlink denied"),
    );
  });
});

describe("composer attachment origin", () => {
  it.each([
    { origin: "paste", expected: "paste" },
    { origin: "file", expected: "file" },
    { origin: "clipboard", expected: undefined },
  ])(
    "retains bounded origin $origin through transcript and history without changing content",
    async ({ origin, expected }) => {
      const bytes = Buffer.from("First line\nSecond line\n", "utf8");
      const fileName = "pasted-text-123.txt";
      saveMediaBufferMock.mockResolvedValueOnce(
        savedMedia("pasted-text-123.txt", "text/plain", bytes.length),
      );
      const attachments = [
        { mimeType: "text/plain", fileName, origin, content: bytes.toString("base64") },
      ];
      const parsed = await parseMessageWithAttachments(
        "Read this",
        normalizeRpcAttachmentsToChatAttachments(attachments),
      );
      const persisted = await persist(parsed);
      const message = buildPersistedUserTurnMessage({
        text: "Read this",
        media: persisted.entries.map((entry) => entry.fact),
      });
      const canonical = canonicalizePersistedUserMessageMedia(message).message;
      const recovered = buildPersistedUserTurnMediaInputsFromFields(canonical);
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
      expect(history).toMatchObject({ role: "user", content: "Read this" });
      expect(recovered[0]).toMatchObject({
        fileName,
        contentType: "text/plain",
        sizeBytes: bytes.length,
      });
    },
  );
});

describe("persistInboundImagesForTranscript", () => {
  it.each([
    ["inline", 32, 16],
    ["worker", 32, 16],
    ["offloaded", 32, 16],
    ["unreadable", undefined, undefined],
    ["mime-hint", 40, 30],
    ["bounded-jpeg", 32, 16],
    ["bounded-jpeg-progressive", 32, 16],
    ["bounded-jpeg-rotated", 16, 32],
    ["bounded-jpeg-large-exif", 16, 32],
    ["jpeg-fallback", 16, 32],
    ["bounded-gif", 32, 16],
    ["bounded-webp", 32, 16],
    ["bounded-webp-lossless", 32, 16],
    ["bounded-webp-extended", 32, 16],
  ] as const)(
    "persists byte-authoritative dimensions for %s images",
    async (kind, width, height) => {
      let bytes = createNoisyPngBuffer(32, 16);
      const format = kind.startsWith("bounded-")
        ? kind.slice(8).split("-")[0]
        : kind === "jpeg-fallback"
          ? "jpeg"
          : "png";
      const mimeType = `image/${format}`;
      const fileName = `upload.${format}`;
      if (format !== "png") {
        bytes = boundedImageFixture(kind.replace("bounded-", ""));
      } else if (kind === "offloaded" || kind === "worker") {
        bytes = Buffer.concat([bytes, Buffer.alloc(kind === "worker" ? 1_900_000 : 2_000_000)]);
      } else if (kind === "mime-hint") {
        // MIME sniffing misses this permissive JPEG header reader's late SOF.
        bytes = Buffer.alloc(70);
        bytes.set(Buffer.from("ffd8e00032", "hex"));
        bytes.set(Buffer.from("ffc0000b08001e0028", "hex"), 53);
      } else if (kind === "unreadable") {
        bytes = Buffer.from("89504e470d0a1a0a0000000000000000", "hex");
      }
      const supplied = { width: 999, height: 777 };
      const base64 = bytes.toString("base64");
      const from = vi.spyOn(Buffer, "from");
      const parsed = await parseMessageWithAttachments(
        "Inspect",
        normalizeRpcAttachmentsToChatAttachments([
          pngAttachment({
            fileName,
            mimeType,
            content: `data:${mimeType};base64,${base64}`,
            ...(kind === "inline" ? {} : supplied),
          }),
        ]),
        { supportsImages: kind !== "unreadable" },
      );
      const storage = kind === "offloaded" || kind === "unreadable" ? "offloaded" : "inline";
      expect(parsed.imageOrder).toEqual([storage]);
      if (
        kind === "inline" ||
        kind === "worker" ||
        kind === "offloaded" ||
        kind.startsWith("bounded-")
      ) {
        expect(from).not.toHaveBeenCalledWith(base64, "base64");
      }
      const persisted = await persist(parsed);
      const message = buildPersistedUserTurnMessage({
        text: "Inspect",
        media: persisted.entries.map((entry) => entry.fact),
      });
      const recovered = readPersistedMediaFacts(message)?.[0];
      expect(recovered).toMatchObject({ kind: "image", fileName, contentType: mimeType });
      expect([recovered?.width, recovered?.height]).toEqual([width, height]);
      expect(saveMediaBufferMock.mock.calls[0]?.[0]?.equals(bytes), "saved image bytes").toBe(true);
    },
  );

  it.each(["authorization", "disk"])("preserves %s upload failure semantics", async (failure) => {
    const error =
      failure === "authorization"
        ? new SessionMutationAuthorizationChangedError({
            code: "FORBIDDEN",
            message: "File and image uploads are disabled",
            details: { code: "UPLOADS_DISABLED" },
          })
        : new Error("disk unavailable");
    saveMediaBufferMock.mockRejectedValueOnce(error);
    const warn = vi.fn();
    const result = persist(
      {
        images: [{ type: "image", data: PNG_1x1, mimeType: "image/png" }],
        offloadedRefs: [],
      },
      { log: { warn }, assertCurrent: () => {} },
    );
    if (failure === "authorization") {
      await expect(result).rejects.toBe(error);
      expect(warn).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toEqual({ entries: [], omission: "inline-image-save-failed" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(error.message));
    }
  });

  it("preserves original mixed-media order in claim-only transcript facts", async () => {
    const fileName = "bands café 雪 🦞.png";
    saveMediaBufferMock.mockResolvedValueOnce(savedMedia("video", "video/mp4", 100));
    const parsed = await parseMessageWithAttachments("Compare these", [
      { fileName: "video.mp4", mimeType: "video/mp4", content: GENERIC_MP4, durationMs: 2_000 },
      pngAttachment({ fileName }),
    ]);
    saveMediaBufferMock.mockResolvedValueOnce(savedMedia("inline", "image/png", 5));

    const result = await persist({
      images: parsed.images,
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
    expect(result.omission).toBe("none");
  });
});

describe("parseMessageWithAttachments", () => {
  it("serializes warm inline images identically to cold historical images", async () => {
    const workspaceDir = tempDirs.make("openclaw-warm-image-");
    const imagePath = path.join(workspaceDir, "photo.png");
    const bytes = createSolidPngBuffer(2, 1, { r: 12, g: 34, b: 56 });
    await fs.writeFile(imagePath, bytes);
    const warm = await parseMessageWithAttachments("inspect", [
      pngAttachment({ fileName: "photo.png", content: bytes.toString("base64") }),
    ]);
    const cold = await detectAndLoadPromptImages({
      prompt: "",
      workspaceDir,
      workspaceOnly: true,
      model: { input: ["text", "image"] },
      media: [{ path: imagePath, contentType: "image/png" }],
    });
    expect(warm.images).toEqual([
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
    ]);
    expect(JSON.stringify(warm.images)).toBe(JSON.stringify(cold.images));
  });

  it("keeps mixed image/PDF markers in normal and image-stripped routing order", async () => {
    // Non-image offloads must not enter imageOrder and reorder hydration.
    const bigPng = Buffer.alloc(2_100_000);
    bigPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const parsed = await parseMessageWithAttachments("x", [
      pdfAttachment(),
      pngAttachment(),
      pngAttachment({ fileName: "big.png", content: bigPng.toString("base64") }),
    ]);
    expect(parsed).toMatchObject({
      images: [{ type: "image", mimeType: "image/png" }],
      offloadedRefs: [
        { mimeType: "application/pdf", sourceIndex: 0 },
        { mimeType: "image/png", sourceIndex: 2 },
      ],
      imageOrder: ["inline", "offloaded"],
    });
    const pdfRef = expectDefined(parsed.offloadedRefs[0], "offloaded PDF ref");
    const imageRef = expectDefined(parsed.offloadedRefs[1], "offloaded image ref");
    expect(parsed.message).toBe(
      `x\n[media attached: ${pdfRef.mediaRef}]\n[media attached: ${imageRef.mediaRef}]`,
    );
    expect(stripImageMediaMarkers(parsed.message, parsed.offloadedRefs)).toBe(
      `x\n[media attached: ${pdfRef.mediaRef}]`,
    );
  });
});

describe("parseMessageWithAttachments validation errors", () => {
  it.each([
    ["empty string", { content: "" }, {}, "empty-payload"],
    ["empty typed array", { content: new Uint8Array(0) }, {}, "empty-payload"],
    ["empty array buffer", { content: new ArrayBuffer(0) }, {}, "empty-payload"],
    [
      "empty source",
      { source: { type: "base64", media_type: "application/pdf", data: "" } },
      {},
      "empty-payload",
    ],
    [
      "ZIP disguised as PNG",
      pngAttachment({ content: "UEsDBHppcC1hcmNoaXZlLWJ5dGVz" }),
      { acceptNonImage: false },
      "unsupported-non-image",
    ],
    ["inline images disabled", pngAttachment(), { supportsInlineImages: false }, "text-only-image"],
  ] as const)("rejects %s without writing media", async (_name, attachment, options, reason) => {
    const caught = await parseMessageWithAttachments(
      "x",
      normalizeRpcAttachmentsToChatAttachments([attachment]),
      options,
    ).catch((error: unknown) => error);
    expect(caught).toMatchObject({ name: "UnsupportedAttachmentError", reason });
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
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

  it("passes through unchanged on text-only session with no attachments", async () => {
    const parsed = await parseMessageWithAttachments("hello", [], { supportsInlineImages: false });
    expect(parsed).toMatchObject({ message: "hello", images: [], offloadedRefs: [] });
    expect(stripImageMediaMarkers(parsed.message, parsed.offloadedRefs)).toBe("hello");
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "audio",
      "audio/mpeg",
      "voice.mp3",
      Buffer.from([0xff, 0xfb, 0x90, 0x00]).toString("base64"),
      "audio/mpeg",
    ],
    ["video", "audio/aac", "clip.mp4", GENERIC_MP4, "video/mp4"],
  ])(
    "surfaces structured inbound %s facts %#",
    async (kind, mimeType, fileName, content, expectedMimeType) => {
      // A probe augments the audio facts; unprobed video keeps its supplied duration.
      const durationMs = kind === "audio" ? 2345 : 1500;
      if (kind === "audio") {
        probeMediaFilesWithinBudgetMock.mockResolvedValueOnce([{ durationMs }]);
      }
      const parsed = await parseMessageWithAttachments(
        "play this",
        [{ type: kind, mimeType, fileName, content, durationMs: 1_500 }],
        { supportsInlineImages: false },
      );

      expect(parsed.offloadedRefs).toMatchObject([
        {
          kind,
          mimeType: expectedMimeType,
          label: fileName,
          durationMs,
          mediaRef: expect.stringMatching(/^media:\/\/inbound\//u),
        },
      ]);
      expect(parsed.media[0]).toMatchObject({ kind, contentType: expectedMimeType, durationMs });
    },
  );

  it("caps text-only image offloads", async () => {
    const attachments = Array.from({ length: 11 }, (_, index) =>
      pngAttachment({ fileName: `dot-${index}.png` }),
    );
    const parsed = await parseMessageWithAttachments("see these", attachments, {
      supportsImages: false,
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

  it.each(["image", "request"] as const)(
    "enforces the %s byte ceiling before full decoding",
    async (limit) => {
      const policy = resolveChatAttachmentPolicy({ agents: { defaults: { mediaMaxMb: 20 } } });
      expect(policy.maxImageBytes).toBe(MAX_IMAGE_BYTES);
      const content =
        limit === "image"
          ? PNG_1x1.slice(0, 64) + "A".repeat(Math.ceil((MAX_IMAGE_BYTES + 3) / 3) * 4 - 64)
          : "A".repeat(10_000);
      const from = vi.spyOn(Buffer, "from");
      await expect(
        parseMessageWithAttachments("x", [pngAttachment({ content })], {
          maxBytes: limit === "image" ? policy.maxBytes : 16,
        }),
      ).rejects.toThrow(limit === "image" ? /image exceeds size limit/i : /exceeds size limit/i);
      if (limit === "request") {
        expect(from).not.toHaveBeenCalledWith(expect.anything(), "base64");
      }
      expect(from).not.toHaveBeenCalledWith(content, "base64");
      expect(saveMediaBufferMock).not.toHaveBeenCalled();
    },
  );
});
