// Native video decisions preserve first-class delivery while retaining bounded
// caption fallbacks for unsupported, suppressed, or explicitly configured media.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { DEFAULT_MAX_BYTES } from "./defaults.constants.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
import { runCapability } from "./runner.js";
import { withVideoFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

type TestCatalogEntry = {
  id: string;
  provider: string;
  input: Array<"text" | "image" | "video">;
};

const catalogState = vi.hoisted(() => ({ entries: [] as TestCatalogEntry[] }));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog: vi.fn(async () => catalogState.entries),
}));

vi.mock("../agents/model-catalog.js", () => ({
  findModelInCatalog: (catalog: TestCatalogEntry[], provider: string, model: string) =>
    catalog.find((entry) => entry.provider === provider && entry.id === model),
  modelSupportsVision: (entry: TestCatalogEntry | undefined) =>
    entry?.input.includes("image") === true,
}));

vi.mock("../media/channel-inbound-roots.js", () => ({
  resolveChannelInboundAttachmentRoots: () => undefined,
}));

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../agents/api-key-rotation.js", () => ({
  collectProviderApiKeysForExecution: ({ primaryApiKey }: { primaryApiKey?: string }) => [
    primaryApiKey ?? "test-key",
  ],
  executeWithApiKeyRotation: async <T>({ execute }: { execute: (apiKey: string) => Promise<T> }) =>
    execute("test-key"),
}));

function createVideoProvider(
  describeVideo: NonNullable<MediaUnderstandingProvider["describeVideo"]>,
) {
  return new Map<string, MediaUnderstandingProvider>([
    ["moonshot", { id: "moonshot", capabilities: ["video"], describeVideo }],
  ]);
}

