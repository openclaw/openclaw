import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RealtimeVoiceProviderResolveConfigContext } from "../../../talk/provider-contexts.js";
import { bindSessionRowProjection } from "../../session-row-projection-access.js";
import { roleClient, rolePolicyConfig } from "../../session-sharing.test-utils.js";
import { preparedTalkSessionProjection as projection } from "../test-helpers.js";
import {
  mocks,
  callTalkHandler,
  invokeTalkHandler,
  realtimeConfig,
  voiceCallConfig,
  voiceModelConfig,
  readClient,
  markTalkOwnerCold,
} from "./catalog.test-support.js";
import { expectRespondError, expectRespondOk, mockCallArg } from "./responses.test-support.js";

describe("talk.catalog handler", () => {
  it("returns only dictation availability to session-scoped callers", async () => {
    const config = rolePolicyConfig();
    const client = roleClient("view", "dictation-catalog");
    client.connect.scopes = ["operator.sessions.write"];
    const sessionKey = "agent:main:dictation-catalog";
    await mocks.resolveSessionKeyFromResolveParams.withImplementation(
      () => ({ ok: true, key: sessionKey }),
      async () => {
        const respond = await invokeTalkHandler("talk.catalog", {
          params: { sessionKey },
          config,
          client,
          context: {
            getRuntimeConfig: () => config,
            ...bindSessionRowProjection({}, () => projection),
          },
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          {
            modes: ["transcription"],
            transports: ["gateway-relay"],
            brains: ["none"],
            speech: { ready: false, providers: [] },
            realtime: { ready: false, providers: [] },
            transcription: { ready: expect.any(Boolean), providers: [] },
          },
          undefined,
        );
      },
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSpeechProviders.mockReturnValue([]);
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([]);
    mocks.listRealtimeVoiceProviders.mockReturnValue([]);
  });

  it("reads independent provider sections while speech availability is pending", async () => {
    const realtimeRead = createDeferred<boolean>();
    mocks.listSpeechProviders.mockReturnValue([
      {
        id: "speech",
        label: "Speech",
        isConfiguredAsync: () => realtimeRead.promise,
      },
    ] as never);
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      {
        id: "realtime",
        label: "Realtime",
        isConfigured: () => {
          realtimeRead.resolve(true);
          return true;
        },
      },
    ] as never);
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockRejectedValue(new Error("unavailable"));

    const respond = await invokeTalkHandler("talk.catalog", {
      config: realtimeConfig({ provider: "realtime" }),
    });
    expectRespondOk(respond, {
      speech: expect.objectContaining({
        providers: [expect.objectContaining({ id: "speech", configured: true })],
      }),
      realtime: expect.objectContaining({
        providers: [expect.objectContaining({ id: "realtime", configured: true })],
      }),
    });
  });

  it("rejects an ambiguous owner before discovering catalog providers", async () => {
    const respond = vi.fn();
    await mocks.listRealtimeTranscriptionProviders.withImplementation(
      () => {
        throw new Error("provider discovery failed");
      },
      () =>
        callTalkHandler("talk.catalog", {
          params: {},
          respond,
          config: {
            agents: { ownership: "explicit", entries: { primary: {}, voice: {} } },
          },
        }),
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining("Talk session ownership has no explicit owner"),
    });
    expect(mocks.canonicalizeSpeechProviderId).not.toHaveBeenCalled();
    expect(mocks.listRealtimeTranscriptionProviders).not.toHaveBeenCalled();
    expect(mocks.listRealtimeVoiceProviders).not.toHaveBeenCalled();
  });

  it.each([
    ["talk.catalog", {}],
    ["talk.client.create", { provider: "openai" }],
    ["talk.session.create", { mode: "realtime", transport: "gateway-relay", provider: "openai" }],
  ] as const)("isolates a cold realtime owner for %s", async (method, params) => {
    markTalkOwnerCold("talk:realtime");
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      {
        id: "openai",
        label: "Realtime",
        resolveConfig: () => {
          throw new Error("cold SecretRef");
        },
      },
    ] as never);

    const respond = await invokeTalkHandler(method, {
      params,
      config: realtimeConfig({ provider: "openai" }),
    });
    if (method === "talk.catalog") {
      expect(expectRespondOk(respond)).toMatchObject({
        realtime: { ready: false, providers: [{ configured: false }] },
      });
    } else {
      expectRespondError(respond, { code: ErrorCodes.UNAVAILABLE });
    }
  });

  it.each([[[]], [["transcribe-default", "transcribe-alternate"]]])(
    "returns safe catalogs with transcription models %j",
    async (models) => {
      function metadata() {
        const speech = {
          id: "elevenlabs",
          label: "ElevenLabs",
          aliases: ["11labs"],
          models: ["eleven_flash_v2_5"],
          voices: ["voice-1"],
        };
        const transcription = {
          id: "openai",
          label: "OpenAI Realtime Transcription",
          aliases: ["openai-realtime"],
          defaultModel: "gpt-4o-transcribe",
        };
        const otherTranscription = {
          id: "deepgram",
          label: "Deepgram Realtime Transcription",
          aliases: ["deepgram-realtime"],
        };
        const realtime = {
          id: "google",
          label: "Google Live Voice",
          defaultModel: "gemini-live",
        };
        const otherRealtime = { id: "openai", label: "OpenAI Realtime" };
        const audio = () => [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }];
        const capabilities = {
          transports: ["provider-websocket", "gateway-relay"],
          inputAudioFormats: audio(),
          outputAudioFormats: audio(),
          supportsBrowserSession: true,
          supportsBargeIn: true,
          supportsToolCalls: true,
          supportsVideoFrames: true,
          supportsSessionResumption: true,
        };
        return { speech, transcription, otherTranscription, realtime, otherRealtime, capabilities };
      }
      const { speech, transcription, otherTranscription, realtime, otherRealtime, capabilities } =
        metadata();
      const expected = metadata();
      mocks.listSpeechProviders.mockReturnValue([
        { ...speech, isConfigured: vi.fn(() => true) } as never,
      ]);
      mocks.listRealtimeTranscriptionProviders.mockReturnValue([
        {
          ...transcription,
          models,
          resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
          isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "stt-key"),
        } as never,
        {
          ...otherTranscription,
          resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
          isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "deepgram-key"),
        } as never,
      ]);
      mocks.listRealtimeVoiceProviders.mockReturnValue([
        {
          ...realtime,
          capabilities,
          resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
          isConfigured: vi.fn(
            ({ providerConfig }) =>
              providerConfig.apiKey === "live-key" &&
              providerConfig.project === "base" &&
              providerConfig.model === "talk-model",
          ),
          createBrowserSession: vi.fn(),
          createBridge: vi.fn(),
        } as never,
        {
          ...otherRealtime,
          resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
          isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "openai-key"),
          createBridge: vi.fn(),
        } as never,
      ]);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider: { id: "google" },
        providerConfig: { apiKey: "live-key", project: "base", model: "talk-model" },
        capabilities: expectDefined(
          mocks.listRealtimeVoiceProviders()[0],
          "configured realtime fixture",
        ).capabilities,
      } as never);

      const respond = await invokeTalkHandler("talk.catalog", {
        client: readClient(),
        config: {
          talk: {
            provider: "elevenlabs",
            providers: { elevenlabs: { apiKey: "speech-key" } },
            realtime: {
              provider: "google",
              providers: {
                google: { apiKey: "live-key", project: "base" },
              },
              model: "talk-model",
            },
          },
          ...voiceCallConfig({
            streaming: {
              provider: "openai-realtime",
              providers: { "openai-realtime": { apiKey: "stt-key" } },
            },
          }),
        } as OpenClawConfig,
      });

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          modes: ["realtime", "stt-tts", "transcription"],
          transports: ["webrtc", "provider-websocket", "gateway-relay", "managed-room"],
          brains: ["agent-consult", "direct-tools", "none"],
          speech: {
            activeProvider: "elevenlabs",
            providers: [
              {
                ...expected.speech,
                configured: true,
                modes: ["stt-tts"],
                brains: ["agent-consult"],
              },
            ],
          },
          transcription: {
            ready: true,
            activeProvider: "openai",
            providers: [
              {
                ...expected.transcription,
                configured: true,
                modes: ["transcription"],
                transports: ["gateway-relay"],
                brains: ["none"],
                ...(models?.length ? { models } : {}),
              },
              {
                ...expected.otherTranscription,
                configured: false,
                modes: ["transcription"],
                transports: ["gateway-relay"],
                brains: ["none"],
              },
            ],
          },
          realtime: {
            ready: true,
            activeProvider: "google",
            providers: [
              {
                ...expected.realtime,
                ...expected.capabilities,
                configured: true,
                modes: ["realtime"],
                brains: ["agent-consult"],
              },
              {
                ...expected.otherRealtime,
                configured: false,
                modes: ["realtime"],
                brains: ["agent-consult"],
                supportsBrowserSession: false,
              },
            ],
          },
        },
        undefined,
      );
      const responsePayload = JSON.stringify(mockCallArg(respond, 0, 1));
      expect(responsePayload).not.toContain("speech-key");
      expect(responsePayload).not.toContain("stt-key");
      expect(responsePayload).not.toContain("live-key");
    },
  );

  it.each([undefined, "gpt-realtime-2.1"])(
    "checks inactive provider readiness with its post-switch model %s",
    async (providerModel) => {
      const provider = {
        id: "openai",
        label: "OpenAI",
        resolveConfig: ({ rawConfig }: RealtimeVoiceProviderResolveConfigContext) => ({
          ...rawConfig,
          model: rawConfig.model ?? "gpt-live-1-codex",
        }),
        isConfigured: vi.fn(
          ({ providerConfig }: { providerConfig: { model: string } }) =>
            providerConfig.model === "gpt-live-1-codex",
        ),
        createBridge: vi.fn(),
        createBrowserSession: vi.fn(),
      };
      mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
      const respond = await invokeTalkHandler("talk.catalog", {
        client: readClient(),
        context: {
          getRuntimeConfig: () =>
            ({
              talk: {
                realtime: {
                  provider: "xai",
                  model: "grok-voice-latest",
                  transport: "gateway-relay",
                  providers: { openai: providerModel ? { model: providerModel } : {} },
                },
              },
            }) as OpenClawConfig,
        },
      });
      const catalog = expectRespondOk(respond) as {
        realtime: { providers: Array<Record<string, unknown>> };
      };
      expect(provider.isConfigured).toHaveBeenCalledWith(
        expect.objectContaining({
          providerConfig: expect.objectContaining({ model: providerModel ?? "gpt-live-1-codex" }),
        }),
      );
      expect(catalog.realtime.providers[0]).toMatchObject({ configured: !providerModel });
    },
  );

  it("emits realtime models and voices and mirrors create-time configured inputs", async () => {
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      defaultModel: "gpt-realtime-2.1",
      models: ["gpt-realtime-2.1"],
      voices: ["alloy", "marin"],
      resolveConfig: vi.fn(
        ({ rawConfig, agentId, surface }: RealtimeVoiceProviderResolveConfigContext) => ({
          ...rawConfig,
          model:
            rawConfig.model ??
            (agentId === "voice" && surface === "browser-session"
              ? "scoped-browser-default"
              : "legacy-default"),
        }),
      ),
      isConfigured: vi.fn(() => false),
      createBridge: vi.fn(),
      createBrowserSession: vi.fn(),
    };
    mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
      provider: { id: "openai" },
      providerConfig: { model: "gpt-live-test-canary" },
      capabilities: {
        transports: ["gateway-relay"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        voices: ["marin", "cedar"],
        voiceSelectionPolicy: "allowlist-default",
        modelFamilySettings: {
          family: "gpt-live",
          unlistedModelVoices: "active",
          unsupportedTransports: ["provider-websocket"],
          gatewayRelayHandlesAgentConsult: true,
          hint: {
            titleKey: "talkPage.gptLive.title",
            descriptionKey: "talkPage.gptLive.hint",
            readyKey: "talkPage.gptLive.ready",
          },
        },
      },
    } as never);

    const respond = await invokeTalkHandler("talk.catalog", {
      client: readClient(),
      context: {
        getRuntimeConfig: () =>
          ({
            talk: {
              agentId: "voice",
              realtime: {
                provider: "openai",
                providers: { openai: { model: "gpt-realtime-2.1" } },
                model: "gpt-live-test-canary",
              },
            },
          }) as OpenClawConfig,
      },
    });

    const catalog = expectRespondOk(respond) as {
      realtime: { providers: Array<Record<string, unknown>> };
    };
    expect(catalog.realtime.providers[0]).toMatchObject({
      defaultModel: "scoped-browser-default",
      models: ["gpt-realtime-2.1"],
      voices: ["alloy", "marin"],
      activeVoices: ["marin", "cedar"],
      activeVoiceSelectionPolicy: "allowlist-default",
      modelFamilySettings: {
        family: "gpt-live",
        unlistedModelVoices: "active",
        unsupportedTransports: ["provider-websocket"],
        gatewayRelayHandlesAgentConsult: true,
        hint: {
          titleKey: "talkPage.gptLive.title",
          descriptionKey: "talkPage.gptLive.hint",
          readyKey: "talkPage.gptLive.ready",
        },
      },
    });
    expect(JSON.stringify(catalog)).not.toContain("gpt-live-test-canary");
    // Catalog readiness must mirror talk.client.create: top-level
    // talk.realtime.model overrides the provider-level model and the resolved
    // agent scope is consulted, or GPT-Live over OAuth reads as unconfigured.
    expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfigOverrides: { model: "gpt-live-test-canary" },
        agentId: expect.any(String),
      }),
    );
    expect(catalog.realtime.providers[0]).toMatchObject({ configured: true });
  });

  it.each([undefined, "force-agent-consult"])(
    "resolves the relay catalog default for consult policy %s",
    async (consultRouting) => {
      const autoRespondToAudio = consultRouting !== "force-agent-consult";
      const expectedModel = autoRespondToAudio ? "relay-default" : "manual-relay-default";
      const azure = { endpoint: "https://example.openai.azure.com" };
      const isConfigured = vi.fn(({ providerConfig }) => providerConfig.model === expectedModel);
      const provider = {
        id: "relay",
        label: "Relay Voice",
        defaultModel: "legacy-default",
        resolveConfig: vi.fn(
          ({
            rawConfig,
            agentId,
            surface,
            autoRespondToAudio: autoRespond,
          }: RealtimeVoiceProviderResolveConfigContext) => ({
            ...rawConfig,
            model:
              agentId === "voice" && surface === "gateway-relay" && rawConfig.azure !== undefined
                ? autoRespond === false
                  ? "manual-relay-default"
                  : "relay-default"
                : "legacy-default",
          }),
        ),
        voices: ["relay-default"],
        isConfigured,
        capabilities: {
          transports: ["gateway-relay"],
          supportsToolCalls: true,
        },
        createBridge: vi.fn(),
      };
      mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider,
        providerConfig: { model: expectedModel, azure },
        capabilities: provider.capabilities,
      } as never);

      const respond = await invokeTalkHandler("talk.catalog", {
        id: "relay-catalog",
        client: readClient(),
        context: {
          getRuntimeConfig: () =>
            ({
              talk: {
                agentId: "voice",
                realtime: {
                  provider: "relay",
                  transport: "gateway-relay",
                  consultRouting,
                  providers: { relay: { azure } },
                },
              },
            }) as OpenClawConfig,
        },
      });

      expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "voice", surface: "gateway-relay", autoRespondToAudio }),
      );
      const catalog = expectRespondOk(respond);
      expect(catalog.realtime).toEqual(expect.objectContaining({ ready: true }));
      expect(catalog.realtime.providers[0]).toMatchObject({
        configured: true,
        defaultModel: expectedModel,
        voices: ["relay-default"],
      });
      expect(provider.resolveConfig).not.toHaveBeenCalled();
    },
  );

  it.each(["realtime-fast", "realtime-fast-alias"])(
    "reports the runtime-selected automatic providers and configured rows for %s",
    async (configKey) => {
      const transcriptionSlow = {
        id: "transcription-slow",
        label: "Transcription Slow",
        autoSelectOrder: 20,
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.enabled === true),
      };
      const transcriptionFast = {
        id: "transcription-fast",
        label: "Transcription Fast",
        models: ["transcribe-model"],
        autoSelectOrder: 10,
        isConfigured: vi.fn(
          ({ providerConfig }) =>
            providerConfig.enabled === true && providerConfig.model === "transcribe-model",
        ),
      };
      const realtimeSlow = {
        id: "realtime-slow",
        label: "Realtime Slow",
        autoSelectOrder: 20,
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.enabled === true),
        createBridge: vi.fn(),
      };
      const realtimeFast = {
        id: "realtime-fast",
        aliases: ["realtime-fast-alias"],
        label: "Realtime Fast",
        autoSelectOrder: 10,
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.enabled === true),
        createBridge: vi.fn(),
      };
      mocks.listRealtimeTranscriptionProviders.mockReturnValue([
        transcriptionSlow,
        transcriptionFast,
      ] as never);
      mocks.listRealtimeVoiceProviders.mockReturnValue([realtimeSlow, realtimeFast] as never);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider: realtimeFast,
        providerConfig: { enabled: true },
      } as never);

      const respond = await invokeTalkHandler("talk.catalog", {
        client: readClient(),
        config: {
          ...voiceModelConfig("transcription-fast/transcribe-model"),
          ...realtimeConfig({
            providers: {
              "realtime-slow": { enabled: true },
              [configKey]: { enabled: true },
            },
          }),
          ...voiceCallConfig({
            streaming: {
              providers: {
                "transcription-slow": { enabled: true },
                "transcription-fast": { enabled: true },
              },
            },
          }),
        } as OpenClawConfig,
      });

      expect(mockCallArg(respond, 0, 1)).toMatchObject({
        transcription: {
          ready: true,
          activeProvider: "transcription-fast",
          providers: [
            { id: "transcription-slow", configured: true },
            { id: "transcription-fast", configured: true },
          ],
        },
        realtime: {
          ready: true,
          activeProvider: "realtime-fast",
          providers: [
            { id: "realtime-slow", configured: true },
            { id: "realtime-fast", configured: true },
          ],
        },
      });
    },
  );

  it("includes a provider-map transcription provider missing from the active registry", async () => {
    const openai = {
      id: "openai",
      label: "OpenAI Realtime Transcription",
      isConfigured: vi.fn(() => false),
    };
    const xai = {
      id: "xai",
      label: "xAI Realtime Transcription",
      resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
      isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "xai-key"),
    };
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([openai] as never);
    mocks.getRealtimeTranscriptionProvider.mockImplementation((providerId: string | undefined) =>
      providerId === "xai" ? (xai as never) : undefined,
    );

    const respond = await invokeTalkHandler("talk.catalog", {
      client: readClient(),
      config: voiceCallConfig({
        streaming: {
          providers: { xai: { apiKey: "xai-key" } },
        },
      }) as OpenClawConfig,
    });

    expect(mockCallArg(respond, 0, 1)).toMatchObject({
      transcription: {
        ready: true,
        activeProvider: "xai",
        providers: [
          { id: "openai", configured: false },
          { id: "xai", configured: true },
        ],
      },
    });
  });

  it("reports the provider selected by runtime resolution when aliases collide", async () => {
    const transcriptionAlias = {
      id: "transcription-alias",
      label: "Transcription Alias",
      aliases: ["shared-transcription"],
      isConfigured: vi.fn(() => true),
    };
    const transcriptionDirect = {
      id: "shared-transcription",
      label: "Transcription Direct",
      isConfigured: vi.fn(() => true),
    };
    const realtimeAlias = {
      id: "realtime-alias",
      label: "Realtime Alias",
      aliases: ["shared-realtime"],
      isConfigured: vi.fn(() => true),
      createBridge: vi.fn(),
    };
    const realtimeDirect = {
      id: "shared-realtime",
      label: "Realtime Direct",
      isConfigured: vi.fn(() => true),
      createBridge: vi.fn(),
    };
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      transcriptionAlias,
      transcriptionDirect,
    ] as never);
    mocks.listRealtimeVoiceProviders.mockReturnValue([realtimeAlias, realtimeDirect] as never);
    mocks.canonicalizeRealtimeTranscriptionProviderId.mockReturnValueOnce("shared-transcription");
    mocks.canonicalizeRealtimeVoiceProviderId.mockReturnValueOnce("shared-realtime");
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
      provider: realtimeAlias,
      providerConfig: { enabled: true },
    } as never);

    const respond = await invokeTalkHandler("talk.catalog", {
      client: readClient(),
      config: {
        ...realtimeConfig({
          provider: "shared-realtime",
          providers: { "shared-realtime": { enabled: true } },
        }),
        ...voiceCallConfig({
          streaming: {
            provider: "shared-transcription",
            providers: { "shared-transcription": { enabled: true } },
          },
        }),
      } as OpenClawConfig,
    });

    expect(mockCallArg(respond, 0, 1)).toMatchObject({
      transcription: { ready: true, activeProvider: "transcription-alias" },
      realtime: { ready: true, activeProvider: "realtime-alias" },
    });
  });

  it.each([false, true])(
    "reports unavailable catalog providers with explicit selection=%s",
    async (explicit) => {
      mocks.listRealtimeTranscriptionProviders.mockReturnValue([
        { id: "transcription", label: "Transcription", isConfigured: vi.fn(() => false) },
      ] as never);
      mocks.listRealtimeVoiceProviders.mockReturnValue([
        {
          id: "realtime",
          label: "Realtime",
          isConfigured: vi.fn(() => false),
          createBridge: vi.fn(),
        },
      ] as never);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockImplementation(() => {
        throw new Error(
          explicit
            ? "Realtime provider is not configured"
            : "No realtime voice provider configured",
        );
      });

      const respond = await invokeTalkHandler("talk.catalog", {
        client: readClient(),
        config: explicit
          ? {
              ...realtimeConfig({ provider: "realtime" }),
              ...voiceCallConfig({ streaming: { provider: "transcription" } }),
            }
          : {},
      });
      const catalog = mockCallArg(respond, 0, 1) as Record<string, Record<string, unknown>>;
      for (const kind of ["transcription", "realtime"]) {
        expect(catalog[kind]).toMatchObject({ ready: false });
        if (explicit) {
          expect(catalog[kind]).toMatchObject({ activeProvider: kind });
        } else {
          expect(catalog[kind]).not.toHaveProperty("activeProvider");
        }
      }
    },
  );
});
