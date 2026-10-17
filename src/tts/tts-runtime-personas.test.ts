import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { discoverConfigSecretTargetsByIds } from "../secrets/target-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createMockSpeechProvider,
  getTtsPersona,
  getTtsProviderAsync,
  installSpeechProviders,
  isTtsProviderConfiguredAsync,
  prepareSynthesisMock,
  requireAttempt,
  requireFirstCallParam,
  requireFirstSynthesisRequest,
  requireRecord,
  resetTtsRuntime,
  resolveTtsConfig,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  synthesizeSpeech,
  textToSpeechTelephony,
  withTtsPayload,
  type OpenClawConfig,
  type SpeechTelephonySynthesisRequest,
  type TtsConfig,
} from "./tts-runtime.test-support.js";

function personaConfig(
  persona: NonNullable<TtsConfig["personas"]>[string],
  overrides: TtsConfig = {},
): OpenClawConfig {
  return {
    tts: {
      enabled: true,
      provider: "mock",
      persona: "alfred",
      personas: { alfred: persona },
      ...overrides,
    },
  };
}

describe("TTS runtime persona behavior", () => {
  it("passes directive overrides to telephony synthesis providers", async () => {
    const synthesizeTelephonyMock = vi.fn(async (_request: SpeechTelephonySynthesisRequest) => ({
      audioBuffer: Buffer.from("voice"),
      outputFormat: "pcm",
      sampleRate: 24_000,
    }));
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        synthesizeTelephony: synthesizeTelephonyMock,
      }),
    ]);

    const text = "## Keep [telephony Markdown](https://example.com) raw!!!!!";
    const result = await textToSpeechTelephony({
      text,
      cfg: {
        tts: {
          enabled: true,
          provider: "mock",
          providers: { mock: { modelId: "telephony-model", voiceId: "default-voice" } },
        },
      },
      overrides: {
        providerOverrides: {
          mock: { speakerVoice: "directed-voice", speed: 1.5 },
        },
      },
    });

    expect(result).toMatchObject({
      success: true,
      providerModel: "telephony-model",
      providerVoice: "directed-voice",
    });
    expect(synthesizeTelephonyMock).toHaveBeenCalledOnce();
    const telephonyRequest = synthesizeTelephonyMock.mock.calls[0]?.[0];
    expect(telephonyRequest?.providerOverrides).toEqual({
      speakerVoice: "directed-voice",
      speed: 1.5,
    });
    expect(telephonyRequest?.text).toBe(text);
    expect(telephonyRequest).not.toHaveProperty("target");
  });

  afterEach(() => {
    resetTtsRuntime();
    clearSecretsRuntimeSnapshot();
  });

  it("selects persona preferred provider before config fallback", async () => {
    const cfg = personaConfig({ provider: "mock" }, { provider: "other" });
    const config = resolveTtsConfig(cfg);
    const prefsPath = "/tmp/openclaw-speech-core-persona-provider.json";

    expect(getTtsPersona(config, prefsPath)?.id).toBe("alfred");
    expect(await getTtsProviderAsync(config, prefsPath)).toBe("mock");
  });

  it("treats provider configuration errors as unconfigured", async () => {
    installSpeechProviders([
      createMockSpeechProvider("broken", {
        resolveConfig: () => {
          throw new Error("invalid provider URL");
        },
      }),
    ]);
    const prefsPath = "/tmp/openclaw-speech-core-invalid-provider.json";
    setTtsMachinePrefsPathResolver(() => prefsPath);
    const cfg: OpenClawConfig = { tts: { providers: { broken: {} } } };
    const config = resolveTtsConfig(cfg);

    expect(await isTtsProviderConfiguredAsync(config, "broken", cfg)).toBe(false);
    expect(await getTtsProviderAsync(config, prefsPath)).toBe("");
  });

  it("uses async availability for synthesis without invoking the legacy probe", async () => {
    const isConfigured = vi.fn(() => {
      throw new Error("sync availability must not run");
    });
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        isConfigured,
        isConfiguredAsync: async () => true,
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Synthesis uses the async provider availability contract.",
      cfg: { tts: { provider: "mock" } },
    });

    expect(result.success).toBe(true);
    expect(synthesizeMock).toHaveBeenCalledOnce();
    expect(isConfigured).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "resolves persona secrets without credential fallback (available: %s)",
    async (available) => {
      await withOpenClawTestState({ label: "tts-persona-secrets" }, async (state) => {
        if (!available) {
          await import("./tts.js");
        }
        const ref = {
          source: "env",
          provider: "default",
          id: available ? "TEST_TTS_PERSONA_KEY" : "TEST_TTS_MISSING_PERSONA_KEY",
        } as const;
        const expectedKey = "persona-fixture-key";
        const persona = available ? "reader.uk" : "reader";
        const personas = {
          [persona]: {
            ...(available ? { provider: "mock" } : {}),
            providers: { mock: { ...(available ? { voice: "persona-voice" } : {}), apiKey: ref } },
          },
        };
        const tts: TtsConfig = {
          provider: "mock",
          persona,
          providers: {
            mock: available
              ? {
                  apiKey: { source: "env", provider: "default", id: "TEST_TTS_BASE_KEY" },
                  model: "base-model",
                }
              : { apiKey: "other-fixture-key" },
          },
        };
        if (available) {
          tts.auto = "off";
        } else {
          tts.personas = personas;
        }
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          tts,
          ...(available ? { agents: { entries: { reader: { tts: { personas } } } } } : {}),
        };
        if (available) {
          installSpeechProviders([
            createMockSpeechProvider("mock", {
              isConfigured: ({ providerConfig }) => providerConfig.apiKey === expectedKey,
            }),
          ]);
        }
        const snapshot = await prepareSecretsRuntimeSnapshot({
          config: cfg,
          env: available
            ? {
                TEST_TTS_BASE_KEY: "base-fixture-key",
                TEST_TTS_PERSONA_KEY: expectedKey,
              }
            : {},
          agentDirs: [state.agentDir()],
          includeAuthStoreRefs: false,
          manifestRegistry: { plugins: [] },
          ...(available ? {} : { allowUnavailableSecretOwners: true }),
        });
        if (!available) {
          activateSecretsRuntimeSnapshot(snapshot);
        }
        const synthesis = synthesizeSpeech({
          text: "Read this fixture.",
          cfg: snapshot.config,
          ...(available ? { agentId: "reader" } : {}),
          prefsPath: state.path("tts-prefs.json"),
          disableFallback: true,
        });
        if (!available) {
          await expect(synthesis).rejects.toMatchObject({
            code: "SECRET_SURFACE_UNAVAILABLE",
            ownerId: "tts",
          });
          expect(snapshot.config.tts?.personas?.reader?.providers?.mock?.apiKey).toEqual(ref);
          expect(synthesizeMock).not.toHaveBeenCalled();
          return;
        }
        expect(await synthesis).toMatchObject({ success: true, audioBuffer: Buffer.from("voice") });
        expect(requireFirstSynthesisRequest("resolved persona").providerConfig).toMatchObject({
          apiKey: expectedKey,
          model: "base-model",
          voice: "persona-voice",
        });
        expect(snapshot.sourceConfig).toEqual(cfg);
        expect(snapshot.warnings).toEqual([]);
        expect(
          discoverConfigSecretTargetsByIds(
            cfg,
            new Set(["agents.entries.*.tts.personas.*.providers.*.apiKey"]),
          ),
        ).toMatchObject([
          {
            providerId: "mock",
            path: 'agents.entries.reader.tts.personas["reader.uk"].providers.mock.apiKey',
          },
        ]);
      });
    },
  );

  it.each([
    { telephony: false, provider: "missing", reasonCode: "no_provider_registered", success: true },
    { telephony: true, provider: "mock", reasonCode: "unsupported_for_telephony", success: false },
  ])(
    "omits personaBinding when skipping $provider ($reasonCode)",
    async ({ telephony, provider, reasonCode, success }) => {
      const synthesize = telephony ? textToSpeechTelephony : synthesizeSpeech;
      const result = await synthesize({
        text: "Use the available fallback.",
        cfg: personaConfig({ providers: { [provider]: { voice: "persona-voice" } } }, { provider }),
      });
      expect(result.success).toBe(success);
      const attempt = requireAttempt(result.attempts, 0);
      expect(attempt).toMatchObject({
        provider,
        outcome: "skipped",
        reasonCode,
        persona: "alfred",
      });
      expect(attempt).not.toHaveProperty("personaBinding");
    },
  );

  it("uses provider defaults when fallback policy allows missing persona bindings", async () => {
    await synthesizeSpeech({
      text: "Use neutral provider defaults.",
      cfg: personaConfig({ fallbackPolicy: "provider-defaults" }),
    });

    expect(prepareSynthesisMock).toHaveBeenCalledOnce();
    const prepareContext = requireRecord(
      requireFirstCallParam(prepareSynthesisMock.mock.calls, "prepare synthesis"),
      "prepare synthesis context",
    );
    expect(prepareContext.persona).toBeUndefined();
    expect(prepareContext.personaProviderConfig).toBeUndefined();
  });

  it("skips unbound providers under fail policy while allowing bound fallbacks", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", { autoSelectOrder: 1 }),
      createMockSpeechProvider("fallback", { autoSelectOrder: 2 }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use the first persona-bound provider.",
      cfg: personaConfig({
        fallbackPolicy: "fail",
        providers: { fallback: { voice: "fallback-voice" } },
      }),
    });

    expect(result).toMatchObject({ success: true, provider: "fallback", fallbackFrom: "mock" });
    expect(requireAttempt(result.attempts, 0)).toMatchObject({
      provider: "mock",
      outcome: "skipped",
      reasonCode: "not_configured",
      persona: "alfred",
      personaBinding: "missing",
      error: "mock: persona alfred has no provider binding",
    });
    expect(requireAttempt(result.attempts, 1)).toMatchObject({
      provider: "fallback",
      outcome: "success",
      persona: "alfred",
      personaBinding: "applied",
    });
  });
});