function createVideoConfig(options?: {
  explicit?: boolean;
  allAttachments?: boolean;
}): OpenClawConfig {
  return {
    models: {
      providers: {
        moonshot: { apiKey: "test-key", models: [] },
      },
    },
    tools: {
      media: {
        ...(options?.explicit
          ? {
              models: [
                { provider: "moonshot", model: "kimi-k3", capabilities: ["video" as const] },
              ],
            }
          : {}),
        video: {
          enabled: true,
          ...(options?.allAttachments
            ? { attachments: { mode: "all" as const, maxAttachments: 2 } }
            : {}),
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("runCapability native video delivery", () => {
  beforeEach(() => {
    catalogState.entries = [
      { id: "kimi-k3", provider: "moonshot", input: ["text", "image", "video"] },
    ];
  });

  it("skips captioning when the active model receives an eligible native video", async () => {
    await withVideoFixture("openclaw-native-video-skip", async ({ ctx, media, cache }) => {
      const describeVideo = vi.fn(async () => ({ text: "caption" }));
      const result = await runCapability({
        capability: "video",
        cfg: createVideoConfig(),
        ctx,
        attachments: cache,
        media,
        providerRegistry: createVideoProvider(describeVideo),
        activeModel: { provider: "moonshot", model: "kimi-k3" },
      });

      expect(describeVideo).not.toHaveBeenCalled();
      expect(result.outputs).toEqual([]);
      expect(result.decision).toEqual({
        capability: "video",
        outcome: "skipped",
        attachments: [
          {
            attachmentIndex: 0,
            attempts: [
              {
                type: "provider",
                provider: "moonshot",
                model: "kimi-k3",
                outcome: "skipped",
                reason: "primary model supports video natively",
              },
            ],
            chosen: {
              type: "provider",
              provider: "moonshot",
              model: "kimi-k3",
              outcome: "skipped",
              reason: "primary model supports video natively",
            },
          },
        ],
      });
    });
  });

  it("keeps caption fallback when the resolved model does not accept native video", async () => {
    catalogState.entries[0]!.input = ["text", "image"];
    await withVideoFixture("openclaw-native-video-unsupported", async ({ ctx, media, cache }) => {
      const describeVideo = vi.fn(async () => ({ text: "fallback caption" }));
      const result = await runCapability({
        capability: "video",
        cfg: createVideoConfig(),
        ctx,
        attachments: cache,
        media,
        providerRegistry: createVideoProvider(describeVideo),
        activeModel: { provider: "moonshot", model: "kimi-k3" },
      });

      expect(describeVideo).toHaveBeenCalledOnce();
      expect(result.outputs.map((output) => output.text)).toEqual(["fallback caption"]);
      expect(result.decision.outcome).toBe("success");
    });
  });

  it("keeps caption fallback for URL-only Twilio video that cannot hydrate natively", async () => {
    const ctx = {
      media: [
        {
          url: "https://api.twilio.com/media/second",
          contentType: "video/mp4",
          sizeBytes: 5,
        },
      ],
    };
    const media = normalizeMediaAttachments(ctx);
    const getBuffer = vi.fn(async () => ({
      buffer: Buffer.from("video"),
      mime: "video/mp4",
      fileName: "second.mp4",
      size: 5,
    }));
    const describeVideo = vi.fn(async () => ({ text: "Twilio video caption" }));
    const result = await runCapability({
      capability: "video",
      cfg: createVideoConfig(),
      ctx,
      attachments: { getBuffer } as unknown as Parameters<typeof runCapability>[0]["attachments"],
      media,
      providerRegistry: createVideoProvider(describeVideo),
      activeModel: { provider: "moonshot", model: "kimi-k3" },
    });

    expect(getBuffer).toHaveBeenCalledOnce();
    expect(describeVideo).toHaveBeenCalledOnce();
    expect(result.outputs.map((output) => output.text)).toEqual(["Twilio video caption"]);
    expect(result.decision.outcome).toBe("success");
  });

  it.each([
    { reason: "hydration is suppressed", fact: { hydrationSuppressed: true } },
    {
      reason: "the video exceeds the native bound",
      fact: { sizeBytes: DEFAULT_MAX_BYTES.video + 1 },
    },
  ])("keeps caption fallback when $reason", async ({ fact }) => {
    await withVideoFixture("openclaw-native-video-ineligible", async ({ ctx, media, cache }) => {
      Object.assign(ctx.media[0]!, fact);
      const describeVideo = vi.fn(async () => ({ text: "fallback caption" }));
      const result = await runCapability({
        capability: "video",
        cfg: createVideoConfig(),
        ctx,
        attachments: cache,
        media,
        providerRegistry: createVideoProvider(describeVideo),
        activeModel: { provider: "moonshot", model: "kimi-k3" },
      });

      expect(describeVideo).toHaveBeenCalledOnce();
      expect(result.outputs.map((output) => output.text)).toEqual(["fallback caption"]);
      expect(result.decision.outcome).toBe("success");
    });
  });

  it("preserves explicitly configured video captioning for native-capable models", async () => {
    await withVideoFixture("openclaw-native-video-explicit", async ({ ctx, media, cache }) => {
      const describeVideo = vi.fn(async () => ({ text: "explicit caption" }));
      const result = await runCapability({
        capability: "video",
        cfg: createVideoConfig({ explicit: true }),
        ctx,
        attachments: cache,
        media,
        providerRegistry: createVideoProvider(describeVideo),
        activeModel: { provider: "moonshot", model: "kimi-k3" },
      });

      expect(describeVideo).toHaveBeenCalledOnce();
      expect(result.outputs.map((output) => output.text)).toEqual(["explicit caption"]);
      expect(result.decision.outcome).toBe("success");
    });
  });

  it("keeps native and fallback decisions independent for mixed video attachments", async () => {
    await withVideoFixture("openclaw-native-video-mixed", async ({ ctx, mediaPath }) => {
      ctx.media.push({ path: mediaPath, contentType: "video/mp4" });
      Object.assign(ctx.media[1]!, { hydrationSuppressed: true });
      const media = normalizeMediaAttachments(ctx);
      const cache = createMediaAttachmentCache(media, {
        localPathRoots: [path.dirname(mediaPath)],
        includeDefaultLocalPathRoots: false,
      });
      try {
        const describeVideo = vi.fn(async () => ({ text: "fallback caption" }));
        const result = await runCapability({
          capability: "video",
          cfg: createVideoConfig({ allAttachments: true }),
          ctx,
          attachments: cache,
          media,
          providerRegistry: createVideoProvider(describeVideo),
          activeModel: { provider: "moonshot", model: "kimi-k3" },
        });

        expect(describeVideo).toHaveBeenCalledOnce();
        expect(result.outputs).toMatchObject([{ attachmentIndex: 1, text: "fallback caption" }]);
        expect(result.decision.outcome).toBe("success");
        expect(
          result.decision.attachments.map(({ attachmentIndex, chosen }) => ({
            attachmentIndex,
            outcome: chosen?.outcome,
          })),
        ).toEqual([
          { attachmentIndex: 0, outcome: "skipped" },
          { attachmentIndex: 1, outcome: "success" },
        ]);
      } finally {
        await cache.cleanup();
      }
    });
  });
});
