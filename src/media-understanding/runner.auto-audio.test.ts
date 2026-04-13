import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest, MediaUnderstandingProvider } from "./types.js";

type HasAvailableAuthForProviderFn =
  typeof import("../agents/model-auth.js").hasAvailableAuthForProvider;
type ResolveApiKeyForProviderFn = typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
type RequireApiKeyFn = typeof import("../agents/model-auth.js").requireApiKey;

const modelAuthMocks = vi.hoisted(() => ({
  hasAvailableAuthForProvider: vi.fn<HasAvailableAuthForProviderFn>(async () => true),
  resolveApiKeyForProvider: vi.fn<ResolveApiKeyForProviderFn>(async () => ({
    apiKey: "test-key",
    source: "test",
    mode: "api-key" as const,
  })),
  requireApiKey: vi.fn<RequireApiKeyFn>((auth) => auth.apiKey ?? "test-key"),
}));

vi.mock("../agents/model-auth.js", () => ({
  hasAvailableAuthForProvider: modelAuthMocks.hasAvailableAuthForProvider,
  resolveApiKeyForProvider: modelAuthMocks.resolveApiKeyForProvider,
  requireApiKey: modelAuthMocks.requireApiKey,
}));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

function createProviderRegistry(
  providers: Record<string, MediaUnderstandingProvider>,
): Map<string, MediaUnderstandingProvider> {
  // Keep these tests focused on auto-entry selection instead of paying the full
  // plugin capability registry build for every stub provider setup.
  return new Map(Object.entries(providers));
}

function createOpenAiAudioProvider(
  transcribeAudio: (req: AudioTranscriptionRequest) => Promise<{ text: string; model: string }>,
) {
  return createProviderRegistry({
    openai: {
      id: "openai",
      capabilities: ["audio"],
      transcribeAudio,
    },
  });
}

function createOpenAiAudioCfg(extra?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          apiKey: "test-key",
          models: [],
        },
      },
    },
    ...extra,
  } as unknown as OpenClawConfig;
}

async function runAutoAudioCase(params: {
  transcribeAudio: (req: AudioTranscriptionRequest) => Promise<{ text: string; model: string }>;
  cfgExtra?: Partial<OpenClawConfig>;
}) {
  let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
  await withAudioFixture("openclaw-auto-audio", async ({ ctx, media, cache }) => {
    const providerRegistry = createOpenAiAudioProvider(params.transcribeAudio);
    const cfg = createOpenAiAudioCfg(params.cfgExtra);
    runResult = await runCapability({
      capability: "audio",
      cfg,
      ctx,
      attachments: cache,
      media,
      providerRegistry,
    });
  });
  if (!runResult) {
    throw new Error("Expected auto audio case result");
  }
  return runResult;
}

