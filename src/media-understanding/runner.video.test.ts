import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { runCapability } from "./runner.js";
import { withMediaFixture, withVideoFixture } from "./runner.test-utils.js";
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

  it.each([
    { mode: "configured", defaultModel: "kimi-k2.5" },
    { mode: "active", defaultModel: undefined },
  ] as const)("resolves $mode video provider defaults", async ({ mode, defaultModel }) => {
    let seenModel: string | undefined;
    const result = await runVideo(
      {
        id: "moonshot",
        capabilities: ["video"],
        defaultModels: defaultModel ? { video: defaultModel } : undefined,
        describeVideo: async (req) => {
          seenModel = req.model;
          return { text: "moonshot", model: req.model ?? "provider-default" };
        },
      },
      videoConfig(
        mode === "configured" ? [{ provider: "moonshot", capabilities: ["video"] }] : undefined,
      ),
      mode === "active" ? { provider: "moonshot" } : undefined,
    );
    expect(result.decision.outcome).toBe("success");
    expect(result.outputs[0]).toMatchObject({
      provider: "moonshot",
      model: defaultModel ?? "provider-default",
    });
    expect(seenModel).toBe(defaultModel);
  });

  it("does not use provider api config as video auth modelApi", async () => {
    const modelAuth = await import("../agents/model-auth.js");
    const resolveAuth = vi.mocked(modelAuth.resolveApiKeyForProviderCore);
    resolveAuth.mockClear();
    let seenApiKey: string | undefined;
    const result = await runVideo(
      {
        id: "openai",
        capabilities: ["video"],
        describeVideo: async (req) => {
          seenApiKey = req.apiKey;
          return { text: "video ok", model: req.model };
        },
      },
      {
        models: {
          providers: {
            openai: { baseUrl: "https://video.example/v1", api: "openai-responses", models: [] },
          },
        },
        tools: {
          media: {
            models: [{ provider: "openai", model: "video-model", capabilities: ["video"] }],
          },
        },
      },
    );
    expect(result.decision.outcome).toBe("success");
    expect(seenApiKey).toBe("test-key");
    expect(resolveAuth.mock.calls[0]?.[0].provider).toBe("openai");
    expect(resolveAuth.mock.calls[0]?.[0].modelApi).toBeUndefined();
  });
});

describe("runCapability provider output decisions", () => {
  it.each(["audio", "image"] as const)(
    "falls back after whitespace %s output",
    async (capability) => {
      const extension = capability === "image" ? "png" : "wav";
      const primary = vi.fn(async () => ({ text: " \t\n", model: "primary-model" }));
      const fallback = vi.fn(async () => ({
        text: "usable fallback output",
        model: "fallback-model",
      }));
      const createProvider = (id: string, run: typeof primary): MediaUnderstandingProvider => ({
        id,
        capabilities: [capability],
        ...(capability === "audio" ? { transcribeAudio: run } : { describeImage: run }),
      });
      await withMediaFixture(
        {
          filePrefix: "openclaw-provider-output",
          extension,
          mediaType: `${capability}/${extension}`,
          fileContents:
            capability === "image"
              ? Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAuMBg4n8tLwAAAAASUVORK5CYII=",
                  "base64",
                )
              : Buffer.alloc(2048, 1),
        },
        async ({ ctx, media, cache }) => {
          const providers = ["qa-primary", "qa-fallback"];
          const result = await runCapability({
            capability,
            cfg: {
              models: {
                providers: Object.fromEntries(
                  providers.map((id) => [
                    id,
                    { baseUrl: "https://media.example/v1", apiKey: "test-key", models: [] },
                  ]),
                ),
              },
              tools: {
                media: {
                  models: providers.map((provider) => ({
                    provider,
                    model: provider === "qa-primary" ? "primary-model" : "fallback-model",
                    capabilities: [capability],
                  })),
                },
              },
            },
            ctx,
            attachments: cache,
            media,
            agentDir: "/tmp/openclaw-media-provider-output-test",
            providerRegistry: new Map([
              ["qa-primary", createProvider("qa-primary", primary)],
              ["qa-fallback", createProvider("qa-fallback", fallback)],
            ]),
          });
          expect(primary).toHaveBeenCalledOnce();
          expect(fallback).toHaveBeenCalledOnce();
          expect(result.outputs.map((output) => output.text)).toEqual(["usable fallback output"]);
          expect(result.decision.outcome).toBe("success");
          expect(result.decision.attachments[0]?.attempts).toMatchObject([
            { provider: "qa-primary", outcome: "skipped", reason: "empty output" },
            { provider: "qa-fallback", outcome: "success" },
          ]);
        },
      );
    },
  );
});
