// Provider entry tests for image normalization byte-limit failures.
import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaAttachmentCache } from "./attachments.js";
import type { MediaUnderstandingProvider } from "./types.js";

const mocks = vi.hoisted(() => {
  class MockImageDescriptionMaxBytesError extends Error {
    readonly maxBytes: number;

    constructor(maxBytes: number) {
      super(`Image exceeds maxBytes ${maxBytes}`);
      this.name = "ImageDescriptionMaxBytesError";
      this.maxBytes = maxBytes;
    }
  }

  return {
    MockImageDescriptionMaxBytesError,
    normalizeImageDescriptionInput: vi.fn(),
    resolveImageDescriptionCompressionPolicy: vi.fn(async () => ({ quality: "balanced" })),
    resolveImageDescriptionPreCompressionMaxBytes: vi.fn((maxBytes: number) =>
      Math.max(maxBytes, 50 * 1024 * 1024),
    ),
  };
});

vi.mock("./image-input-normalize.js", () => ({
  normalizeImageDescriptionInput: mocks.normalizeImageDescriptionInput,
  isImageDescriptionMaxBytesError: (err: unknown) =>
    err instanceof mocks.MockImageDescriptionMaxBytesError,
}));

vi.mock("./image-compression-policy.js", () => ({
  resolveImageDescriptionCompressionPolicy: mocks.resolveImageDescriptionCompressionPolicy,
  resolveImageDescriptionPreCompressionMaxBytes:
    mocks.resolveImageDescriptionPreCompressionMaxBytes,
}));

const { runProviderEntry } = await import("./runner.entries.js");

describe("runProviderEntry image maxBytes", () => {
  it("reports post-compression image cap failures as skipped maxBytes attempts", async () => {
    mocks.normalizeImageDescriptionInput.mockRejectedValue(
      new mocks.MockImageDescriptionMaxBytesError(10 * 1024 * 1024),
    );
    const describeImage = vi.fn(async () => ({ text: "should not run" }));
    const getBuffer = vi.fn(async () => ({
      buffer: Buffer.from("oversized-jpeg"),
      fileName: "large.jpg",
      mime: "image/jpeg",
      size: 20 * 1024 * 1024,
    }));
    const cache = { getBuffer } as unknown as MediaAttachmentCache;

    await expect(
      runProviderEntry({
        capability: "image",
        entry: { provider: "openrouter", model: "vision-model" },
        cfg: {} as OpenClawConfig,
        ctx: {} as MsgContext,
        attachmentIndex: 0,
        cache,
        agentDir: "/tmp/agent",
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          [
            "openrouter",
            {
              id: "openrouter",
              capabilities: ["image"],
              describeImage,
            },
          ],
        ]),
      }),
    ).rejects.toMatchObject({
      name: "MediaUnderstandingSkipError",
      reason: "maxBytes",
      message: "Attachment 1 exceeds maxBytes 10485760",
    });

    expect(getBuffer).toHaveBeenCalledWith({
      attachmentIndex: 0,
      maxBytes: 50 * 1024 * 1024,
      timeoutMs: 60_000,
    });
    expect(describeImage).not.toHaveBeenCalled();
  });
});
