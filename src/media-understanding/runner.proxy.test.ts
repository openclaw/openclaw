import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import type { OpenClawConfig } from "../config/types.js";
import { withAudioFixture, withVideoFixture } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest, VideoDescriptionRequest } from "./types.js";

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

let buildProviderRegistry: typeof import("./runner.js").buildProviderRegistry;
let clearMediaUnderstandingBinaryCacheForTests: typeof import("./runner.js").clearMediaUnderstandingBinaryCacheForTests;
let runCapability: typeof import("./runner.js").runCapability;

function createOpenAiAudioCfg(providerOverrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          apiKey: "test-key", // pragma: allowlist secret
          ...providerOverrides,
          models: [],
        },
      },
    },
    tools: {
      media: {
        audio: {
          enabled: true,
          models: [{ provider: "openai", model: "whisper-1" }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

async function runAudioCapabilityWithFetchCapture(params: {
  fixturePrefix: string;
  outputText: string;
}): Promise<typeof fetch | undefined> {
  let seenFetchFn: typeof fetch | undefined;
  await withAudioFixture(params.fixturePrefix, async ({ ctx, media, cache }) => {
    const providerRegistry = buildProviderRegistry({
      openai: {
        id: "openai",
        capabilities: ["audio"],
        transcribeAudio: async (req: AudioTranscriptionRequest) => {
          seenFetchFn = req.fetchFn;
          return { text: params.outputText, model: req.model };
        },
      },
    });

    const result = await runCapability({
      capability: "audio",
      cfg: createOpenAiAudioCfg(),
      ctx,
      attachments: cache,
      media,
      providerRegistry,
    });

    expect(result.outputs[0]?.text).toBe(params.outputText);
  });
  return seenFetchFn;
}

describe("runCapability proxy fetch passthrough", () => {
  beforeAll(async () => {
    ({ buildProviderRegistry, clearMediaUnderstandingBinaryCacheForTests, runCapability } =
      await import("./runner.js"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    clearMediaUnderstandingBinaryCacheForTests();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("passes fetchFn to audio provider when HTTPS_PROXY is set", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    const seenFetchFn = await runAudioCapabilityWithFetchCapture({
      fixturePrefix: "openclaw-audio-proxy",
      outputText: "transcribed",
    });
    expect(seenFetchFn).toBe(proxyFetchMocks.proxyFetch);
  });

  it("passes fetchFn to video provider when HTTPS_PROXY is set", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");

    await withVideoFixture("openclaw-video-proxy", async ({ ctx, media, cache }) => {
      let seenFetchFn: typeof fetch | undefined;

      const result = await runCapability({
        capability: "video",
        cfg: {
          models: {
            providers: {
              moonshot: {
                apiKey: "test-key", // pragma: allowlist secret
                models: [],
              },
            },
          },
          tools: {
            media: {
              video: {
                enabled: true,
                models: [{ provider: "moonshot", model: "kimi-k2.5" }],
              },
            },
          },
        } as unknown as OpenClawConfig,
        ctx,
        attachments: cache,
        media,
        providerRegistry: new Map([
          [
            "moonshot",
            {
              id: "moonshot",
              capabilities: ["video"],
              describeVideo: async (req: VideoDescriptionRequest) => {
                seenFetchFn = req.fetchFn;
                return { text: "video ok", model: req.model };
              },
            },
          ],
        ]),
      });

      expect(result.outputs[0]?.text).toBe("video ok");
      expect(seenFetchFn).toBe(proxyFetchMocks.proxyFetch);
    });
  });

  it("does not pass fetchFn when no proxy env vars are set", async () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");

    const seenFetchFn = await runAudioCapabilityWithFetchCapture({
      fixturePrefix: "openclaw-audio-no-proxy",
      outputText: "ok",
    });
    expect(seenFetchFn).toBeUndefined();
  });

  it("passes allowPrivateNetwork to audio provider when set in providerConfig.request", async () => {
    let seenRequest: AudioTranscriptionRequest["request"];

    await withAudioFixture("openclaw-audio-allowprivatenetwork", async ({ ctx, media, cache }) => {
      const providerRegistry = buildProviderRegistry({
        openai: {
          id: "openai",
          capabilities: ["audio"],
          transcribeAudio: async (req: AudioTranscriptionRequest) => {
            seenRequest = req.request;
            return { text: "ok", model: req.model };
          },
        },
      });

      const result = await runCapability({
        capability: "audio",
        cfg: createOpenAiAudioCfg({
          request: {
            allowPrivateNetwork: true,
          },
        }),
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expect(result.outputs[0]?.text).toBe("ok");
    });

    expect(seenRequest?.allowPrivateNetwork).toBe(true);
  });

  it("prefers exact provider config before normalized aliases", async () => {
    let seenBaseUrl: string | undefined;
    let seenRequest: AudioTranscriptionRequest["request"];

    await withAudioFixture(
      "openclaw-audio-exact-provider-config",
      async ({ ctx, media, cache }) => {
        const providerRegistry = buildProviderRegistry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            transcribeAudio: async (req: AudioTranscriptionRequest) => {
              seenBaseUrl = req.baseUrl;
              seenRequest = req.request;
              return { text: "ok", model: req.model };
            },
          },
        });

        const result = await runCapability({
          capability: "audio",
          cfg: {
            models: {
              providers: {
                OpenAI: {
                  apiKey: "alias-key", // pragma: allowlist secret
                  baseUrl: "http://alias.invalid/v1",
                  request: {
                    allowPrivateNetwork: true,
                  },
                  models: [],
                },
                openai: {
                  apiKey: "exact-key", // pragma: allowlist secret
                  models: [],
                },
              },
            },
            tools: {
              media: {
                audio: {
                  enabled: true,
                  models: [{ provider: "openai", model: "whisper-1" }],
                },
              },
            },
          } as unknown as OpenClawConfig,
          ctx,
          attachments: cache,
          media,
          providerRegistry,
        });

        expect(result.outputs[0]?.text).toBe("ok");
      },
    );

    expect(seenBaseUrl).toBeUndefined();
    expect(seenRequest?.allowPrivateNetwork).toBeUndefined();
  });

  it("passes allowPrivateNetwork to audio provider when set in top-level audio request", async () => {
    let seenRequest: AudioTranscriptionRequest["request"];

    await withAudioFixture(
      "openclaw-audio-top-level-allowprivatenetwork",
      async ({ ctx, media, cache }) => {
        const providerRegistry = buildProviderRegistry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            transcribeAudio: async (req: AudioTranscriptionRequest) => {
              seenRequest = req.request;
              return { text: "ok", model: req.model };
            },
          },
        });

        const result = await runCapability({
          capability: "audio",
          cfg: {
            models: {
              providers: {
                openai: {
                  apiKey: "test-key", // pragma: allowlist secret
                  models: [],
                },
              },
            },
            tools: {
              media: {
                audio: {
                  enabled: true,
                  request: {
                    allowPrivateNetwork: true,
                  },
                  models: [{ provider: "openai", model: "whisper-1" }],
                },
              },
            },
          } as unknown as OpenClawConfig,
          ctx,
          attachments: cache,
          media,
          providerRegistry,
        });

        expect(result.outputs[0]?.text).toBe("ok");
      },
    );

    expect(seenRequest?.allowPrivateNetwork).toBe(true);
  });

  it("uses synthetic local auth for loopback audio without resolving provider credentials", async () => {
    const modelAuth = await import("../agents/model-auth.js");

    let seenApiKey: string | undefined;

    await withAudioFixture("openclaw-audio-local-auth-fallback", async ({ ctx, media, cache }) => {
      const providerRegistry = buildProviderRegistry({
        openai: {
          id: "openai",
          capabilities: ["audio"],
          transcribeAudio: async (req: AudioTranscriptionRequest) => {
            seenApiKey = req.apiKey;
            return { text: "ok", model: req.model };
          },
        },
      });

      const result = await runCapability({
        capability: "audio",
        cfg: {
          models: {
            providers: {
              openai: {
                models: [],
              },
            },
          },
          tools: {
            media: {
              audio: {
                enabled: true,
                request: {
                  allowPrivateNetwork: true,
                },
                models: [
                  {
                    provider: "openai",
                    model: "whisper-1",
                    baseUrl: "http://127.0.0.1:8000/v1",
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expect(result.outputs[0]?.text).toBe("ok");
    });

    expect(seenApiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
    expect(modelAuth.resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("keeps request auth attached and skips real provider credentials for loopback audio", async () => {
    const modelAuth = await import("../agents/model-auth.js");

    let seenApiKey: string | undefined;
    let seenRequest: AudioTranscriptionRequest["request"];

    await withAudioFixture("openclaw-audio-local-request-auth", async ({ ctx, media, cache }) => {
      const providerRegistry = buildProviderRegistry({
        openai: {
          id: "openai",
          capabilities: ["audio"],
          transcribeAudio: async (req: AudioTranscriptionRequest) => {
            seenApiKey = req.apiKey;
            seenRequest = req.request;
            return { text: "ok", model: req.model };
          },
        },
      });

      const result = await runCapability({
        capability: "audio",
        cfg: {
          models: {
            providers: {
              openai: {
                apiKey: "actual-provider-key", // pragma: allowlist secret
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
                    model: "whisper-1",
                    baseUrl: "http://127.0.0.1:8000/v1",
                    request: {
                      allowPrivateNetwork: true,
                      auth: {
                        mode: "authorization-bearer",
                        token: "local-audio-token", // pragma: allowlist secret
                      },
                    },
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expect(result.outputs[0]?.text).toBe("ok");
    });

    expect(seenApiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
    expect(seenRequest?.auth).toEqual({
      mode: "authorization-bearer",
      token: "local-audio-token",
    });
    expect(modelAuth.resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("uses synthetic local auth for custom loopback audio providers", async () => {
    const modelAuth = await import("../agents/model-auth.js");

    let seenApiKey: string | undefined;

    await withAudioFixture("openclaw-audio-custom-local-auth", async ({ ctx, media, cache }) => {
      const providerRegistry = buildProviderRegistry({
        "local-whisper": {
          id: "local-whisper",
          capabilities: ["audio"],
          transcribeAudio: async (req: AudioTranscriptionRequest) => {
            seenApiKey = req.apiKey;
            return { text: "ok", model: req.model };
          },
        },
      });

      const result = await runCapability({
        capability: "audio",
        cfg: {
          tools: {
            media: {
              audio: {
                enabled: true,
                models: [
                  {
                    provider: "local-whisper",
                    model: "whisper-1",
                    baseUrl: "http://127.0.0.1:8000/v1",
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expect(result.outputs[0]?.text).toBe("ok");
    });

    expect(seenApiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
    expect(modelAuth.resolveApiKeyForProvider).not.toHaveBeenCalled();
  });
});
