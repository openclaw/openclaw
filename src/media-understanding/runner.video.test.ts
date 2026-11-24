import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
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

async function runVideo(
  provider: MediaUnderstandingProvider,
  cfg: OpenClawConfig,
  activeModel?: Parameters<typeof runCapability>[0]["activeModel"],
  modelOverride?: { provider: string; model: string },
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
      ...(modelOverride ? { request: { modelOverride } } : {}),
    });
  });
  return expectDefined(result, "video result");
}

describe("runCapability video", () => {
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

  it("does not send the video to a configured fallback after the explicit model fails", async () => {
    const describeVideo = vi.fn<NonNullable<MediaUnderstandingProvider["describeVideo"]>>(
      async (req) => {
        if (req.model === "pinned") {
          throw new Error("fixture model failed");
        }
        return { text: "fallback result", model: req.model };
      },
    );
    const result = await runVideo(
      { id: "moonshot", capabilities: ["video"], describeVideo },
      videoConfig([{ provider: "moonshot", model: "fallback" }]),
      undefined,
      { provider: "moonshot", model: "pinned" },
    );
    expect(describeVideo.mock.calls.map(([request]) => request.model)).toEqual(["pinned"]);
    expect(result.outputs).toEqual([]);
    expect(result.decision.outcome).toBe("failed");
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
