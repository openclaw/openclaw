import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import { hasAvailableAuthForProvider, resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { createProviderHttpError } from "../agents/provider-http-errors.js";
import type { OpenClawConfig } from "../config/types.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createWhisperExecutable } from "./local-audio.test-support.js";
import { formatDecisionSummary } from "./runner.entries.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture, withMediaFixture } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest, MediaUnderstandingProvider } from "./types.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});
vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

const hasAuth = vi.mocked(hasAvailableAuthForProvider);
const resolveAuth = vi.mocked(resolveApiKeyForProviderCore);
afterEach(() => {
  hasAuth.mockReset().mockResolvedValue(true);
  resolveAuth
    .mockReset()
    .mockResolvedValue({ apiKey: "test-key", source: "test", mode: "api-key" });
});
function mediaConfig(
  media: NonNullable<OpenClawConfig["tools"]>["media"],
  providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = remoteProviders,
): OpenClawConfig {
  return { models: { providers }, tools: { media } };
}

function registry(providers: Record<string, MediaUnderstandingProvider>) {
  return new Map(Object.entries(providers));
}
function audioProvider(
  id: string,
  options: Omit<MediaUnderstandingProvider, "id">,
): MediaUnderstandingProvider {
  return { id, capabilities: ["audio"], ...options };
}
const remoteProviders = {
  openai: { baseUrl: "https://api.openai.com/v1", models: [] },
  mistral: { baseUrl: "https://api.mistral.ai/v1", models: [] },
};
const activeModel = { provider: "openai", model: "chat-model" };
function withLocalTools(run: (binDir: string) => Promise<void>) {
  return withTestDir({ prefix: "openclaw-auto-prepare-" }, (binDir) =>
    withEnvAsync(
      { PATH: binDir, SHERPA_ONNX_MODEL_DIR: undefined, WHISPER_CPP_MODEL: undefined },
      () => run(binDir),
    ),
  );
}
type RunParams = Parameters<typeof runCapability>[0];
async function runAudio(
  params: Pick<RunParams, "cfg" | "providerRegistry"> &
    Partial<Pick<RunParams, "activeModel" | "request">>,
) {
  let result: Awaited<ReturnType<typeof runCapability>> | undefined;
  await withAudioFixture("openclaw-auto-audio", async ({ ctx, media, cache }) => {
    result = await runCapability({
      capability: "audio",
      ctx,
      media,
      attachments: cache,
      ...params,
    });
  });
  if (!result) {
    throw new Error("Expected audio result");
  }
  return result;
}

