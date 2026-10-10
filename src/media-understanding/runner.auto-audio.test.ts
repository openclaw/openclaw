import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createWhisperExecutable } from "./local-audio.test-support.js";
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

function registry(providers: Record<string, MediaUnderstandingProvider>) {
  return new Map(Object.entries(providers));
}
function audioConfig(extra: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: { baseUrl: "https://api.openai.com/v1", apiKey: "test-key", models: [] },
      },
    },
    ...extra,
  };
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
    const { hasAvailableAuthForProvider } = await import("../agents/model-auth.js");
    const hasAuth = vi.mocked(hasAvailableAuthForProvider);
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
    try {
      const result = await runAudio({
        cfg: {},
        activeModel: { provider: "openai", model: "chat-model" },
        providerRegistry: registry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            defaultModels: { audio: "transcription-default" },
            transcribeAudioWithContext,
          },
        }),
      });
      expect(result.decision.outcome).toBe("success");
      expect(result.outputs[0]).toMatchObject({
        text: "subscription transcript",
        model: "transcription-default",
      });
      expect(transcribeAudioWithContext).toHaveBeenCalledTimes(1);
    } finally {
      hasAuth.mockReset().mockResolvedValue(true);
    }
  });

  it.each([false, true])(
    "retries failed uploads only with an explicit fallback list: %s",
    async (explicit) => {
      const { hasAvailableAuthForProvider } = await import("../agents/model-auth.js");
      const hasAuth = vi.mocked(hasAvailableAuthForProvider);
      hasAuth.mockClear();
      const rejected = new Error("Audio transcription failed (HTTP 403)");
      const transcribeAudio = vi.fn(async () => ({ text: "authored fallback transcript" }));
      const result = await runAudio({
        cfg: {
          models: {
            providers: {
              openai: { baseUrl: "https://api.openai.com/v1", models: [] },
              mistral: { baseUrl: "https://api.mistral.ai/v1", models: [] },
            },
          },
          ...(explicit
            ? {
                tools: {
                  media: {
                    models: [
                      { provider: "openai", capabilities: ["audio" as const] },
                      { provider: "mistral", capabilities: ["audio" as const] },
                    ],
                  },
                },
              }
            : {}),
        },
        activeModel: { provider: "openai", model: "chat-model" },
        providerRegistry: registry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            transcribeAudioWithContext: async () => {
              throw rejected;
            },
          },
          mistral: { id: "mistral", capabilities: ["audio"], transcribeAudio },
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
      }
    },
  );

  it("continues to local transcription when subscription preparation rejects the request", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auto-prepare-fallback-"));
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
    try {
      await createWhisperExecutable(binDir);
      await withAudioFixture("openclaw-auto-prepare-fallback", async ({ ctx, media, cache }) => {
        const result = await withEnvAsync(
          { PATH: binDir, SHERPA_ONNX_MODEL_DIR: undefined, WHISPER_CPP_MODEL: undefined },
          () =>
            runCapability({
              capability: "audio",
              ctx,
              media,
              attachments: cache,
              cfg: {
                models: {
                  providers: { openai: { baseUrl: "https://custom.example/v1", models: [] } },
                },
                tools: { media: { audio: { prompt: "Preserve names." } } },
              },
              activeModel: { provider: "openai", model: "chat-model" },
              providerRegistry: registry({
                openai: { id: "openai", capabilities: ["audio"], transcribeAudioWithContext },
              }),
            }),
        );
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
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("keeps missing credentials unavailable without recording a failed attempt", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auto-prepare-no-auth-"));
    const transcribeAudioWithContext = vi.fn(async () => ({
      ok: false as const,
      error: new ProviderAuthError("missing-provider-auth", "openai", "No configured credentials"),
    }));
    try {
      await withEnvAsync(
        { PATH: binDir, SHERPA_ONNX_MODEL_DIR: undefined, WHISPER_CPP_MODEL: undefined },
        async () => {
          const result = await runAudio({
            cfg: {},
            providerRegistry: registry({
              openai: {
                id: "openai",
                capabilities: ["audio"],
                autoPriority: { audio: 20 },
                transcribeAudioWithContext,
              },
            }),
          });
          expect(result.decision.outcome).toBe("skipped");
          expect(result.decision.attachments[0]?.attempts).toEqual([]);
          expect(transcribeAudioWithContext).toHaveBeenCalledTimes(1);
        },
      );
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("skips OpenAI audio auto-selection when only ChatGPT OAuth is available", async () => {
    const auth = await import("../agents/model-auth.js");
    const hasAuth = vi.mocked(auth.hasAvailableAuthForProvider);
    const resolveAuth = vi.mocked(auth.resolveApiKeyForProviderCore);
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
    try {
      const result = await runAudio({
        cfg: {
          models: {
            providers: {
              openai: { baseUrl: "https://api.openai.com/v1", models: [] },
              mistral: { baseUrl: "https://api.mistral.ai/v1", models: [] },
            },
          },
        },
        providerRegistry: registry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            defaultModels: { audio: "gpt-4o-transcribe" },
            transcribeAudio: openai,
          },
          mistral: {
            id: "mistral",
            capabilities: ["audio"],
            defaultModels: { audio: "voxtral-mini-latest" },
            transcribeAudio: mistral,
          },
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
    } finally {
      hasAuth.mockReset().mockResolvedValue(true);
      resolveAuth
        .mockReset()
        .mockResolvedValue({ apiKey: "test-key", source: "test", mode: "api-key" });
    }
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
          cfg: audioConfig(),
          ctx,
          media,
          attachments: cache,
          providerRegistry: buildProviderRegistry({
            openai: { id: "openai", capabilities: ["audio"], transcribeAudio },
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
      cfg: {
        models: { providers: { deepgram: provider } },
        tools: {
          media: {
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
        },
      },
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
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]?.text).toBe("ok");
    expect(seen?.baseUrl).toBe("https://entry.example");
    expect(seen?.headers).toStrictEqual({ ...providerHeaders, ...configHeaders, ...entryHeaders });
    expect(seen?.query).toStrictEqual({
      detect_language: false,
      punctuate: false,
      smart_format: true,
    });
    expect(seen?.query?.detectLanguage).toBeUndefined();
    expect(seen?.request).toEqual({
      headers: { "X-Config-Request": "cfg", "X-Entry-Request": "entry" },
      auth: { mode: "header", headerName: "x-config-auth", value: "cfg-secret" },
      tls: { serverName: "deepgram.internal" },
    });
  });
});
