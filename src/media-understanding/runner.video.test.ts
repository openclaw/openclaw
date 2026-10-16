import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
  OpenClawConfig,
} from "../config/types.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
import { runCapability } from "./runner.js";
import { withVideoFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

vi.mock("../media/channel-inbound-roots.js", () => ({
  resolveChannelInboundAttachmentRoots: () => undefined,
}));

vi.mock("../agents/api-key-rotation.js", () => ({
  collectProviderApiKeysForExecution: ({ primaryApiKey }: { primaryApiKey?: string }) => [
    primaryApiKey ?? "test-key",
  ],
  executeWithApiKeyRotation: async <T>({ execute }: { execute: (apiKey: string) => Promise<T> }) =>
    execute("test-key"),
}));

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

function videoConfig(models?: MediaUnderstandingModelConfig[]): OpenClawConfig {
  return {
    models: {
      providers: {
        moonshot: { baseUrl: "https://video.example/v1", apiKey: "test-key", models: [] },
      },
    },
    tools: { media: { models, video: { enabled: true } } },
  };
}

function nativeVideoConfig(
  input: ModelDefinitionConfig["input"] = ["text", "video"],
  api: ModelProviderConfig["api"] = "openai-completions",
): OpenClawConfig {
  return {
    models: {
      providers: {
        lmstudio: {
          baseUrl: "http://127.0.0.1:1234/v1",
          api,
          models: [
            {
              id: "video-model",
              name: "Video model",
              reasoning: false,
              input,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
  };
}

async function runVideo(
  provider: MediaUnderstandingProvider,
  cfg: OpenClawConfig,
  activeModel?: Parameters<typeof runCapability>[0]["activeModel"],
) {
  let result: Awaited<ReturnType<typeof runCapability>> | undefined;
  await withVideoFixture("openclaw-video", async ({ ctx, media, cache }) => {
    result = await runCapability({
      capability: "video",
      cfg,
      ctx,
      attachments: cache,
      media,
      providerRegistry: new Map([[provider.id, provider]]),
      activeModel,
    });
  });
  return expectDefined(result, "video result");
}

describe("runCapability video", () => {
  it.each([
    {
      name: "hands configured completions video to the active model",
      cfg: nativeVideoConfig(),
      kind: "handed-to-native-vision",
    },
    {
      name: "does not hand video to a text-only completions model",
      cfg: nativeVideoConfig(["text"]),
      kind: "no-model",
    },
    {
      name: "does not hand video to a model using another API",
      cfg: nativeVideoConfig(["text", "video"], "openai-responses"),
      kind: "no-model",
    },
  ])("$name", async ({ cfg, kind }) => {
    const result = await runVideo({ id: "lmstudio" }, cfg, {
      provider: "lmstudio",
      model: "video-model",
    });
    expect(result.outputs).toEqual([]);
    expect(result.decision.attachmentDispositions).toEqual({ 0: { kind } });
  });

  it.each([
    { api: "openai-completions", kind: "handed-to-native-vision" },
    { api: "openai-responses", kind: "no-model" },
  ] as const)("uses prepared $api when the authored API is omitted", async ({ api, kind }) => {
    const cfg = nativeVideoConfig();
    delete expectDefined(cfg.models?.providers?.lmstudio, "provider").api;
    const result = await runVideo({ id: "lmstudio" }, cfg, {
      provider: "lmstudio",
      model: "video-model",
      api,
    });
    expect(result.outputs).toEqual([]);
    expect(result.decision.attachmentDispositions).toEqual({ 0: { kind } });
  });

  it("hands off every local video despite the default understanding attachment limit", async () => {
    await withVideoFixture("openclaw-video-first", async (first) => {
      await withVideoFixture("openclaw-video-second", async (second) => {
        const ctx = { media: [...first.ctx.media, ...second.ctx.media] };
        const media = normalizeMediaAttachments(ctx);
        const cache = createMediaAttachmentCache(media);
        try {
          const result = await runCapability({
            capability: "video",
            cfg: nativeVideoConfig(),
            ctx,
            attachments: cache,
            media,
            providerRegistry: new Map(),
            activeModel: { provider: "lmstudio", model: "video-model" },
          });
          expect(result.decision.attachmentDispositions).toEqual({
            0: { kind: "handed-to-native-vision" },
            1: { kind: "handed-to-native-vision" },
          });
        } finally {
          await cache.cleanup();
        }
      });
    });
  });

  it("does not claim native handoff for a remote video URL", async () => {
    const ctx = {
      media: [{ url: "https://cdn.example.test/video.mp4", contentType: "video/mp4" }],
    };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media);
    try {
      const result = await runCapability({
        capability: "video",
        cfg: nativeVideoConfig(),
        ctx,
        attachments: cache,
        media,
        providerRegistry: new Map(),
        activeModel: { provider: "lmstudio", model: "video-model" },
      });
      expect(result.decision.attachmentDispositions).toEqual({
        0: { kind: "failed", reason: "remote-url video is not natively deliverable" },
      });
      expect(result.decision.attachments).toEqual([{ attachmentIndex: 0, attempts: [] }]);
    } finally {
      await cache.cleanup();
    }
  });

  it("truncates provider output without splitting a boundary emoji", async () => {
    const prefix = "v".repeat(79);
    const result = await runVideo(
      {
        id: "moonshot",
        capabilities: ["video"],
        describeVideo: async (req) => ({
          text: `${prefix}${String.fromCodePoint(0x1f600)}tail`,
          model: req.model,
        }),
      },
      videoConfig([{ provider: "moonshot", model: "kimi-k2.5", maxChars: 80 }]),
    );
    const output = expectDefined(result.outputs[0], "media output 0");
    expect(output.text).toBe(prefix);
    expect(output.text).not.toContain(String.fromCharCode(0xd83d));
  });

  it("resolves active video provider defaults", async () => {
    let seenModel: string | undefined;
    const result = await runVideo(
      {
        id: "moonshot",
        capabilities: ["video"],
        describeVideo: async (req) => {
          seenModel = req.model;
          return { text: "moonshot", model: req.model ?? "provider-default" };
        },
      },
      videoConfig(),
      { provider: "moonshot" },
    );
    expect(result.decision.outcome).toBe("success");
    expect(result.outputs[0]).toMatchObject({
      provider: "moonshot",
      model: "provider-default",
    });
    expect(seenModel).toBeUndefined();
  });
});