describe("TTS runtime per-agent config", () => {
  it("composes per-agent TTS overrides with active persona bindings", async () => {
    const cfg: OpenClawConfig = {
      ...personaConfig(
        {},
        {
          providers: { mock: { model: "base-model", voice: "base-voice" } },
          personas: {
            alfred: { provider: "mock", providers: { mock: { voice: "alfred-voice" } } },
            jarvis: { provider: "mock", providers: { mock: { style: "jarvis-style" } } },
          },
        },
      ),
      agents: {
        entries: {
          reader: {
            tts: {
              persona: "jarvis",
              providers: { mock: { voice: "agent-voice" } },
            },
          },
        },
      },
    };

    await withTtsPayload(
      {
        payload: { text: "This agent reply should use the composed persona config." },
        cfg,
        channel: "slack",
        kind: "final",
        agentId: "reader",
      },
      (result) => {
        expect(synthesizeMock).toHaveBeenCalled();
        const request = requireFirstSynthesisRequest("agent persona synthesis request");
        const providerConfig = requireRecord(
          request.providerConfig,
          "agent persona provider config",
        );
        expect(providerConfig).toMatchObject({
          model: "base-model",
          voice: "agent-voice",
          style: "jarvis-style",
        });
        expect(result.mediaUrl).toMatch(/voice---[a-f0-9-]+\.ogg$/);
      },
    );
  });
});
