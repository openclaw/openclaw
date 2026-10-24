import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { mediaModels } from "./media-config.test-support.js";
import { runMediaFixture } from "./runner-case.test-support.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
import { runCapability } from "./runner.js";
import { withVideoFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

const nativeModel = { provider: "lmstudio", model: "video-model" };
const handoff = "handed-to-native-vision";
type RunParams = Parameters<typeof runCapability>[0];

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
    models: mediaModels("lmstudio", "video-model", input, {
      api,
      baseUrl: "http://127.0.0.1:1234/v1",
    }),
  };
}

function runVideo(
  provider: MediaUnderstandingProvider,
  cfg: OpenClawConfig,
  activeModel?: RunParams["activeModel"],
) {
  return runMediaFixture("video", "openclaw-video", {
    cfg,
    providerRegistry: new Map([[provider.id, provider]]),
    activeModel,
  });
}

async function runNativeVideo(ctx: RunParams["ctx"]) {
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media);
  try {
    return await runCapability({
      capability: "video",
      cfg: nativeVideoConfig(),
      ctx,
      attachments: cache,
      media,
      providerRegistry: new Map(),
      activeModel: nativeModel,
    });
  } finally {
    await cache.cleanup();
  }
}

describe("runCapability video", () => {
  it.each<[string, OpenClawConfig, string, ModelProviderConfig["api"]?]>([
    ["configured video", nativeVideoConfig(), handoff],
    ["text-only model", nativeVideoConfig(["text"]), "no-model"],
    ["another API", nativeVideoConfig(["text", "video"], "openai-responses"), "no-model"],
    ["prepared completions", nativeVideoConfig(), handoff, "openai-completions"],
    ["prepared responses", nativeVideoConfig(), "no-model", "openai-responses"],
  ])("native video handoff: %s", async (_name, cfg, kind, api) => {
    if (api) {
      delete expectDefined(cfg.models?.providers?.lmstudio, "provider").api;
    }
    const result = await runVideo({ id: "lmstudio" }, cfg, {
      ...nativeModel,
      ...(api ? { api } : {}),
    });
    expect(result.outputs).toEqual([]);
    expect(result.decision.attachmentDispositions).toEqual({ 0: { kind } });
  });

  it("hands off every local video despite the default understanding attachment limit", async () => {
    await withVideoFixture("openclaw-video-first", async (first) => {
      await withVideoFixture("openclaw-video-second", async (second) => {
        const ctx = { media: [...first.ctx.media, ...second.ctx.media] };
        const result = await runNativeVideo(ctx);
        expect(result.decision.attachmentDispositions).toEqual({
          0: { kind: handoff },
          1: { kind: handoff },
        });
      });
    });
  });

  it("does not claim native handoff for a remote video URL", async () => {
    const result = await runNativeVideo({
      media: [{ url: "https://cdn.example.test/video.mp4", contentType: "video/mp4" }],
    });
    expect(result.decision.attachmentDispositions).toEqual({
      0: { kind: "failed", reason: "remote-url video is not natively deliverable" },
    });
    expect(result.decision.attachments).toEqual([{ attachmentIndex: 0, attempts: [] }]);
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
    expect(result.outputs[0]?.text).toBe(prefix);
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
    expect(result.outputs[0]).toMatchObject({ provider: "moonshot", model: "provider-default" });
    expect(seenModel).toBeUndefined();
  });
});
