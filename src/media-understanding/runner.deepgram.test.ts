// Deepgram runner tests cover provider options, headers, baseUrl overrides, and
// request transport merging.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

describe("runCapability deepgram provider options", () => {
  it("merges provider options, headers, and baseUrl overrides", async () => {
    await withAudioFixture("openclaw-deepgram", async ({ ctx, media, cache }) => {
      let seenQuery: Record<string, string | number | boolean> | undefined;
      let seenBaseUrl: string | undefined;
      let seenHeaders: Record<string, string> | undefined;
      let seenRequest:
        | import("../agents/provider-request-config.js").ProviderRequestTransportOverrides
        | undefined;

      const providerRegistry = buildProviderRegistry({
        deepgram: {
          id: "deepgram",
          capabilities: ["audio"],
          transcribeAudio: async (req) => {
            seenQuery = req.query;
            seenBaseUrl = req.baseUrl;
            seenHeaders = req.headers;
            seenRequest = req.request;
            return { text: "ok", model: req.model };
          },
        },
      });

      const cfg = {
        models: {
          providers: {
            deepgram: {
              baseUrl: "https://provider.example",
              apiKey: "test-key",
              headers: {
                "X-Provider": "1",
                "X-Provider-Managed": "secretref-managed",
              },
              models: [],
            },
          },
        },
        tools: {
          media: {
            audio: {
              enabled: true,
              baseUrl: "https://config.example",
              headers: {
                "X-Config": "2",
                "X-Config-Managed": "secretref-env:DEEPGRAM_HEADER_TOKEN",
              },
              request: {
                headers: {
                  "X-Config-Request": "cfg",
                },
                auth: {
                  mode: "header",
                  headerName: "x-config-auth",
                  value: "cfg-secret",
                },
              },
              providerOptions: {
                deepgram: {
                  detect_language: true,
                  punctuate: true,
                },
              },
              deepgram: { smartFormat: true },
              models: [
                {
                  provider: "deepgram",
                  model: "nova-3",
                  baseUrl: "https://entry.example",
                  headers: {
                    "X-Entry": "3",
                    "X-Entry-Managed": "secretref-managed",
                  },
                  request: {
                    headers: {
                      "X-Entry-Request": "entry",
                    },
                    tls: {
                      serverName: "deepgram.internal",
                    },
                  },
                  providerOptions: {
                    deepgram: {
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
      } as unknown as OpenClawConfig;

      const result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });
      expect(result.outputs).toHaveLength(1);
      const [output] = result.outputs;
      if (!output) {
        throw new Error("Expected Deepgram media output");
      }
      expect(output.text).toBe("ok");
      expect(seenBaseUrl).toBe("https://entry.example");
      expect(seenHeaders).toStrictEqual({
        "X-Provider": "1",
        "X-Provider-Managed": "secretref-managed",
        "X-Config": "2",
        "X-Config-Managed": "secretref-env:DEEPGRAM_HEADER_TOKEN",
        "X-Entry": "3",
        "X-Entry-Managed": "secretref-managed",
      });
      expect(seenQuery).toStrictEqual({
        detect_language: false,
        punctuate: false,
        smart_format: true,
      });
      expect((seenQuery as Record<string, unknown>)["detectLanguage"]).toBeUndefined();
      expect(seenRequest).toEqual({
        headers: {
          "X-Config-Request": "cfg",
          "X-Entry-Request": "entry",
        },
        auth: {
          mode: "header",
          headerName: "x-config-auth",
          value: "cfg-secret",
        },
        tls: {
          serverName: "deepgram.internal",
        },
      });
    });
  });
});

describe("runCapability audio diarization options", () => {
  it("maps providerOptions response_format/chunking_strategy to audio request fields and preserves segments", async () => {
    await withAudioFixture("openclaw-diarized-json", async ({ ctx, media, cache }) => {
      let seenResponseFormat: string | undefined;
      let seenChunkingStrategy: string | undefined;

      const providerRegistry = buildProviderRegistry({
        openai: {
          id: "openai",
          capabilities: ["audio"],
          transcribeAudio: async (req) => {
            seenResponseFormat = req.responseFormat;
            seenChunkingStrategy = req.chunkingStrategy;
            return {
              text: "Speaker A then Speaker B",
              model: req.model,
              segments: [
                { speaker: "A", start: 0, end: 1, text: "Speaker A" },
                { speaker: "B", start: 1, end: 2, text: "Speaker B" },
              ],
            };
          },
        },
      });

      const cfg = {
        models: {
          providers: {
            openai: {
              apiKey: "test-key",
              models: [],
            },
          },
        },
        tools: {
          media: {
            audio: {
              enabled: true,
              providerOptions: {
                openai: {
                  response_format: "diarized_json",
                  chunking_strategy: "auto",
                },
              },
              models: [
                {
                  provider: "openai",
                  model: "gpt-4o-transcribe-diarize",
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expect(seenResponseFormat).toBe("diarized_json");
      expect(seenChunkingStrategy).toBe("auto");
      expect(result.outputs[0]?.segments).toEqual([
        { speaker: "A", start: 0, end: 1, text: "Speaker A" },
        { speaker: "B", start: 1, end: 2, text: "Speaker B" },
      ]);
    });
  });

  it("omits the default audio prompt for OpenAI diarized transcription", async () => {
    await withAudioFixture(
      "openclaw-diarized-json-default-prompt",
      async ({ ctx, media, cache }) => {
        let seenPrompt: string | undefined;

        const providerRegistry = buildProviderRegistry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            transcribeAudio: async (req) => {
              seenPrompt = req.prompt;
              return { text: "ok", model: req.model };
            },
          },
        });

        const cfg = {
          models: {
            providers: {
              openai: {
                apiKey: "test-key",
                models: [],
              },
            },
          },
          tools: {
            media: {
              audio: {
                enabled: true,
                providerOptions: {
                  openai: {
                    response_format: "diarized_json",
                  },
                },
                models: [
                  {
                    provider: "openai",
                    model: "gpt-4o-transcribe-diarize",
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "audio",
          cfg,
          ctx,
          attachments: cache,
          media,
          providerRegistry,
        });

        expect(result.decision.outcome).toBe("success");
        expect(seenPrompt).toBeUndefined();
      },
    );
  });

  it("fails clearly before sending an explicit prompt to OpenAI diarized transcription", async () => {
    await withAudioFixture(
      "openclaw-diarized-json-explicit-prompt",
      async ({ ctx, media, cache }) => {
        const transcribeAudio = vi.fn(async (req) => ({ text: "ok", model: req.model }));

        const providerRegistry = buildProviderRegistry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            transcribeAudio,
          },
        });

        const cfg = {
          models: {
            providers: {
              openai: {
                apiKey: "test-key",
                models: [],
              },
            },
          },
          tools: {
            media: {
              audio: {
                enabled: true,
                _requestPromptOverride: "Focus on named speakers",
                providerOptions: {
                  openai: {
                    response_format: "diarized_json",
                  },
                },
                models: [
                  {
                    provider: "openai",
                    model: "gpt-4o-transcribe-diarize",
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "audio",
          cfg,
          ctx,
          attachments: cache,
          media,
          providerRegistry,
        });

        expect(result.outputs).toHaveLength(0);
        expect(result.decision.outcome).toBe("failed");
        expect(transcribeAudio).not.toHaveBeenCalled();
        expect(result.decision.attachments[0]?.attempts[0]?.reason).toMatch(
          /does not support prompt/,
        );
      },
    );
  });

  it("omits the default audio prompt for OpenAI Codex diarized transcription", async () => {
    await withAudioFixture(
      "openclaw-codex-diarized-json-default-prompt",
      async ({ ctx, media, cache }) => {
        let seenPrompt: string | undefined;

        const providerRegistry = buildProviderRegistry({
          "openai-codex": {
            id: "openai-codex",
            capabilities: ["audio"],
            transcribeAudio: async (req) => {
              seenPrompt = req.prompt;
              return { text: "ok", model: req.model };
            },
          },
        });

        const cfg = {
          models: {
            providers: {
              "openai-codex": {
                apiKey: "test-key",
                models: [],
              },
            },
          },
          tools: {
            media: {
              audio: {
                enabled: true,
                providerOptions: {
                  "openai-codex": {
                    response_format: "diarized_json",
                  },
                },
                models: [
                  {
                    provider: "openai-codex",
                    model: "gpt-4o-transcribe-diarize",
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "audio",
          cfg,
          ctx,
          attachments: cache,
          media,
          providerRegistry,
        });

        expect(result.decision.outcome).toBe("success");
        expect(seenPrompt).toBeUndefined();
      },
    );
  });

  it("fails clearly before sending an explicit prompt to OpenAI Codex diarized transcription", async () => {
    await withAudioFixture(
      "openclaw-codex-diarized-json-explicit-prompt",
      async ({ ctx, media, cache }) => {
        const transcribeAudio = vi.fn(async (req) => ({ text: "ok", model: req.model }));

        const providerRegistry = buildProviderRegistry({
          "openai-codex": {
            id: "openai-codex",
            capabilities: ["audio"],
            transcribeAudio,
          },
        });

        const cfg = {
          models: {
            providers: {
              "openai-codex": {
                apiKey: "test-key",
                models: [],
              },
            },
          },
          tools: {
            media: {
              audio: {
                enabled: true,
                _requestPromptOverride: "Focus on named speakers",
                providerOptions: {
                  "openai-codex": {
                    response_format: "diarized_json",
                  },
                },
                models: [
                  {
                    provider: "openai-codex",
                    model: "gpt-4o-transcribe-diarize",
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "audio",
          cfg,
          ctx,
          attachments: cache,
          media,
          providerRegistry,
        });

        expect(result.outputs).toHaveLength(0);
        expect(result.decision.outcome).toBe("failed");
        expect(transcribeAudio).not.toHaveBeenCalled();
        expect(result.decision.attachments[0]?.attempts[0]?.reason).toMatch(
          /does not support prompt/,
        );
      },
    );
  });

  it("keeps the default prompt for non-diarized OpenAI audio transcription", async () => {
    await withAudioFixture(
      "openclaw-non-diarized-default-prompt",
      async ({ ctx, media, cache }) => {
        let seenPrompt: string | undefined;

        const providerRegistry = buildProviderRegistry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            transcribeAudio: async (req) => {
              seenPrompt = req.prompt;
              return { text: "ok", model: req.model };
            },
          },
        });

        const cfg = {
          models: {
            providers: {
              openai: {
                apiKey: "test-key",
                models: [],
              },
            },
          },
          tools: {
            media: {
              audio: {
                enabled: true,
                models: [
                  {
                    provider: "openai",
                    model: "gpt-4o-transcribe",
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "audio",
          cfg,
          ctx,
          attachments: cache,
          media,
          providerRegistry,
        });

        expect(result.decision.outcome).toBe("success");
        expect(seenPrompt).toBe("Transcribe the audio.");
      },
    );
  });
});