describe("runCapability auto audio entries", () => {
  it("uses provider keys to auto-enable audio transcription", async () => {
    let seenModel: string | undefined;
    const result = await runAutoAudioCase({
      transcribeAudio: async (req) => {
        seenModel = req.model;
        return { text: "ok", model: req.model ?? "unknown" };
      },
    });
    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenModel).toBe("gpt-4o-transcribe");
    expect(result.decision.outcome).toBe("success");
  });

  it("skips auto audio when disabled", async () => {
    const result = await runAutoAudioCase({
      transcribeAudio: async () => ({
        text: "ok",
        model: "whisper-1",
      }),
      cfgExtra: {
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      },
    });
    expect(result.outputs).toHaveLength(0);
    expect(result.decision.outcome).toBe("disabled");
  });

  it("prefers explicitly configured audio model entries", async () => {
    let seenModel: string | undefined;
    const result = await runAutoAudioCase({
      transcribeAudio: async (req) => {
        seenModel = req.model;
        return { text: "ok", model: req.model ?? "unknown" };
      },
      cfgExtra: {
        tools: {
          media: {
            audio: {
              models: [{ provider: "openai", model: "whisper-1" }],
            },
          },
        },
      },
    });

    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenModel).toBe("whisper-1");
  });

  it("lets per-request transcription hints override configured model-entry hints", async () => {
    let seenLanguage: string | undefined;
    let seenPrompt: string | undefined;
    const result = await runAutoAudioCase({
      transcribeAudio: async (req) => {
        seenLanguage = req.language;
        seenPrompt = req.prompt;
        return { text: "ok", model: req.model ?? "unknown" };
      },
      cfgExtra: {
        tools: {
          media: {
            audio: {
              enabled: true,
              prompt: "configured prompt",
              language: "fr",
              _requestPromptOverride: "Focus on names",
              _requestLanguageOverride: "en",
              models: [
                {
                  provider: "openai",
                  model: "whisper-1",
                  prompt: "entry prompt",
                  language: "de",
                },
              ],
            },
          },
        },
      } as Partial<OpenClawConfig>,
    });

    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenLanguage).toBe("en");
    expect(seenPrompt).toBe("Focus on names");
  });

  it("tries later key-backed providers when an override-only provider is considered available but fails at execution time", async () => {
    modelAuthMocks.hasAvailableAuthForProvider.mockImplementation(
      async (params: Parameters<HasAvailableAuthForProviderFn>[0]) =>
        params.provider === "openai"
          ? params.runtimeOverrideRegistrationIsAvailable === true
          : params.provider === "mistral",
    );
    modelAuthMocks.resolveApiKeyForProvider.mockImplementation(
      async (params: Parameters<ResolveApiKeyForProviderFn>[0]) => {
        if (params.provider === "openai") {
          throw new Error("broker unavailable");
        }
        return {
          apiKey: "mistral-test-key",
          source: "test",
          mode: "api-key" as const,
        };
      },
    );

    try {
      let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
      await withAudioFixture(
        "openclaw-auto-audio-runtime-override-fallback",
        async ({ ctx, media, cache }) => {
          const providerRegistry = createProviderRegistry({
            openai: {
              id: "openai",
              capabilities: ["audio"],
              transcribeAudio: async () => ({
                text: "openai",
                model: "gpt-4o-transcribe",
              }),
            },
            mistral: {
              id: "mistral",
              capabilities: ["audio"],
              transcribeAudio: async (req) => ({
                text: "mistral",
                model: req.model ?? "unknown",
              }),
            },
          });
          const cfg = {
            models: {
              providers: {
                openai: {
                  models: [],
                },
                mistral: {
                  apiKey: "mistral-test-key", // pragma: allowlist secret
                  models: [],
                },
              },
            },
            tools: {
              media: {
                audio: {
                  enabled: true,
                },
              },
            },
          } as unknown as OpenClawConfig;

          runResult = await runCapability({
            capability: "audio",
            cfg,
            ctx,
            attachments: cache,
            media,
            providerRegistry,
          });
        },
      );

      if (!runResult) {
        throw new Error("Expected auto audio fallback result");
      }
      expect(runResult.decision.outcome).toBe("success");
      expect(runResult.outputs[0]?.provider).toBe("mistral");
      expect(runResult.outputs[0]?.text).toBe("mistral");
      expect(
        runResult.decision.attachments[0]?.attempts.map((attempt) => attempt.provider),
      ).toEqual(["openai", "mistral"]);
      expect(runResult.decision.attachments[0]?.attempts[0]?.outcome).toBe("failed");
      expect(runResult.decision.attachments[0]?.attempts[1]?.outcome).toBe("success");
    } finally {
      modelAuthMocks.hasAvailableAuthForProvider.mockReset();
      modelAuthMocks.hasAvailableAuthForProvider.mockImplementation(async () => true);
      modelAuthMocks.resolveApiKeyForProvider.mockReset();
      modelAuthMocks.resolveApiKeyForProvider.mockImplementation(async () => ({
        apiKey: "test-key",
        source: "test",
        mode: "api-key" as const,
      }));
    }
  });

  it("uses mistral when only mistral key is configured", async () => {
    const isolatedAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-agent-"));
    let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
    try {
      await withEnvAsync(
        {
          OPENAI_API_KEY: undefined,
          GROQ_API_KEY: undefined,
          DEEPGRAM_API_KEY: undefined,
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
          MISTRAL_API_KEY: "mistral-test-key", // pragma: allowlist secret
          OPENCLAW_AGENT_DIR: isolatedAgentDir,
          PI_CODING_AGENT_DIR: isolatedAgentDir,
        },
        async () => {
          await withAudioFixture("openclaw-auto-audio-mistral", async ({ ctx, media, cache }) => {
            const providerRegistry = createProviderRegistry({
              openai: {
                id: "openai",
                capabilities: ["audio"],
                transcribeAudio: async () => ({
                  text: "openai",
                  model: "gpt-4o-transcribe",
                }),
              },
              mistral: {
                id: "mistral",
                capabilities: ["audio"],
                transcribeAudio: async (req) => ({
                  text: "mistral",
                  model: req.model ?? "unknown",
                }),
              },
            });
            const cfg = {
              models: {
                providers: {
                  mistral: {
                    apiKey: "mistral-test-key", // pragma: allowlist secret
                    models: [],
                  },
                },
              },
              tools: {
                media: {
                  audio: {
                    enabled: true,
                  },
                },
              },
            } as unknown as OpenClawConfig;

            runResult = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              providerRegistry,
            });
          });
        },
      );
    } finally {
      await fs.rm(isolatedAgentDir, { recursive: true, force: true });
    }
    if (!runResult) {
      throw new Error("Expected auto audio mistral result");
    }
    expect(runResult.decision.outcome).toBe("success");
    expect(runResult.outputs[0]?.provider).toBe("mistral");
    expect(runResult.outputs[0]?.model).toBe("voxtral-mini-latest");
    expect(runResult.outputs[0]?.text).toBe("mistral");
  });
});
