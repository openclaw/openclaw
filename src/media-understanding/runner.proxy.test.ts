import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest } from "./types.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

const proxyFetchMocks = vi.hoisted(() => {
  const proxyFetch = vi.fn() as unknown as typeof fetch;
  const resolveProxyFetchFromEnv = vi.fn((env: NodeJS.ProcessEnv = process.env) => {
    const hasProxy = Boolean(
      env.https_proxy?.trim() ||
      env.HTTPS_PROXY?.trim() ||
      env.http_proxy?.trim() ||
      env.HTTP_PROXY?.trim(),
    );
    return hasProxy ? proxyFetch : undefined;
  });
  return { proxyFetch, resolveProxyFetchFromEnv };
});

vi.mock("../infra/net/proxy-fetch.js", () => ({
  resolveProxyFetchFromEnv: proxyFetchMocks.resolveProxyFetchFromEnv,
}));

async function runAudio(request?: { allowPrivateNetwork: boolean }) {
  let seenRequest: AudioTranscriptionRequest | undefined;
  const openai = { baseUrl: "https://audio.example/v1", apiKey: "test-key", request, models: [] };
  await withAudioFixture("openclaw-audio-proxy", async ({ ctx, media, cache }) => {
    const result = await runCapability({
      capability: "audio",
      cfg: {
        models: { providers: { openai } },
        tools: {
          media: {
            models: [{ provider: "openai", model: "whisper-1", capabilities: ["audio"] }],
            audio: { enabled: true },
          },
        },
      },
      ctx,
      attachments: cache,
      media,
      providerRegistry: buildProviderRegistry({
        openai: {
          id: "openai",
          capabilities: ["audio"],
          transcribeAudio: async (req) => {
            seenRequest = req;
            return { text: "transcribed", model: req.model };
          },
        },
      }),
    });
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]?.text).toBe("transcribed");
  });
  return expectDefined(seenRequest, "audio request");
}

describe("runCapability proxy fetch passthrough", () => {
  it("passes fetchFn to audio provider when HTTPS_PROXY is set", async () => {
    await withEnvAsync({ HTTPS_PROXY: "http://proxy.test:8080" }, async () => {
      expect((await runAudio()).fetchFn).toBe(proxyFetchMocks.proxyFetch);
    });
  });

  it("passes allowPrivateNetwork to audio provider when set in providerConfig.request", async () => {
    expect((await runAudio({ allowPrivateNetwork: true })).request?.allowPrivateNetwork).toBe(true);
  });
});