describe("runCapability audio", () => {
  it("auto-selects provider-owned audio with subscription auth and its audio default", async () => {
    hasAuth.mockImplementation(
      async (params) => params.provider === "openai" && params.modelApi === undefined,
    );
    const transcribeAudioWithContext = vi.fn(
      async (context: { model?: string; prompt?: string }) => {
        expect(context.prompt).toBeUndefined();
        expect(context.model).toBe("transcription-default");
        return { ok: true as const, value: { text: "subscription transcript" } };
      },
    );
    const result = await runAudio({
      cfg: {},
      activeModel,
      providerRegistry: registry({
        openai: audioProvider("openai", {
          defaultModels: { audio: "transcription-default" },
          transcribeAudioWithContext,
        }),
      }),
    });
    expect(result.decision.outcome).toBe("success");
    expect(result.outputs[0]).toMatchObject({
      text: "subscription transcript",
      model: "transcription-default",
    });
    expect(transcribeAudioWithContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    { explicit: false, withBody: true },
    { explicit: true, withBody: true },
    { explicit: false, withBody: false },
  ])(
    "retries failed uploads only with an explicit fallback list: $explicit, body: $withBody",
    async ({ explicit, withBody }) => {
      hasAuth.mockClear();
      const rejected = await createProviderHttpError(
        new Response(
          withBody ? JSON.stringify({ detail: "Synthetic provider response body" }) : null,
          {
            status: 403,
            headers: { "request-id": "synthetic-request-id" },
          },
        ),
        "Audio transcription failed",
        { statusPrefix: "HTTP " },
      );
      const transcribeAudio = vi.fn(async () => ({ text: "authored fallback transcript" }));
      const result = await runAudio({
        cfg: explicit
          ? mediaConfig({
              models: [
                { provider: "openai", capabilities: ["audio"] },
                { provider: "mistral", capabilities: ["audio"] },
              ],
            })
          : { models: { providers: remoteProviders } },
        activeModel,
        providerRegistry: registry({
          openai: audioProvider("openai", {
            transcribeAudioWithContext: async () => {
              throw rejected;
            },
          }),
          mistral: audioProvider("mistral", { transcribeAudio }),
        }),
      });
      expect(result.decision.outcome).toBe(explicit ? "success" : "failed");
      expect(result.decision.attachments[0]?.attempts[0]).toMatchObject({
        provider: "openai",
        outcome: "failed",
        reason: String(rejected),
      });
      expect(transcribeAudio).toHaveBeenCalledTimes(explicit ? 1 : 0);
      if (!explicit) {
        expect(result.outputs).toEqual([]);
        expect(hasAuth).not.toHaveBeenCalled();
        expect(formatDecisionSummary(result.decision)).toBe(
          "audio: failed (0/1) reason=Audio transcription failed (HTTP 403)",
        );
      }
    },
  );

  it("continues to local transcription when subscription preparation rejects the request", async () => {
    const rejected = new Error(
      "This subscription route cannot use the configured endpoint or prompt.",
    );
    const transcribeAudioWithContext = vi.fn(
      async (context: { baseUrl?: string; prompt?: string }) => {
        expect(context.baseUrl).toBe("https://custom.example/v1");
        expect(context.prompt).toBe("Preserve names.");
        return { ok: false as const, error: rejected };
      },
    );
    await withAudioFixture("openclaw-auto-prepare-fallback", async ({ ctx, media, cache }) => {
      await withLocalTools(async (binDir) => {
        await createWhisperExecutable(binDir);
        const result = await runCapability({
          capability: "audio",
          ctx,
          media,
          attachments: cache,
          cfg: mediaConfig(
            { audio: { prompt: "Preserve names." } },
            { openai: { baseUrl: "https://custom.example/v1", models: [] } },
          ),
          activeModel,
          providerRegistry: registry({
            openai: audioProvider("openai", { transcribeAudioWithContext }),
          }),
        });
        expect(result.decision.outcome).toBe("success");
        expect(result.outputs[0]?.text).toBe("mocked-local-whisper");
        expect(result.decision.attachments[0]?.attempts).toContainEqual(
          expect.objectContaining({
            provider: "openai",
            outcome: "failed",
            reason: String(rejected),
          }),
        );
        expect(transcribeAudioWithContext).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("keeps missing credentials unavailable without recording a failed attempt", async () => {
    const transcribeAudioWithContext = vi.fn(async () => ({
      ok: false as const,
      error: new ProviderAuthError("missing-provider-auth", "openai", "No configured credentials"),
    }));
    await withLocalTools(async () => {
      const result = await runAudio({
        cfg: {},
        providerRegistry: registry({
          openai: audioProvider("openai", {
            autoPriority: { audio: 20 },
            transcribeAudioWithContext,
          }),
        }),
      });
      expect(result.decision.outcome).toBe("skipped");
      expect(result.decision.attachments[0]?.attempts).toEqual([]);
      expect(transcribeAudioWithContext).toHaveBeenCalledTimes(1);
    });
  });

  it("skips OpenAI audio auto-selection when only ChatGPT OAuth is available", async () => {
    hasAuth.mockImplementation(async ({ provider, modelApi }) =>
      provider === "openai" ? modelApi === undefined : provider === "mistral",
    );
    resolveAuth.mockImplementation(async ({ provider }) => ({
      apiKey: `${provider}-key`,
      source: "test",
      mode: "api-key",
    }));
    const openai = vi.fn(async () => ({ text: "openai" }));
    const mistral = vi.fn(async (req: AudioTranscriptionRequest) => ({
      text: `mistral:${req.apiKey}`,
      model: req.model,
    }));
    const result = await runAudio({
      cfg: { models: { providers: remoteProviders } },
      providerRegistry: registry({
        openai: audioProvider("openai", {
          defaultModels: { audio: "gpt-4o-transcribe" },
          transcribeAudio: openai,
        }),
        mistral: audioProvider("mistral", {
          defaultModels: { audio: "voxtral-mini-latest" },
          transcribeAudio: mistral,
        }),
      }),
    });
    expect(result.decision.outcome).toBe("success");
    expect(result.outputs).toEqual([
      {
        kind: "audio.transcription",
        attachmentIndex: 0,
        provider: "mistral",
        model: "voxtral-mini-latest",
        text: "mistral:mistral-key",
      },
    ]);
    expect(openai).not.toHaveBeenCalled();
    expect(mistral).toHaveBeenCalledTimes(1);
    expect(hasAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", modelApi: "openai-audio-transcriptions" }),
    );
  });

  it("skips tiny audio before calling the provider", async () => {
    const transcribeAudio = vi.fn(async () => ({ text: "should not happen" }));
    await withMediaFixture(
      {
        filePrefix: "openclaw-tiny-audio",
        extension: "wav",
        mediaType: "audio/wav",
        fileContents: Buffer.alloc(100),
      },
      async ({ ctx, media, cache }) => {
        const result = await runCapability({
          capability: "audio",
          cfg: {
            models: { providers: { openai: { ...remoteProviders.openai, apiKey: "test-key" } } },
          },
          ctx,
          media,
          attachments: cache,
          providerRegistry: buildProviderRegistry({
            openai: audioProvider("openai", { transcribeAudio }),
          }),
        });
        expect(transcribeAudio).not.toHaveBeenCalled();
        expect(result.outputs).toEqual([]);
        expect(result.decision).toMatchObject({
          outcome: "skipped",
          attachments: [
            {
              attachmentIndex: 0,
              attempts: [{ outcome: "skipped", reason: expect.stringContaining("tooSmall") }],
            },
          ],
        });
      },
    );
  });
});

describe("runCapability provider options", () => {
  it("merges provider, capability and entry transport options", async () => {
    const providerHeaders = { "X-Provider": "1", "X-Provider-Managed": "secretref-managed" };
    const configHeaders = {
      "X-Config": "2",
      "X-Config-Managed": "secretref-env:DEEPGRAM_HEADER_TOKEN",
    };
    const entryHeaders = { "X-Entry": "3", "X-Entry-Managed": "secretref-managed" };
    const provider = {
      baseUrl: "https://provider.example",
      apiKey: "test-key",
      headers: providerHeaders,
      models: [],
    };
    let seen: AudioTranscriptionRequest | undefined;
    const result = await runAudio({
      cfg: mediaConfig(
        {
          audio: {
            enabled: true,
            baseUrl: "https://config.example",
            headers: configHeaders,
            request: {
              headers: { "X-Config-Request": "cfg" },
              auth: { mode: "header", headerName: "x-config-auth", value: "cfg-secret" },
            },
            providerOptions: { deepgram: { detect_language: true, punctuate: true } },
          },
          models: [
            {
              provider: "deepgram",
              model: "nova-3",
              capabilities: ["audio"],
              baseUrl: "https://entry.example",
              headers: entryHeaders,
              request: {
                headers: { "X-Entry-Request": "entry" },
                tls: { serverName: "deepgram.internal" },
              },
              providerOptions: {
                deepgram: {
                  ["__proto__"]: "ignored",
                  detectLanguage: false,
                  punctuate: false,
                  smart_format: true,
                },
              },
            },
          ],
        },
        { deepgram: provider },
      ),
      providerRegistry: buildProviderRegistry({
        deepgram: {
          id: "deepgram",
          capabilities: ["audio"],
          transcribeAudio: async (request) => {
            seen = request;
            return { text: "ok", model: request.model };
          },
        },
      }),
    });
    expect(result.outputs).toMatchObject([{ text: "ok" }]);
    expect({
      baseUrl: seen?.baseUrl,
      headers: seen?.headers,
      query: seen?.query,
      request: seen?.request,
    }).toStrictEqual({
      baseUrl: "https://entry.example",
      headers: { ...providerHeaders, ...configHeaders, ...entryHeaders },
      query: { detect_language: false, punctuate: false, smart_format: true },
      request: {
        headers: { "X-Config-Request": "cfg", "X-Entry-Request": "entry" },
        auth: { mode: "header", headerName: "x-config-auth", value: "cfg-secret" },
        tls: { serverName: "deepgram.internal" },
      },
    });
  });
});
