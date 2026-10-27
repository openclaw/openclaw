import { expectDefined } from "@openclaw/normalization-core/expect";
/** Tests for talk gateway methods that coordinate speech and audio providers. */
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS } from "../../../agents/realtime-bootstrap-context.test-support.js";
import { resolveCommandAuthorization } from "../../../auto-reply/command-auth.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { captureRuntimeConfigWithSource } from "../../../config/runtime-config-capture-state.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../../../config/runtime-source-projection.js";
import {
  normalizeResolvedSecretInputString,
  type SecretInput,
} from "../../../config/types.secrets.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { setActiveDegradedSecretOwners } from "../../../secrets/runtime-degraded-state.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { prepareUserProfileCatalog } from "../../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { resolveRealtimeVoiceAgentConsultToolsAllow } from "../../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../talk/describe-view-tool.js";
import type { RealtimeVoiceProviderResolveConfigContext } from "../../../talk/provider-types.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { resolveChatSendCallerContext } from "../../server-methods/gateway-client-identity.js";
import { fixedStoreOwnershipConfig } from "../../server-methods/sessions-fixed-store.test-support.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { gatewayProfile } from "../../server/client-fixtures.test-support.js";
import { bindSessionRowProjection } from "../../session-row-projection-access.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "../../test-helpers.rpc-source.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { preparedTalkSessionProjection as projection } from "../test-helpers.js";
import { createBrowserProvider, createBrowserSessionMock } from "./client-fixtures.test-support.js";
import { forgetLegacyVoiceBinding } from "./client-legacy-voice-bindings.js";
import { createBrowserConsultOwnerFixture } from "./client-owner.test-support.js";
import { talkConfigAccentCases } from "./config-accent.test-support.js";
import {
  createTalkConfig,
  defineRealtimeConfigProjectionTests,
  type TalkConfigProjectionResponse,
} from "./config-realtime.test-support.js";
import { createTalkHandlerCaller } from "./handler-invocation.test-support.js";
import { talkHandlers } from "./index.js";
import {
  expectRecordFields,
  expectRespondError,
  expectRespondOk,
  expectSessionEntryEnsure,
  mockCallArg,
} from "./responses.test-support.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  getCanonicalUserPreferences: vi.fn<
    () => Promise<{ profileId: string; entries: Record<string, unknown> } | undefined>
  >(async () => undefined),
  projectConfigOntoRuntimeSourceSnapshot: vi.fn<(config: OpenClawConfig) => OpenClawConfig>(),
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => providerId),
  getSpeechProvider: vi.fn(),
  listSpeechProviders: vi.fn(() => []),
  synthesizeSpeech: vi.fn(),
  canonicalizeRealtimeVoiceProviderId: vi.fn((providerId: string | undefined) =>
    providerId === "gemini-live" ? "google" : providerId?.trim().toLowerCase(),
  ),
  listRealtimeVoiceProviders: vi.fn<() => RealtimeVoiceProviderPlugin[]>(() => []),
  canonicalizeRealtimeTranscriptionProviderId: vi.fn((providerId: string | undefined) =>
    providerId === "openai-realtime" ? "openai" : providerId?.trim().toLowerCase(),
  ),
  getRealtimeTranscriptionProvider: vi.fn(),
  listRealtimeTranscriptionProviders: vi.fn(() => []),
  resolveConfiguredRealtimeVoiceProviderAsync: vi.fn(),
  isRealtimeVoiceProviderConfiguredAsync: vi.fn(
    async ({
      provider,
      cfg,
      providerConfig,
    }: {
      provider: {
        isConfigured: (ctx: { cfg?: unknown; providerConfig: unknown }) => boolean;
      };
      cfg?: unknown;
      providerConfig: unknown;
    }) => provider.isConfigured({ cfg, providerConfig }),
  ),
  resolveRealtimeVoiceProviderCapabilitiesAsync: vi.fn(
    ({ provider }: { provider: { capabilities?: unknown } }) => provider.capabilities,
  ),
  resolveInternalRealtimeVoiceGatewayRelayLaunchError: vi.fn(),
  cancelInternalRealtimeVoiceBrowserSession: vi.fn(async () => undefined),
  createTalkRealtimeRelaySession: vi.fn(),
  sendTalkRealtimeRelayAudio: vi.fn(),
  acknowledgeTalkRealtimeRelayMark: vi.fn(),
  cancelTalkRealtimeRelayTurn: vi.fn(),
  stopTalkRealtimeRelaySession: vi.fn(),
  registerTalkRealtimeRelayAgentRun: vi.fn(
    async ({
      registerVoice,
      assertCurrent,
    }: {
      registerVoice?: (
        assertCurrent: () => void,
        physicalSource: undefined,
        onRegistered: (release: () => void) => void,
      ) => Promise<void>;
      assertCurrent?: () => void;
    }) => {
      let release = () => {};
      await registerVoice?.(assertCurrent ?? (() => {}), undefined, (registeredRelease) => {
        release = registeredRelease;
      });
      return {
        run: { runId: "run-voice-1", sessionKey: "agent:main:main" },
        release,
        isCurrent: () => true,
        abortIfCurrent: () => {},
      };
    },
  ),
  flushTalkRealtimeRelayVoiceWrites: vi.fn(async () => undefined),
  ensureTalkRealtimeRelayVoiceSession: vi.fn(),
  submitTalkRealtimeRelayToolResult: vi.fn(),
  createTalkTranscriptionRelaySession: vi.fn(),
  sendTalkTranscriptionRelayAudio: vi.fn(),
  stopTalkTranscriptionRelaySession: vi.fn(),
  chatSend: vi.fn(),
  controlRealtimeVoiceAgentRun: vi.fn(),
  steerTalkRealtimeRelayAgentRun: vi.fn(),
  resolveSessionKeyFromResolveParams: vi.fn(),
  resolveRealtimeVoiceAgentContextInstructions: vi.fn(async (): Promise<string> => ""),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-agent-workspace"),
  readSessionPreviewItemsFromTranscriptAsync: vi.fn(() => [
    { role: "user", text: "Earlier question" },
    { role: "assistant", text: "Earlier answer" },
    { role: "tool", text: "internal tool output" },
  ]),
  closeStaleClientVoiceSessions: vi.fn(async () => 0),
  createOrResumeClientVoiceSession: vi.fn<
    typeof import("../../../talk/client-voice-session.js").createOrResumeClientVoiceSession
  >(async () => "voice-test"),
  ensureClientVoiceAgentSessionEntry: vi.fn(async () => "session-main"),
  resolveClientVoiceAgentSessionId: vi
    .fn<() => Promise<string | undefined>>()
    .mockResolvedValue("session-main"),
  assertClientVoiceSessionOpen: vi.fn(),
  registerClientVoiceConsultRun: vi.fn(
    ({ onRegistered }: { onRegistered?: (release: () => void) => void }) => {
      const release = () => {};
      onRegistered?.(release);
      return release;
    },
  ),
  resolveOpenClientVoiceSessionId: vi.fn(),
  consultRealtimeVoiceAgent: vi.fn(async (_params?: unknown) => ({ text: "agent answer" })),
  closeTalkClientGatewayControlSession: vi.fn(async () => false),
  gatewayControlActivate: vi.fn(),
  gatewayControlAdoptProvider: vi.fn(async () => undefined),
  gatewayControlClose: vi.fn(async () => undefined),
  gatewayControl: { bindBridge: vi.fn(), bindControl: vi.fn() },
  createTalkClientGatewayControlOwner: vi.fn(),
  agentRuntime: {},
}));

vi.mock("../../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/config.js")>()),
  projectConfigOntoRuntimeSourceSnapshot: mocks.projectConfigOntoRuntimeSourceSnapshot,
}));

vi.mock("../../../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/user-preferences.js")>()),
  getCanonicalUserPreferences: mocks.getCanonicalUserPreferences,
}));

vi.mock("../../../tts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tts/provider-registry.js")>()),
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
  listSpeechProviders: mocks.listSpeechProviders,
}));

// mock-isolation: Keep synthesis stubbed while using real settings/readiness without barrel initialization.
vi.mock("../../../tts/tts.js", async () => ({
  isTtsProviderConfiguredAsync: (await import("../../../tts/tts-provider-resolution.js"))
    .isTtsProviderConfiguredAsync,
  resolveTtsConfig: (await import("../../../tts/tts-settings.js")).resolveTtsConfig,
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

vi.mock("../../../tts/tts-synthesis.js", () => ({ synthesizeTalkSpeech: mocks.synthesizeSpeech }));

vi.mock("../../../talk/provider-registry.js", () => ({
  canonicalizeRealtimeVoiceProviderId: mocks.canonicalizeRealtimeVoiceProviderId,
  getRealtimeVoiceProvider: (providerId: string | undefined) =>
    mocks
      .listRealtimeVoiceProviders()
      .find((provider: { id: string }) => provider.id === providerId),
  listRealtimeVoiceProviders: mocks.listRealtimeVoiceProviders,
}));

vi.mock("../../../realtime-transcription/provider-registry.js", () => ({
  canonicalizeRealtimeTranscriptionProviderId: mocks.canonicalizeRealtimeTranscriptionProviderId,
  getRealtimeTranscriptionProvider: mocks.getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders: mocks.listRealtimeTranscriptionProviders,
}));

// mock-isolation: Keep provider registration and credential state outside handler tests.
vi.mock("../../../talk/provider-resolver.js", () => ({
  isRealtimeVoiceProviderConfiguredAsync: mocks.isRealtimeVoiceProviderConfiguredAsync,
  resolveConfiguredRealtimeVoiceProviderAsync: mocks.resolveConfiguredRealtimeVoiceProviderAsync,
  resolveRealtimeVoiceProviderCapabilitiesAsync:
    mocks.resolveRealtimeVoiceProviderCapabilitiesAsync,
}));

vi.mock("../../../talk/provider-internal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../talk/provider-internal.js")>();
  return {
    ...actual,
    cancelInternalRealtimeVoiceBrowserSession: mocks.cancelInternalRealtimeVoiceBrowserSession,
    resolveInternalRealtimeVoiceGatewayRelayLaunchError:
      mocks.resolveInternalRealtimeVoiceGatewayRelayLaunchError,
  };
});

vi.mock("../../../talk/agent-run-control.js", () => ({
  controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRun,
}));

vi.mock("../../../talk/agent-consult-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../talk/agent-consult-runtime.js")>();
  return {
    ...actual,
    consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
  };
});

vi.mock("../../../plugins/runtime/index.js", () => ({
  createPluginRuntime: () => ({ agent: mocks.agentRuntime }),
}));

vi.mock("../../../agents/realtime-bootstrap-context.js", () => ({
  resolveRealtimeVoiceAgentContextInstructions: mocks.resolveRealtimeVoiceAgentContextInstructions,
}));

vi.mock("../../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  };
});

vi.mock("../../session-transcript-preview.js", () => ({
  readSessionPreviewItemsFromTranscriptAsync: mocks.readSessionPreviewItemsFromTranscriptAsync,
}));

vi.mock("../../../talk/client-voice-session-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../talk/client-voice-session-read.js")>();
  return {
    ...actual,
    assertClientVoiceSessionOpen: mocks.assertClientVoiceSessionOpen,
    resolveClientVoiceAgentSessionId: mocks.resolveClientVoiceAgentSessionId,
    resolveOpenClientVoiceSessionId: mocks.resolveOpenClientVoiceSessionId,
  };
});

vi.mock("../../../talk/client-voice-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../talk/client-voice-session.js")>();
  return {
    ...actual,
    closeStaleClientVoiceSessions: mocks.closeStaleClientVoiceSessions,
    createOrResumeClientVoiceSession: mocks.createOrResumeClientVoiceSession,
    registerClientVoiceConsultRun: mocks.registerClientVoiceConsultRun,
  };
});

vi.mock("../../../talk/client-voice-session-write.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../talk/client-voice-session-write.js")>();
  return {
    ...actual,
    ensureClientVoiceAgentSessionEntry: mocks.ensureClientVoiceAgentSessionEntry,
    // Creation is mocked here; expose its supplied source without acquiring a database writer.
    captureClientVoiceSessionWriter: ({
      physicalSource,
    }: Parameters<typeof actual.captureClientVoiceSessionWriter>[0]) => ({
      source: expectDefined(physicalSource, "Mocked voice creation requires its admitted source"),
      release: () => {},
    }),
  };
});

// mock-isolation: Route trusted dispatch through the fixture without starting an agent run.
vi.mock("../../server-methods/chat-send-handler.js", async () => {
  const { createTrustedInternalChatSendFixture } =
    await import("./client-fixtures.test-support.js");
  return {
    handleChatSend: mocks.chatSend,
    handleTrustedInternalChatSend: createTrustedInternalChatSendFixture(mocks.chatSend),
  };
});

vi.mock("../../sessions-resolve.js", () => ({
  withPreparedSessionResolve: async (
    { isCurrent: _isCurrent, ...params }: Record<string, unknown>,
    consume: (result: unknown) => unknown,
  ) => consume(mocks.resolveSessionKeyFromResolveParams(params)),
}));

vi.mock("../relay/session-create.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relay/session-create.js")>()),
  createTalkRealtimeRelaySession: mocks.createTalkRealtimeRelaySession,
}));

vi.mock("../relay/operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relay/operations.js")>()),
  acknowledgeTalkRealtimeRelayMark: mocks.acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn: mocks.cancelTalkRealtimeRelayTurn,
  ensureTalkRealtimeRelayVoiceSession: mocks.ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites: mocks.flushTalkRealtimeRelayVoiceWrites,
  registerTalkRealtimeRelayAgentRun: mocks.registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio: mocks.sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun: mocks.steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession: mocks.stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult: mocks.submitTalkRealtimeRelayToolResult,
}));

vi.mock("../client-gateway-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client-gateway-control.js")>();
  return {
    ...actual,
    closeTalkClientGatewayControlSession: mocks.closeTalkClientGatewayControlSession,
    createTalkClientGatewayControlOwner: mocks.createTalkClientGatewayControlOwner,
  };
});

vi.mock("../transcription-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../transcription-relay.js")>();
  return {
    ...actual,
    createTalkTranscriptionRelaySession: mocks.createTalkTranscriptionRelaySession,
    sendTalkTranscriptionRelayAudio: mocks.sendTalkTranscriptionRelayAudio,
    stopTalkTranscriptionRelaySession: mocks.stopTalkTranscriptionRelaySession,
  };
});

function setSourceConfig(config: OpenClawConfig) {
  mocks.projectConfigOntoRuntimeSourceSnapshot.mockReturnValue(config);
}

const callTalkHandler = createTalkHandlerCaller(talkHandlers);

async function invokeTalkHandler(
  method: string,
  options: Omit<Parameters<typeof callTalkHandler>[1], "respond" | "params"> & {
    params?: Record<string, unknown>;
  } = {},
) {
  const respond = vi.fn();
  await callTalkHandler(method, { params: {}, ...options, respond });
  return respond;
}

function realtimeConfig(realtime: NonNullable<OpenClawConfig["talk"]>["realtime"]): OpenClawConfig {
  return { talk: { realtime } };
}

function voiceCallConfig(config: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { "voice-call": { config } } } };
}

function voiceModelConfig(primary: string): OpenClawConfig {
  return { agents: { defaults: { voiceModel: { primary } } } };
}

function realtimeProvider() {
  return {
    id: "openai",
    label: "OpenAI Realtime",
    isConfigured: () => true,
    createBridge: vi.fn(),
  };
}

function resolveRealtimeProvider(
  provider: ReturnType<typeof realtimeProvider>,
  providerConfig: Record<string, unknown>,
) {
  mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({ provider, providerConfig });
}

const readClient = () => ({ connect: { scopes: ["operator.read"] } });
const redactedSecretRef = {
  source: "__OPENCLAW_REDACTED__",
  provider: "__OPENCLAW_REDACTED__",
  id: "__OPENCLAW_REDACTED__",
};

function relaySession(relaySessionId: string, model: string, voice: string) {
  return {
    provider: "openai",
    transport: "gateway-relay",
    relaySessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
    model,
    voice,
    expiresAt: 1_797_986_400,
  };
}

function steeredRun(sessionKey: string) {
  return {
    ok: true,
    mode: "steer",
    sessionKey,
    sessionId: "session-active",
    active: true,
    queued: true,
    message: "Steered the active OpenClaw run.",
    speak: false,
    show: true,
    suppress: true,
  };
}

beforeEach(() => {
  mocks.createTalkClientGatewayControlOwner.mockImplementation((params) =>
    createBrowserConsultOwnerFixture(params, {
      activate: mocks.gatewayControlActivate,
      adoptProvider: mocks.gatewayControlAdoptProvider,
      close: mocks.gatewayControlClose,
      control: mocks.gatewayControl,
    }),
  );
  rpcSourceTesting.clear();
  setActiveDegradedSecretOwners([]);
  mocks.getRealtimeTranscriptionProvider.mockImplementation((providerId: string | undefined) => {
    const normalized = providerId?.trim().toLowerCase();
    const providers = mocks.listRealtimeTranscriptionProviders() as Array<{
      id: string;
      aliases?: string[];
    }>;
    return providers.find(
      (provider) =>
        provider.id.toLowerCase() === normalized ||
        provider.aliases?.some((alias) => alias.toLowerCase() === normalized),
    );
  });
});

function markTalkOwnerCold(ownerId: string): void {
  setActiveDegradedSecretOwners([
    {
      ownerKind: "capability",
      ownerId,
      state: "unavailable",
      paths: [],
      refKeys: [],
      reason: "secret reference was not found",
    },
  ]);
}

describe("talk.catalog handler", () => {
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

describe("talk.speak handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["talk:speech", "tts"])(
    "uses the runtime snapshot with cold owner %s",
    async (coldOwnerId) => {
      markTalkOwnerCold(coldOwnerId);
      const runtimeConfig = createTalkConfig("env-acme-key");
      runtimeConfig.talk = {
        provider: "acme",
        providers: {
          acme: {
            apiKey: "env-acme-key",
            speakerVoice: "talk-speaker",
            speakerVoiceId: "talk-speaker-id",
            voice: "explicit-talk-voice",
            voiceId: "explicit-talk-voice-id",
          },
        },
      };
      runtimeConfig.tts = {
        providers: {
          acme: {
            apiKey: { source: "env", provider: "default", id: "MISSING" },
            speakerVoice: "marin",
            speakerVoiceId: "voice-123",
          },
        },
      };
      const diskConfig = createTalkConfig({
        source: "env",
        provider: "default",
        id: "ACME_SPEECH_API_KEY",
      });

      mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
      setSourceConfig(diskConfig);
      mocks.getSpeechProvider.mockReturnValue({
        id: "acme",
        label: "Acme Speech",
        resolveTalkConfig: ({
          baseTtsConfig,
          talkProviderConfig,
        }: {
          baseTtsConfig: Record<string, unknown>;
          talkProviderConfig: Record<string, unknown>;
        }) => {
          expectRecordFields(talkProviderConfig, {
            speakerVoice: "talk-speaker",
            voice: "explicit-talk-voice",
            voiceName: "talk-speaker",
            speakerVoiceId: "talk-speaker-id",
            voiceId: "explicit-talk-voice-id",
          });
          expectRecordFields(expectRecordFields(baseTtsConfig.providers, {}).acme, {
            apiKey: "env-acme-key",
            speakerVoice: "marin",
            voice: "marin",
            voiceName: "marin",
            speakerVoiceId: "voice-123",
            voiceId: "voice-123",
          });
          return talkProviderConfig;
        },
      });
      mocks.synthesizeSpeech.mockImplementation(
        async ({ cfg }: { cfg: OpenClawConfig; text: string; disableFallback: boolean }) => {
          expect(cfg.tts?.provider).toBe("acme");
          expect(cfg.tts?.providers?.acme?.apiKey).toBe("env-acme-key");
          return {
            success: true,
            provider: "acme",
            audioBuffer: Buffer.from([1, 2, 3]),
            outputFormat: "mp3",
            voiceCompatible: false,
            fileExtension: ".mp3",
          };
        },
      );

      const respond = await invokeTalkHandler("talk.speak", {
        params: { text: "Hello from talk mode." },
        client: null,
        config: runtimeConfig,
      });

      if (coldOwnerId === "talk:speech") {
        expectRespondError(respond, { code: ErrorCodes.UNAVAILABLE });
        return;
      }
      expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
      expect(mocks.projectConfigOntoRuntimeSourceSnapshot).not.toHaveBeenCalled();
      expectRecordFields(mockCallArg(mocks.synthesizeSpeech), {
        text: "Hello from talk mode.",
        disableFallback: true,
      });
      expectRespondOk(respond, {
        provider: "acme",
        audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
        outputFormat: "mp3",
        mimeType: "audio/mpeg",
        fileExtension: ".mp3",
      });
    },
  );
});

describe("talk.config handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("projects the matching applied source and canonical runtime fields", async () => {
    const source: OpenClawConfig = {
      ...createTalkConfig({ source: "env", provider: "default", id: "SYNTHETIC_TALK_KEY" }),
      session: { mainKey: "ignored-legacy-key" },
      ui: { seamColor: "${SYNTHETIC_ACCENT}" },
    };
    const runtime = captureRuntimeConfigWithSource(
      {
        ...createTalkConfig("synthetic-applied-key"),
        session: { mainKey: "main" },
        ui: { seamColor: "#123456" },
      },
      source,
    );
    mocks.projectConfigOntoRuntimeSourceSnapshot.mockImplementationOnce(
      projectConfigOntoRuntimeSourceSnapshot,
    );
    mocks.getSpeechProvider.mockReturnValue({ id: "acme" });

    const respond = await invokeTalkHandler("talk.config", { config: runtime });
    expect(expectRespondOk(respond)).toMatchObject({
      config: {
        session: { mainKey: "main" },
        ui: { seamColor: "#123456" },
        talk: {
          providers: {
            acme: {
              apiKey: redactedSecretRef,
            },
          },
        },
      },
    });
    expect(JSON.stringify(respond.mock.calls)).not.toContain("synthetic-applied-key");
  });

  it.each([
    ["talk:speech", false, true],
    ["talk:speech", true, false],
    ["tts", true, true],
  ] as const)(
    "projects speech for owner=%s includeSecrets=%s",
    async (coldOwnerId, includeSecrets, ok) => {
      markTalkOwnerCold(coldOwnerId);
      const runtimeConfig = createTalkConfig(
        coldOwnerId === "tts"
          ? "healthy-talk-key"
          : { source: "env", provider: "default", id: "MISSING" },
      );
      mocks.getSpeechProvider.mockReturnValue({ id: "acme" });
      setSourceConfig(runtimeConfig);

      const respond = await invokeTalkHandler("talk.config", {
        params: { includeSecrets },
        client: { connect: { scopes: ["operator.read", "operator.talk.secrets"] } },
        config: runtimeConfig,
      });

      expect(respond.mock.calls[0]?.[0]).toBe(ok);
    },
  );

  it.each(talkConfigAccentCases)("$name", async ({ profileId, profileAccent, expectedAccent }) => {
    markTalkOwnerCold("tts");
    const runtimeConfig = {
      ...createTalkConfig("healthy-talk-key"),
      ui: { seamColor: "#123456", prefs: { accent: "#52c99a" } },
    };
    mocks.getSpeechProvider.mockReturnValue({ id: "acme" });
    mocks.getCanonicalUserPreferences.mockResolvedValue(
      profileId ? { profileId, entries: { "ui.accent": profileAccent } } : undefined,
    );
    setSourceConfig(runtimeConfig);

    const respond = await invokeTalkHandler("talk.config", {
      client: {
        connect: { scopes: ["operator.read"] },
        ...(profileId ? { authenticatedUserProfile: { profileId } } : {}),
      },
      config: runtimeConfig,
    });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]?.config?.ui).toEqual(
      expectedAccent ? { seamColor: expectedAccent } : undefined,
    );
    if (profileId) {
      expect(mocks.getCanonicalUserPreferences).toHaveBeenCalledWith(profileId, ["ui.accent"]);
    } else {
      expect(mocks.getCanonicalUserPreferences).not.toHaveBeenCalled();
    }
  });

  it.each<{
    name: string;
    runtimeConfig: OpenClawConfig;
    sourceConfig?: OpenClawConfig;
    expected: Record<string, unknown>;
    providerConfig?: Record<string, unknown>;
  }>([
    {
      name: "runtime transport absent from source",
      runtimeConfig: realtimeConfig({ transport: "provider-websocket" }),
      sourceConfig: {},
      expected: { transport: "provider-websocket" },
    },
    {
      name: "unavailable non-OpenAI model without a bundled projector",
      runtimeConfig: realtimeConfig({
        provider: "other-realtime",
        model: "other-live-model",
        providers: {
          "other-realtime": { model: "other-live-model", voice: "other-voice" },
        },
      }),
      expected: { provider: "other-realtime", model: "other-live-model" },
      providerConfig: { model: "other-live-model", voice: "other-voice" },
    },
  ])(
    "projects realtime config: $name",
    async ({ runtimeConfig, sourceConfig, expected, providerConfig }) => {
      setSourceConfig(sourceConfig ?? runtimeConfig);
      mocks.listRealtimeVoiceProviders.mockReturnValue([]);

      const respond = await invokeTalkHandler("talk.config", {
        client: readClient(),
        config: runtimeConfig,
      });
      const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
      const realtime = expectRecordFields(response.config?.talk?.realtime, expected);
      if (providerConfig) {
        expectRecordFields(
          (realtime.providers as Record<string, unknown>)["other-realtime"],
          providerConfig,
        );
      }
    },
  );

  defineRealtimeConfigProjectionTests(async (runtimeConfig, includeSecrets) => {
    setSourceConfig(runtimeConfig);
    mocks.listRealtimeVoiceProviders.mockReturnValue([]);

    const respond = await invokeTalkHandler("talk.config", {
      params: includeSecrets ? { includeSecrets: true } : {},
      client: {
        connect: {
          scopes: includeSecrets ? ["operator.read", "operator.talk.secrets"] : ["operator.read"],
        },
      },
      context: { getRuntimeConfig: () => runtimeConfig },
    });
    return expectRespondOk(respond) as TalkConfigProjectionResponse;
  });

  it("projects an automatically selected realtime provider without exposing secrets", async () => {
    const resolveConfig = vi.fn(
      ({ rawConfig }: { rawConfig: Record<string, unknown> }): Record<string, unknown> => ({
        ...rawConfig,
        apiKey: normalizeResolvedSecretInputString({
          value: rawConfig.apiKey,
          path: "talk.realtime.providers.openai.apiKey",
        }),
      }),
    );
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      {
        id: "openai",
        label: "OpenAI Realtime",
        models: ["gpt-realtime"],
        resolveConfig,
        isConfigured: ({ providerConfig }: { providerConfig: Record<string, unknown> }) =>
          providerConfig.apiKey === "runtime-azure-secret",
      },
    ] as never);
    const configWithKey = (apiKey: SecretInput): OpenClawConfig => ({
      ...voiceModelConfig("openai/gpt-realtime"),
      ...realtimeConfig({
        speakerVoice: "marin",
        speakerVoiceId: "voice-id",
        providers: {
          "other-realtime": {},
          " OpenAI ": {
            apiKey,
            azureEndpoint: "https://example.openai.azure.com",
            azureDeployment: "realtime-prod",
          },
        },
      }),
    });
    const sourceConfig = configWithKey({
      source: "env",
      provider: "default",
      id: "AZURE_OPENAI_API_KEY",
    });
    const runtimeConfig = configWithKey("runtime-azure-secret");
    setSourceConfig(sourceConfig);

    const respond = await invokeTalkHandler("talk.config", {
      client: readClient(),
      config: runtimeConfig,
    });

    const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
    const realtime = expectRecordFields(response.config?.talk?.realtime, {
      provider: "openai",
      model: "gpt-realtime",
      speakerVoice: "marin",
      speakerVoiceId: "voice-id",
    });
    expectRecordFields((realtime.providers as Record<string, unknown> | undefined)?.openai, {
      apiKey: redactedSecretRef,
      azureEndpoint: "https://example.openai.azure.com",
      azureDeployment: "realtime-prod",
    });
    expect(resolveConfig).toHaveBeenCalledOnce();
    expect(mockCallArg(resolveConfig)).toMatchObject({
      rawConfig: { apiKey: "runtime-azure-secret", model: "gpt-realtime" },
    });
    expect(JSON.stringify(response)).not.toContain("runtime-azure-secret");
    // Source values supply the wire projection; provider discovery belongs to runtime config.
    expect(mocks.listRealtimeVoiceProviders).not.toHaveBeenCalledWith(sourceConfig);
  });

  it("passes runtime-resolved tts provider secrets to strict provider resolvers", async () => {
    const configWithTts = (apiKey: SecretInput, timeoutMs: number): OpenClawConfig => ({
      talk: {
        provider: "acme",
        providers: {
          acme: {
            speakerVoice: "talk-speaker",
            speakerVoiceId: "talk-speaker-id",
            voice: "explicit-talk-voice",
            voiceId: "explicit-talk-voice-id",
          },
        },
      },
      tts: { provider: "acme", timeoutMs, providers: { acme: { apiKey } } },
    });
    const sourceConfig = configWithTts(
      { source: "env", provider: "default", id: "ACME_SPEECH_API_KEY" },
      12_345,
    );
    const runtimeConfig = configWithTts("env-acme-key", 54_321);

    setSourceConfig(sourceConfig);
    mocks.getSpeechProvider.mockReturnValue({
      id: "acme",
      label: "Acme Strict Speech",
      resolveTalkConfig: ({
        baseTtsConfig,
        talkProviderConfig,
        timeoutMs,
      }: {
        baseTtsConfig: Record<string, unknown>;
        talkProviderConfig: Record<string, unknown>;
        timeoutMs: number;
      }) => {
        const providers = (baseTtsConfig.providers ?? {}) as Record<string, unknown>;
        const providerConfig = (providers.acme ?? {}) as Record<string, unknown>;
        const apiKey = normalizeResolvedSecretInputString({
          value: providerConfig.apiKey,
          path: "tts.providers.acme.apiKey",
        });
        expect(apiKey).toBe("env-acme-key");
        expect(timeoutMs).toBe(54_321);
        expectRecordFields(talkProviderConfig, {
          speakerVoice: "talk-speaker",
          voice: "explicit-talk-voice",
          voiceName: "talk-speaker",
          speakerVoiceId: "talk-speaker-id",
          voiceId: "explicit-talk-voice-id",
        });
        return {
          ...talkProviderConfig,
          ...(apiKey === undefined ? {} : { apiKey }),
        };
      },
    });

    const respond = await invokeTalkHandler("talk.config", {
      client: readClient(),
      config: runtimeConfig,
    });

    const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
    const talkConfig = response.config?.talk;
    expectRecordFields(talkConfig, { provider: "acme" });
    const resolved = talkConfig?.resolved as Record<string, unknown> | undefined;
    expectRecordFields(resolved, { provider: "acme" });
    expectRecordFields(resolved?.config, { apiKey: "__OPENCLAW_REDACTED__" });
  });

  it.each(["refs", "raw", "resolver"])("projects Talk credentials safely from %s", async (kind) => {
    const multiProvider = kind === "refs" || kind === "raw";
    const raw = kind === "raw";
    const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });
    const fixtureKey = (runtime: boolean, label: string, id: string) =>
      runtime ? `runtime-${label}` : raw ? `source-${label}` : secretRef(id);
    const configWithKeys = (runtime: boolean): OpenClawConfig => ({
      talk: {
        provider: "acme",
        providers: {
          acme: {
            apiKey: fixtureKey(runtime, "active-talk-key", "ACME_SPEECH_API_KEY"),
            voiceId: "active-voice",
            ...(raw
              ? { clientSecret: runtime ? "runtime-client-secret" : "source-client-secret" }
              : {}),
          },
          other: {
            apiKey: fixtureKey(runtime, "inactive-talk-key", "OTHER_SPEECH_API_KEY"),
            voiceId: "inactive-voice",
          },
        },
        realtime: {
          provider: "openai",
          providers: {
            openai: {
              apiKey: fixtureKey(runtime, "realtime-key", "OPENAI_REALTIME_API_KEY"),
              ...(raw
                ? {
                    authToken: runtime
                      ? "runtime-realtime-auth-token"
                      : "source-realtime-auth-token",
                  }
                : { voice: "cedar" }),
            },
          },
        },
      },
    });
    const sourceConfig = multiProvider
      ? configWithKeys(false)
      : createTalkConfig(secretRef("ACME_SPEECH_API_KEY"));
    const runtimeConfig = multiProvider
      ? configWithKeys(true)
      : createTalkConfig("runtime-resolved-talk-key");
    mocks.getSpeechProvider.mockReturnValue(
      kind === "resolver"
        ? {
            id: "acme",
            label: "Acme Speech",
            resolveTalkConfig: ({
              talkProviderConfig,
            }: {
              talkProviderConfig: Record<string, unknown>;
            }) => ({
              ...talkProviderConfig,
              voiceId: "resolver-voice",
              clientSecret: "resolver-client-secret",
              authToken: "resolver-auth-token",
            }),
          }
        : undefined,
    );
    setSourceConfig(sourceConfig);

    const respond = await invokeTalkHandler("talk.config", {
      params: { includeSecrets: true },
      client: {
        connect: { scopes: ["operator.talk.secrets"] },
      },
      config: runtimeConfig,
    });
    const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
    const talkConfig = response.config?.talk;
    const resolved = talkConfig?.resolved as Record<string, unknown> | undefined;
    const serialized = JSON.stringify(response);
    if (kind === "refs") {
      const providers = talkConfig?.providers as Record<string, unknown> | undefined;
      expectRecordFields((providers?.acme as Record<string, unknown> | undefined)?.apiKey, {
        source: "env",
        provider: "default",
        id: "ACME_SPEECH_API_KEY",
      });
      expectRecordFields((providers?.other as Record<string, unknown> | undefined)?.apiKey, {
        source: "env",
        provider: "default",
        id: "OTHER_SPEECH_API_KEY",
      });
      const realtime = talkConfig?.realtime as Record<string, unknown> | undefined;
      const realtimeProviders = realtime?.providers as Record<string, unknown> | undefined;
      expectRecordFields(
        (realtimeProviders?.openai as Record<string, unknown> | undefined)?.apiKey,
        { source: "env", provider: "default", id: "OPENAI_REALTIME_API_KEY" },
      );
      expectRecordFields(resolved, { provider: "acme" });
    }
    if (multiProvider) {
      expectRecordFields(resolved?.config, {
        apiKey: "runtime-active-talk-key",
        ...(raw ? { clientSecret: "__OPENCLAW_REDACTED__" } : {}),
      });
      expect(serialized).toContain("runtime-active-talk-key");
      expect(serialized).not.toContain("runtime-inactive-talk-key");
      expect(serialized).not.toContain("runtime-realtime-key");
      if (raw) {
        for (const secret of [
          "source-active-talk-key",
          "source-inactive-talk-key",
          "source-realtime-key",
          "source-client-secret",
          "source-realtime-auth-token",
          "runtime-client-secret",
          "runtime-realtime-auth-token",
        ]) {
          expect(serialized).not.toContain(secret);
        }
      }
    } else {
      expectRecordFields(resolved?.config, {
        apiKey: "runtime-resolved-talk-key",
        voiceId: "resolver-voice",
        clientSecret: "__OPENCLAW_REDACTED__",
        authToken: "__OPENCLAW_REDACTED__",
      });
      expect(serialized).not.toContain("resolver-client-secret");
      expect(serialized).not.toContain("resolver-auth-token");
    }
  });
});

describe("talk.session unified handlers", () => {
  it.each(["transcription", "realtime-relay", "realtime-browser"])(
    "applies requested models before automatic provider validation for %s",
    async (surface) => {
      const provider = {
        id: "acme",
        label: "Acme",
        models: ["voice-default", "voice-current"],
        resolveConfig: ({ rawConfig }: { rawConfig: Record<string, unknown> }) => {
          if (!["voice-default", "voice-current"].includes(String(rawConfig.model))) {
            throw new Error("Unsupported model");
          }
          return rawConfig;
        },
        isConfigured: () => true,
        createBrowserSession: vi.fn(async () => ({
          provider: "acme",
          transport: "webrtc",
          clientSecret: "fixture",
        })),
      };
      mocks.listRealtimeTranscriptionProviders.mockReturnValue([provider] as never);
      mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider,
        providerConfig: { model: "voice-current" },
      } as never);
      mocks.createTalkTranscriptionRelaySession.mockReturnValue({
        transcriptionSessionId: "model-transcription",
      });
      mocks.createTalkRealtimeRelaySession.mockReturnValue({ relaySessionId: "model-realtime" });
      const config: OpenClawConfig = {
        ...voiceModelConfig("acme/voice-default"),
        ...realtimeConfig({ providers: { acme: { model: "retired-model" } } }),
        ...voiceCallConfig({
          streaming: { providers: { acme: { model: "retired-model" } } },
        }),
      };

      const respond = await invokeTalkHandler(
        surface === "realtime-browser" ? "talk.client.create" : "talk.session.create",
        {
          params: {
            model: " voice-current ",
            mode: surface === "transcription" ? "transcription" : "realtime",
          },
          context: { getRuntimeConfig: () => config, logGateway: { warn: vi.fn() } },
        },
      );
      expectRespondOk(respond);
      if (surface === "transcription") {
        expect(mockCallArg(mocks.createTalkTranscriptionRelaySession)).toMatchObject({
          providerConfig: { model: "voice-current" },
        });
      } else {
        expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            configuredProviderId: "acme",
            providerConfigOverrides: { model: "voice-current" },
          }),
        );
      }
    },
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSessionKeyFromResolveParams.mockImplementation(({ p }) => {
      const key = (p as { key?: unknown }).key;
      return {
        ok: true,
        key: typeof key === "string" ? key : "session:main",
      };
    });
    mocks.steerTalkRealtimeRelayAgentRun.mockResolvedValue(steeredRun("agent:main:main"));
    mocks.controlRealtimeVoiceAgentRun.mockResolvedValue(steeredRun("session:main"));
  });

  it("creates and drives a realtime gateway-relay session through the unified API", async () => {
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      defaultModel: "gpt-realtime-default",
      models: ["gpt-realtime-default", "gpt-realtime"],
      isConfigured: () => true,
      createBridge: vi.fn(),
    };
    mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
    resolveRealtimeProvider(provider, { apiKey: "openai-key", model: "gpt-realtime" });
    mocks.createTalkRealtimeRelaySession.mockReturnValue(
      relaySession("relay-unified-1", "gpt-realtime", "alloy"),
    );

    const action = (method: string, params: Record<string, unknown> = {}, id?: string) =>
      invokeTalkHandler(`talk.session.${method}`, {
        params: { sessionId: "relay-unified-1", ...params },
        id,
        context: {},
      });
    const expectRelayCall = (mock: ReturnType<typeof vi.fn>, params: Record<string, unknown>) =>
      expect(mock).toHaveBeenCalledWith({
        relaySessionId: "relay-unified-1",
        connId: "conn-1",
        ...params,
      });

    const createRespond = await invokeTalkHandler("talk.session.create", {
      params: {
        sessionKey: "agent:main:main",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        model: "gpt-realtime",
        voice: "alloy",
        language: "de",
      },
      client: { connId: "conn-1", connect: { scopes: ["operator.talk"] } },
      config: {
        ...voiceModelConfig("openai/gpt-realtime-default"),
        ...realtimeConfig({
          provider: "openai",
          providers: { openai: { apiKey: "openai-key" } },
          instructions: "Speak warmly.",
          consultRouting: "force-agent-consult",
        }),
      } as OpenClawConfig,
    });

    expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProviderAsync), {
      configuredProviderId: "openai",
      providerConfigs: { openai: { apiKey: "openai-key" } },
      defaultModel: "gpt-realtime-default",
      surface: "gateway-relay",
      autoRespondToAudio: false,
    });
    expectSessionEntryEnsure(mocks.ensureClientVoiceAgentSessionEntry, "main", "agent:main:main");
    const relayCreateInput = mockCallArg(mocks.createTalkRealtimeRelaySession) as Record<
      string,
      unknown
    >;
    expectRecordFields(relayCreateInput, {
      connId: "conn-1",
      provider,
      language: "de",
      consultAuthority: {
        senderIsOwner: false,
        replyCaller: expect.objectContaining({
          ApprovalReviewerDeviceId: undefined,
          ChatType: "direct",
          GatewayClientCaps: [],
          GatewayClientScopes: ["operator.talk"],
          OriginatingChannel: "webchat",
          Provider: "webchat",
          Surface: "webchat",
          SenderId: undefined,
          SenderName: undefined,
          SenderUsername: undefined,
        }),
        toolsAllow: ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
      },
    });
    expectRecordFields(relayCreateInput.providerConfig, {
      apiKey: "openai-key",
      model: "gpt-realtime",
      voice: "alloy",
    });
    expect(relayCreateInput.instructions).toContain(
      "Additional realtime instructions:\nSpeak warmly.",
    );
    expect(relayCreateInput.forceAgentConsultOnFinalTranscript).toBe(true);
    expect(relayCreateInput.instructions).toContain("tool-backed actions");
    expect(relayCreateInput.instructions).toContain("Let me check that for you");
    expectRespondOk(createRespond, {
      sessionId: "relay-unified-1",
      relaySessionId: "relay-unified-1",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
    });

    await action("appendAudio", { audioBase64: "aGVsbG8=", timestamp: 42 }, "2");
    expectRelayCall(mocks.sendTalkRealtimeRelayAudio, {
      audioBase64: "aGVsbG8=",
      timestamp: 42,
    });

    mocks.cancelTalkRealtimeRelayTurn.mockResolvedValueOnce({
      status: "applied",
      turnId: "turn-7",
    });
    const cancelRespond = await action(
      "cancelOutput",
      { reason: "barge-in", turnId: "turn-7" },
      "3",
    );
    expectRelayCall(mocks.cancelTalkRealtimeRelayTurn, {
      reason: "barge-in",
      turnId: "turn-7",
    });
    expectRespondOk(cancelRespond, { ok: true, status: "applied", turnId: "turn-7" });
    for (const status of ["stale", "idle"] as const) {
      mocks.cancelTalkRealtimeRelayTurn.mockResolvedValueOnce({ status });
      const nonAppliedRespond = await action(
        "cancelOutput",
        { reason: "barge-in", turnId: "turn-old" },
        `3-${status}`,
      );
      expectRespondOk(nonAppliedRespond, { ok: true, status });
    }
    expect(mocks.cancelTalkRealtimeRelayTurn).toHaveBeenLastCalledWith({
      relaySessionId: "relay-unified-1",
      connId: "conn-1",
      reason: "barge-in",
      turnId: "turn-old",
    });

    const markRespond = await action("acknowledgeMark", { markName: "audio-mark-1" }, "3-mark");
    expectRelayCall(mocks.acknowledgeTalkRealtimeRelayMark, {
      markName: "audio-mark-1",
    });
    expectRespondOk(markRespond, { ok: true });

    let acceptToolResult!: () => void;
    mocks.submitTalkRealtimeRelayToolResult.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        acceptToolResult = resolve;
      }),
    );
    const toolRespond = vi.fn();
    const toolRequest = expectDefined(
      talkHandlers["talk.session.submitToolResult"],
      'talkHandlers["talk.session.submitToolResult"] test invariant',
    )({
      req: { type: "req", id: "4", method: "talk.session.submitToolResult" },
      params: {
        sessionId: "relay-unified-1",
        callId: "call-1",
        result: { status: "working" },
        options: { suppressResponse: true, willContinue: true },
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: toolRespond as never,
      context: {} as never,
    });
    expect(toolRespond).not.toHaveBeenCalled();
    acceptToolResult();
    await toolRequest;
    expectRelayCall(mocks.submitTalkRealtimeRelayToolResult, {
      callId: "call-1",
      result: { status: "working" },
      options: { suppressResponse: true, willContinue: true },
    });
    expectRespondOk(toolRespond, { ok: true });

    mocks.submitTalkRealtimeRelayToolResult.mockRejectedValueOnce(
      new Error("provider rejected tool result"),
    );

    const rejectedToolRespond = await invokeTalkHandler("talk.session.submitToolResult", {
      params: {
        sessionId: "relay-unified-1",
        callId: "call-rejected",
        result: { ok: true },
      },
      id: "4-rejected",
      context: {},
    });
    expectRespondError(rejectedToolRespond, {
      code: ErrorCodes.UNAVAILABLE,
      message: "Error: provider rejected tool result",
    });

    const steerRespond = await invokeTalkHandler("talk.session.steer", {
      params: {
        sessionId: "relay-unified-1",
        sessionKey: "agent:main:main",
        text: "use the safer plan",
        mode: "steer",
      },
      id: "5",
      context: {},
    });
    expectRelayCall(mocks.steerTalkRealtimeRelayAgentRun, {
      authority: {
        senderIsOwner: false,
        replyCaller: expect.objectContaining({
          ApprovalReviewerDeviceId: undefined,
          ChatType: "direct",
          GatewayClientCaps: [],
          GatewayClientScopes: [],
          OriginatingChannel: "webchat",
          Provider: "webchat",
          Surface: "webchat",
          SenderId: undefined,
          SenderName: undefined,
          SenderUsername: undefined,
        }),
        toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only"),
      },
      sessionKey: "agent:main:main",
      text: "use the safer plan",
      mode: "steer",
      assertCurrent: expect.any(Function),
    });
    expectRespondOk(steerRespond, {
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
    });

    for (const [sessionId, connId, message] of [
      [" \nunknown-session\t ", "conn-1", "Error: Unknown Talk session"],
      ["relay-unified-1", "conn-other", "Error: Talk session is not owned by this connection"],
    ] as const) {
      const rejectedClose = await invokeTalkHandler("talk.session.close", {
        params: { sessionId },
        client: { connId },
        context: {},
      });
      expectRespondError(rejectedClose, { code: ErrorCodes.UNAVAILABLE, message });
    }
    expect(mocks.stopTalkRealtimeRelaySession).not.toHaveBeenCalled();

    const closeRespond = await invokeTalkHandler("talk.session.close", {
      params: { sessionId: " \nrelay-unified-1\t " },
      id: "6",
      context: {},
    });
    expectRelayCall(mocks.stopTalkRealtimeRelaySession, {
      disposition: undefined,
    });
    expect(closeRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);

    const closedSession = await action("close", {});
    expectRespondError(closedSession, {
      code: ErrorCodes.UNAVAILABLE,
      message: "Error: Unknown Talk session",
    });
  });

  it("uses talk.agentId and projects an opaque model from a bare realtime session", async () => {
    const model = "gpt-live-test-canary";
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBridge: vi.fn(),
      [Symbol.for("openclaw.internal.realtime-voice-provider.v1")]: {
        isBrowserSessionConfigured: () => true,
        projectPublicProjection: ({ config }: { config: Record<string, unknown> }) => {
          const { model: _model, ...publicConfig } = config;
          return { config: publicConfig };
        },
      },
    };
    resolveRealtimeProvider(provider, { model });
    mocks.createTalkRealtimeRelaySession.mockReturnValue(
      relaySession("relay-talk-owner", model, "alloy"),
    );
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
      talk: {
        agentId: "research",
        realtime: {
          provider: "openai",
          model,
          providers: { openai: { model } },
        },
      },
    };

    const respond = await invokeTalkHandler("talk.session.create", {
      params: {
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        sessionKey: "incident-42",
      },
      context: { getRuntimeConfig: () => config, logGateway: { warn: vi.fn() } },
    });

    expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "research" }),
    );
    expectSessionEntryEnsure(
      mocks.ensureClientVoiceAgentSessionEntry,
      "research",
      "agent:research:incident-42",
    );
    const response = expectRespondOk(respond, { relaySessionId: "relay-talk-owner" });
    expect(JSON.stringify(response)).not.toContain(model);
  });

  it.each<{
    label: string;
    configuredModel: string;
    requestedModel: string | undefined;
    resolvedModel?: string;
  }>([
    {
      label: "configured supported model without an override",
      configuredModel: "gpt-live-test-canary",
      requestedModel: undefined,
    },
    {
      label: "provider-normalized request override",
      configuredModel: "gpt-realtime-2.1",
      requestedModel: "gpt-live-test-canary",
      resolvedModel: "normalized-test-model",
    },
  ])("resolves relay readiness from the effective model: $label", async (testCase) => {
    const resolvedModel = testCase.resolvedModel ?? "gpt-live-test-canary";
    const capabilities = {
      transports: ["gateway-relay"],
      handlesAgentConsult: true,
      supportsToolCalls: false,
      supportsBargeIn: false,
    };
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => false,
      createBridge: vi.fn(),
    };
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockImplementationOnce((input) => {
      expect(input).toEqual(
        expect.objectContaining({
          agentId: "voice-agent",
          providerConfigOverrides: { model: "gpt-live-test-canary" },
          defaultModel: testCase.configuredModel,
          surface: "gateway-relay",
        }),
      );
      return {
        provider,
        providerConfig: { model: resolvedModel },
        capabilities,
      } as never;
    });
    mocks.createTalkRealtimeRelaySession.mockReturnValueOnce(
      relaySession("relay-effective-model", "gpt-live-test-canary", "marin"),
    );

    const respond = await invokeTalkHandler("talk.session.create", {
      params: {
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        sessionKey: "agent:voice-agent:main",
        ...(testCase.requestedModel ? { model: testCase.requestedModel } : {}),
      },
      context: {
        getRuntimeConfig: () =>
          ({
            agents: { entries: { "voice-agent": {} } },
            ...realtimeConfig({
              provider: "openai",
              model: testCase.configuredModel,
              providers: { openai: {} },
            }),
          }) as OpenClawConfig,
        logGateway: { warn: vi.fn() },
      },
    });

    expect(mocks.createTalkRealtimeRelaySession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        providerConfig: { model: resolvedModel },
        capabilities,
        controlSource: "delegation",
        tools: [],
        model: "gpt-live-test-canary",
        sessionTarget: expect.objectContaining({
          agentId: "voice-agent",
          sessionKey: "agent:voice-agent:main",
          canonicalKey: "agent:voice-agent:main",
          storePath: expect.any(String),
        }),
      }),
    );
    expectSessionEntryEnsure(
      mocks.ensureClientVoiceAgentSessionEntry,
      "voice-agent",
      "agent:voice-agent:main",
    );
    expectRespondOk(respond, { relaySessionId: "relay-effective-model" });
  });

  it("rejects forced consult routing when the provider resolves gpt-live", async () => {
    const provider = realtimeProvider();
    resolveRealtimeProvider(provider, { model: "gpt-live-test-canary" });
    mocks.resolveInternalRealtimeVoiceGatewayRelayLaunchError.mockReturnValueOnce(
      "GPT-Live gateway-relay sessions cannot use forced agent consult routing; GPT-Live delegates to the agent natively",
    );

    const respond = await invokeTalkHandler("talk.session.create", {
      params: {
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        model: "gpt-live-test-canary",
      },
      config: realtimeConfig({
        provider: "openai",
        providers: { openai: { model: "gpt-live-test-canary" } },
        consultRouting: "force-agent-consult",
      }) as OpenClawConfig,
    });

    expect(mocks.resolveInternalRealtimeVoiceGatewayRelayLaunchError).toHaveBeenCalledWith({
      provider,
      cfg: expect.any(Object),
      providerConfig: { model: "gpt-live-test-canary" },
      model: "gpt-live-test-canary",
      autoRespondToAudio: false,
    });
    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message:
        "GPT-Live gateway-relay sessions cannot use forced agent consult routing; GPT-Live delegates to the agent natively",
    });
    expect(mocks.createTalkRealtimeRelaySession).not.toHaveBeenCalled();
    expect(mocks.ensureClientVoiceAgentSessionEntry).not.toHaveBeenCalled();
  });

  it("returns classified talk issue details when realtime relay creation fails", async () => {
    const provider = realtimeProvider();
    resolveRealtimeProvider(provider, { apiKey: "bad-key" });
    mocks.createTalkRealtimeRelaySession.mockImplementation(() => {
      throw new Error("OpenAI API key rejected with 401");
    });

    const respond = await invokeTalkHandler("talk.session.create", {
      params: {
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        model: "gpt-realtime-2",
      },
      config: realtimeConfig({
        provider: "openai",
        providers: { openai: { apiKey: "bad-key" } },
      }) as OpenClawConfig,
    });

    const error = expectRespondError(respond, {
      code: ErrorCodes.UNAVAILABLE,
      message: "Error: OpenAI API key rejected with 401",
    });
    expectRecordFields((error.details as Record<string, unknown>).talkIssue, {
      code: "realtime_unavailable",
      message: "Error: OpenAI API key rejected with 401",
      phase: "request",
    });
  });

  it.each([
    [undefined, undefined, "gpt-4o-mini-transcribe"],
    ["  ", "gpt-4o-transcribe", "gpt-4o-transcribe"],
    [" gpt-4o-transcribe ", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"],
  ])(
    "creates transcription sessions with request %j and configured model %j",
    async (requestedModel, configuredModel, expectedModel) => {
      const provider = {
        id: "openai",
        label: "OpenAI Realtime Transcription",
        aliases: ["openai-realtime"],
        defaultModel: "gpt-4o-transcribe",
        models: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
        autoSelectOrder: 1,
        resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "stt-key"),
        createSession: vi.fn(),
      };
      mocks.listRealtimeTranscriptionProviders.mockReturnValue([provider] as never);
      mocks.createTalkTranscriptionRelaySession.mockReturnValue({
        provider: "openai",
        mode: "transcription",
        transport: "gateway-relay",
        transcriptionSessionId: "stt-unified-1",
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
        expiresAt: 1_797_986_400,
      });

      const createRespond = await invokeTalkHandler("talk.session.create", {
        params: { mode: "transcription", provider: "openai-realtime", model: requestedModel },
        config: {
          ...voiceModelConfig("openai/gpt-4o-mini-transcribe"),
          ...voiceCallConfig({
            streaming: {
              provider: "openai-realtime",
              providers: { openai: { apiKey: "stt-key", model: configuredModel } },
            },
          }),
        } as OpenClawConfig,
      });

      expectRespondOk(createRespond, {
        sessionId: "stt-unified-1",
        transcriptionSessionId: "stt-unified-1",
        mode: "transcription",
        transport: "gateway-relay",
        brain: "none",
      });
      const createInput = mockCallArg(mocks.createTalkTranscriptionRelaySession) as Record<
        string,
        unknown
      >;
      expectRecordFields(createInput.providerConfig, {
        apiKey: "stt-key",
        model: expectedModel,
      });

      await invokeTalkHandler("talk.session.appendAudio", {
        params: { sessionId: "stt-unified-1", audioBase64: "aGVsbG8=" },
        id: "2",
        context: {},
      });
      expect(mocks.sendTalkTranscriptionRelayAudio).toHaveBeenCalledWith({
        transcriptionSessionId: "stt-unified-1",
        connId: "conn-1",
        audioBase64: "aGVsbG8=",
      });

      await invokeTalkHandler("talk.session.close", {
        params: { sessionId: "stt-unified-1" },
        id: "3",
        context: {},
      });
      expect(mocks.stopTalkTranscriptionRelaySession).toHaveBeenCalledWith({
        transcriptionSessionId: "stt-unified-1",
        connId: "conn-1",
      });
    },
  );

  it("does not create a transcription relay after its requester disconnects during provider preparation", async () => {
    const preparing = createDeferred();
    const ready = createDeferred();
    const provider = {
      id: "openai",
      label: "OpenAI Realtime Transcription",
      isConfiguredAsync: async () => {
        preparing.resolve();
        await ready.promise;
        return true;
      },
      createSession: vi.fn(),
    };
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([provider] as never);
    mocks.createTalkTranscriptionRelaySession.mockReturnValue({
      transcriptionSessionId: "revoked-transcription",
    });
    const client = { connId: "revoked-transcription", invalidated: false };
    const respond = vi.fn();
    const creation = callTalkHandler("talk.session.create", {
      params: { mode: "transcription", provider: "openai", model: "test-transcription" },
      client,
      respond,
    });
    await preparing.promise;
    client.invalidated = true;
    ready.resolve();
    await creation;

    expectRespondError(respond, {
      code: ErrorCodes.UNAVAILABLE,
      message: expect.stringContaining("Gateway requester authority changed"),
    });
    expect(mocks.createTalkTranscriptionRelaySession).not.toHaveBeenCalled();
  });

  it("creates transcription sessions with an aliased provider missing from the active registry", async () => {
    const openai = {
      id: "openai",
      aliases: ["openai-realtime"],
      label: "OpenAI Realtime Transcription",
      resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
      isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "openai-key"),
      createSession: vi.fn(),
    };
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      { id: "xai", label: "xAI Realtime Transcription", isConfigured: () => true },
    ] as never);
    mocks.getRealtimeTranscriptionProvider.mockImplementation((providerId: string | undefined) =>
      providerId === "openai-realtime" ? (openai as never) : undefined,
    );
    mocks.createTalkTranscriptionRelaySession.mockReturnValue({
      provider: "openai",
      mode: "transcription",
      transport: "gateway-relay",
      transcriptionSessionId: "stt-openai-1",
      audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      expiresAt: 1_797_986_400,
    });

    const respond = await invokeTalkHandler("talk.session.create", {
      params: { mode: "transcription", transport: "gateway-relay", brain: "none" },
      config: voiceCallConfig({
        streaming: {
          provider: "openai-realtime",
          providers: { openai: { apiKey: "openai-key" } },
        },
      }) as OpenClawConfig,
    });

    expectRespondOk(respond, {
      provider: "openai",
      transcriptionSessionId: "stt-openai-1",
    });
    expect(mockCallArg(mocks.createTalkTranscriptionRelaySession)).toMatchObject({
      provider: openai,
      providerConfig: { apiKey: "openai-key" },
    });
  });

  it.each<{
    name: string;
    config: OpenClawConfig;
    sessionKey: string;
    spawnedBy?: string;
    scope: string;
    agentId: string;
  }>([
    {
      name: "spawned child visibility",
      config: { agents: { entries: { worker: {} } } },
      sessionKey: "agent:worker:subagent:child",
      spawnedBy: "agent:main:parent",
      scope: "operator.write",
      agentId: "worker",
    },
    {
      name: "persisted fixed-store owner",
      config: fixedStoreOwnershipConfig("/tmp/shared-sessions.sqlite"),
      sessionKey: "global",
      scope: "operator.admin",
      agentId: "ops",
    },
  ])(
    "resolves managed-room sessions through $name",
    async ({ config, sessionKey, spawnedBy, scope, agentId }) => {
      const client = { connId: "conn-1", connect: { scopes: [scope] } };
      const respond = await invokeTalkHandler("talk.session.create", {
        params: {
          mode: "stt-tts",
          transport: "managed-room",
          sessionKey,
          ...(spawnedBy ? { spawnedBy } : {}),
        },
        client,
        context: {
          getRuntimeConfig: () => config,
          ...bindSessionRowProjection({}, () => projection),
        },
      });
      expectRespondOk(respond, {
        transport: "managed-room",
        ...(spawnedBy ? { brain: "agent-consult" } : {}),
      });
      if (spawnedBy) {
        expect(mocks.resolveSessionKeyFromResolveParams).toHaveBeenCalledWith({
          projection,
          client,
          p: { key: sessionKey, agentId, spawnedBy, includeGlobal: true, includeUnknown: true },
        });
      } else {
        expect(mocks.resolveSessionKeyFromResolveParams).toHaveBeenCalledWith(
          expect.objectContaining({
            p: expect.objectContaining({ key: "global", agentId: "ops" }),
          }),
        );
      }
    },
  );

  it.each([
    {
      brain: undefined,
      sessionKey: "agent:worker:main",
      message:
        "talk.session.create managed-room sessionKey requires spawnedBy or gateway scope: operator.admin",
    },
    {
      brain: "direct-tools",
      sessionKey: "session:main",
      message: 'talk.session.create brain="direct-tools" requires gateway scope: operator.admin',
    },
  ])(
    "requires admin for unscoped managed-room session with brain=$brain",
    async ({ brain, sessionKey, message }) => {
      const params = {
        mode: "stt-tts",
        transport: "managed-room",
        sessionKey,
        ...(brain ? { brain } : {}),
      };

      const respond = await invokeTalkHandler("talk.session.create", {
        params,
        client: { connId: "conn-1", connect: { scopes: ["operator.write"] } },
        config: brain ? {} : { agents: { entries: { worker: {} } } },
      });
      expectRespondError(respond, { code: ErrorCodes.INVALID_REQUEST, message });
      expect(mocks.resolveSessionKeyFromResolveParams).not.toHaveBeenCalled();
      if (!brain) {
        return;
      }
      respond.mockClear();
      const client = { connId: "conn-1", connect: { scopes: ["operator.admin"] } };
      await callTalkHandler("talk.session.create", {
        params,
        id: "2",
        client,
        respond,
        context: {
          getRuntimeConfig: () => ({}),
          ...bindSessionRowProjection({}, () => projection),
        },
      });
      const session = expectRespondOk(respond, {
        transport: "managed-room",
        brain: "direct-tools",
      });
      expect(session.sessionId).toBeTypeOf("string");
      await callTalkHandler("talk.session.close", {
        params: { sessionId: session.sessionId },
        id: "3",
        client,
        respond: vi.fn(),
        context: {},
      });
    },
  );

  it("keeps browser-owned transports on the client session endpoint", async () => {
    const respond = await invokeTalkHandler("talk.session.create", {
      params: {
        mode: "realtime",
        transport: "webrtc",
      },
    });

    const error = expectRespondError(respond, { code: ErrorCodes.INVALID_REQUEST });
    expect(error.message).toContain("use talk.client.create");
  });
});

describe("talk.client.toolCall handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chatSend.mockImplementation(
      async ({
        respond,
      }: {
        respond: (ok: boolean, result?: unknown, error?: unknown) => void;
      }) => {
        respond(true, { runId: "run-voice-1" }, undefined);
      },
    );
  });

  it("retains the original human authority through the Talk chat client copy", async () => {
    const connId = "conn-command-authority";
    onTestFinished(() => forgetLegacyVoiceBinding(connId, "main", "voice-test"));
    const client: GatewayClient = {
      connId,
      authenticatedUserId: "ada@example.test",
      authenticatedUserProfile: gatewayProfile("profile-ada", "Ada"),
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        scopes: ["operator.write"],
        caps: ["tool-events", "task-suggestions"],
      },
    };
    let forwardedClient: GatewayClient | null | undefined;
    mocks.chatSend.mockImplementationOnce(async (request: GatewayRequestHandlerOptions) => {
      forwardedClient = request.client;
      request.respond(true, { runId: "run-voice-1" }, undefined);
    });
    await callTalkHandler("talk.client.toolCall", {
      params: {
        sessionKey: "main",
        callId: "call-owned",
        name: "openclaw_agent_consult",
        args: { question: "Check status" },
      },
      client,
      respond: vi.fn(),
      context: { getRuntimeConfig: () => ({}) },
    });
    const copiedClient = expectDefined(forwardedClient, "Talk consult must dispatch its client");
    expect(copiedClient).not.toBe(client);
    const ctx = resolveChatSendCallerContext(copiedClient);
    const authorize = () =>
      resolveCommandAuthorization({
        ctx,
        cfg: { commands: { ownerAllowFrom: ["profile-ada"], allowFrom: { "*": ["profile-ada"] } } },
        commandAuthorized: false,
      });
    expect(authorize().senderIsOwner).toBe(true);
    client.invalidated = true;
    expect(authorize().senderIsOwner).toBe(false);
    expect(copiedClient.connect.caps).toEqual(["tool-events"]);
  });

  it.each(["closed", "relay"] as const)(
    "keeps legacy consults usable after rejecting an explicit %s voice record",
    async (kind) => {
      const connId = `conn-rejected-voice-${kind}`;
      const rejectedVoiceSessionId = `voice-rejected-${kind}`;
      onTestFinished(() => {
        forgetLegacyVoiceBinding(connId, "main", "voice-test");
        forgetLegacyVoiceBinding(connId, "main", rejectedVoiceSessionId);
      });
      const consult = async (voiceSessionId?: string) => {
        const respond = await invokeTalkHandler("talk.client.toolCall", {
          params: {
            sessionKey: "main",
            voiceSessionId,
            callId: `call-${voiceSessionId ?? "legacy"}`,
            name: "openclaw_agent_consult",
            args: { question: "Continue the call" },
          },
          client: { connId },
          context: { getRuntimeConfig: () => ({}) },
        });
        return respond;
      };
      await mocks.assertClientVoiceSessionOpen.withImplementation(
        ({ voiceSessionId }: { voiceSessionId: string }) => {
          if (voiceSessionId !== rejectedVoiceSessionId) {
            return "client";
          }
          if (kind === "relay") {
            return "relay";
          }
          throw new Error("voice session is closed");
        },
        async () => {
          expectRespondOk(await consult("voice-test"), { runId: "run-voice-1" });
          expectRespondError(await consult(rejectedVoiceSessionId), {
            code: ErrorCodes.INVALID_REQUEST,
          });
          expect(mocks.chatSend).toHaveBeenCalledOnce();
          expectRespondOk(await consult(), { runId: "run-voice-1" });
          expect(mocks.registerClientVoiceConsultRun).toHaveBeenLastCalledWith(
            expect.objectContaining({ voiceSessionId: "voice-test", runId: "run-voice-1" }),
          );
          expect(mocks.chatSend).toHaveBeenCalledTimes(2);
        },
      );
    },
  );

  it.each([false, true])(
    "starts consults through gateway policy with configured thinking=%s",
    async (configured) => {
      const respond = await invokeTalkHandler("talk.client.toolCall", {
        params: {
          sessionKey: "main",
          voiceSessionId: "voice-test",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: configured
            ? { question: "Are the basement lights off?" }
            : { question: "What is in this repo?", responseStyle: "one sentence" },
        },
        client: {
          connId: "conn-1",
          connect: { scopes: [configured ? "operator.write" : "operator.talk"] },
        },
        config: configured ? { talk: { consultThinkingLevel: "low", consultFastMode: true } } : {},
      });
      const chatInput = mockCallArg(mocks.chatSend) as {
        req?: Record<string, unknown>;
        params?: Record<string, unknown>;
      };
      if (configured) {
        expectRecordFields(chatInput.params, { thinking: "low", fastMode: true });
      } else {
        expectRecordFields(chatInput.req, { method: "chat.send" });
        expectRecordFields(chatInput.params, { sessionKey: "agent:main:main", agentId: "main" });
        expect(chatInput.params?.message).toContain("What is in this repo?");
        expect(chatInput.params?.idempotencyKey).toMatch(/^talk-[a-f0-9]{64}$/);
      }
      expect(mockCallArg(mocks.chatSend, 0, 2)).toEqual({
        toolsAllow: configured
          ? undefined
          : ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
        transcript: { display: false, excludeFromContext: true },
        prepareAssistantTranscriptMessage: expect.any(Function),
        beforeDispatch: expect.any(Function),
      });
      const response = expectRespondOk(respond, { runId: "run-voice-1" });
      if (!configured) {
        expect(response.idempotencyKey).toBe(chatInput.params?.idempotencyKey);
      }
    },
  );

  it("returns the tool-call acknowledgement while the agent run continues", async () => {
    let finishRun: (() => void) | undefined;
    mocks.chatSend.mockImplementationOnce(
      ({ respond }: { respond: (ok: boolean, result?: unknown, error?: unknown) => void }) =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
          respond(true, { runId: "run-active" }, undefined);
        }),
    );

    const respond = await invokeTalkHandler("talk.client.toolCall", {
      params: {
        sessionKey: "main",
        voiceSessionId: "voice-test",
        callId: "call-active",
        name: "openclaw_agent_consult",
        args: { question: "What is running?" },
      },
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
        logGateway: { warn: vi.fn() },
      },
    });

    expectRespondOk(respond, { runId: "run-active" });
    finishRun?.();
  });

  it.each([
    ["timeout", "Realtime agent consult ended before the run started."],
    ["error", "Realtime agent consult failed before the run started."],
    ["ok", "Realtime agent consult completed before the tool result subscription started."],
  ] as const)(
    "rejects terminal agent consult chat.send ACKs with status %s",
    async (status, message) => {
      mocks.chatSend.mockImplementationOnce(
        async ({
          respond,
        }: {
          respond: (ok: boolean, result?: unknown, error?: unknown) => void;
        }) => {
          respond(true, { runId: `run-${status}`, status }, undefined);
        },
      );

      const respond = await invokeTalkHandler("talk.client.toolCall", {
        params: {
          sessionKey: "main",
          voiceSessionId: "relay-1",
          relaySessionId: "relay-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "What now?" },
        },
      });

      expect(mocks.registerTalkRealtimeRelayAgentRun).not.toHaveBeenCalled();
      expectRespondError(respond, {
        code: ErrorCodes.UNAVAILABLE,
        message,
      });
    },
  );

  it("rejects client tool calls that are not the agent consult tool", async () => {
    const respond = await invokeTalkHandler("talk.client.toolCall", {
      params: {
        sessionKey: "main",
        callId: "call-1",
        name: "unknown_tool",
      },
    });

    expect(mocks.chatSend).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "unsupported realtime Talk tool: unknown_tool",
    });
  });
});

describe("talk.client.steer handler", () => {
  const createSteerContext = async (ownerConnId = "conn-1") => {
    const target = await prepareTalkSessionTarget({}, "agent:main:main");
    const source = createRpcSourceForTest(
      {
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        requester: { connectionId: ownerConnId },
        kind: "chat-send",
      },
      {
        runId: "run-voice-1",
        storeScope: target.storePath,
        sessionId: "session-active",
        sessionKey: "agent:main:main",
        agentId: "main",
      },
    );
    await claimRpcSourceForTest(source);
    rpcSourceTesting.set("run-voice-1", source);
    return { getRuntimeConfig: () => ({}) } as never;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.controlRealtimeVoiceAgentRun.mockResolvedValue(steeredRun("agent:main:main"));
  });

  it.each([
    {
      name: "another connection's run",
      text: "use the safer plan",
      mode: "steer",
      message: "talk.client.steer requires an active browser-owned Talk run",
    },
    { name: "malformed parameters", text: "", mode: undefined, message: undefined },
  ])("rejects steering with $name", async ({ text, mode, message }) => {
    const respond = await invokeTalkHandler("talk.client.steer", {
      params: { sessionKey: "agent:main:main", text, ...(mode ? { mode } : {}) },
      context: await createSteerContext("conn-2"),
    });
    expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      ...(message ? { message } : {}),
    });
  });
});

describe("talk.client.create handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRealtimeVoiceProviderCapabilitiesAsync.mockImplementation(
      ({ provider }: { provider: { capabilities?: unknown } }) => provider.capabilities,
    );
    mocks.resolveRealtimeVoiceAgentContextInstructions.mockResolvedValue(
      REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS,
    );
    mocks.createOrResumeClientVoiceSession.mockImplementation(
      async (params: { voiceSessionId?: string }) => params.voiceSessionId ?? "voice-test",
    );
    mocks.resolveClientVoiceAgentSessionId.mockResolvedValue("session-main");
    mocks.closeTalkClientGatewayControlSession.mockResolvedValue(false);
  });

  it.each(["request", "config"])(
    "uses realtime launch defaults from %s without reading speech provider config",
    async (source) => {
      mocks.resolveRealtimeVoiceAgentContextInstructions.mockResolvedValue(
        `${REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS}\n\nBounded profile context.`,
      );
      mocks.readSessionPreviewItemsFromTranscriptAsync.mockReturnValueOnce([
        { role: "user", text: "0:old small item" },
        { role: "assistant", text: `1:${"🙂".repeat(799)}` },
        { role: "tool", text: "internal tool output" },
        { role: "user", text: `2:${"🙂".repeat(799)}` },
        { role: "assistant", text: `3:${"🙂".repeat(799)}` },
      ]);
      const createBrowserSession = createBrowserSessionMock();
      const provider = createBrowserProvider(createBrowserSession);
      resolveRealtimeProvider(provider, { apiKey: "openai-key", model: "gpt-realtime" });

      const respond = await invokeTalkHandler("talk.client.create", {
        params: {
          sessionKey: "main",
          ...(source === "request"
            ? {
                vadThreshold: 0.45,
                silenceDurationMs: 650,
                prefixPaddingMs: 250,
                reasoningEffort: "low",
              }
            : {}),
        },
        client: { connId: "conn-1", connect: { scopes: ["operator.talk"] } },
        config: {
          talk: {
            provider: "elevenlabs",
            providers: { elevenlabs: { apiKey: "speech-key" } },
            realtime: {
              provider: "openai",
              providers: { openai: { apiKey: "openai-key" } },
              model: "gpt-realtime",
              speakerVoice: "alloy",
              instructions: "Speak warmly.",
              ...(source === "config"
                ? {
                    vadThreshold: 0.45,
                    silenceDurationMs: 650,
                    prefixPaddingMs: 250,
                    reasoningEffort: " low ",
                  }
                : {}),
            },
          },
        } as OpenClawConfig,
      });

      expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProviderAsync), {
        configuredProviderId: "openai",
        providerConfigs: { openai: { apiKey: "openai-key" } },
        defaultModel: "gpt-realtime",
        agentId: "main",
        surface: "browser-session",
      });
      const createInput = mockCallArg(createBrowserSession) as Record<string, unknown>;
      expectRecordFields(createInput, {
        agentId: "main",
        workspaceDir: "/tmp/openclaw-agent-workspace",
        model: "gpt-realtime",
        voice: "alloy",
        vadThreshold: 0.45,
        silenceDurationMs: 650,
        prefixPaddingMs: 250,
        reasoningEffort: "low",
        initialItems: [
          { role: "user", text: `2:${"🙂".repeat(799)}` },
          { role: "assistant", text: `3:${"🙂".repeat(799)}` },
        ],
      });
      expect(createInput.instructions).toContain(
        "Additional realtime instructions:\nSpeak warmly.",
      );
      expect(createInput.instructions).toContain("Bounded profile context.");
      expect(createInput.instructions).toContain("tool-backed actions");
      expect(createInput.instructions).toContain("Let me check that for you");
      expect(createInput.tools).not.toContainEqual(
        expect.objectContaining({ name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME }),
      );
      expect(createInput.runAgentConsult).toEqual(expect.any(Function));
      const consultSignal = new AbortController().signal;
      await (
        createInput.runAgentConsult as (params: {
          prompt: string;
          signal?: AbortSignal;
        }) => Promise<{ text: string }>
      )({ prompt: "Check the repository", signal: consultSignal });
      expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: expect.any(Object),
          agentRuntime: mocks.agentRuntime,
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath: expect.any(String),
          args: { question: "Check the repository" },
          transcript: [
            { role: "user", text: `2:${"🙂".repeat(799)}` },
            { role: "assistant", text: `3:${"🙂".repeat(799)}` },
          ],
          surface: "a browser Talk session",
          abortSignal: consultSignal,
          senderIsOwner: false,
          toolsAllow: [
            "read",
            "web_search",
            "web_fetch",
            "x_search",
            "memory_search",
            "memory_get",
          ],
        }),
      );
      expect(createInput).not.toHaveProperty("provider");
      expect(createInput).not.toHaveProperty("providers");
      expect(createInput).not.toHaveProperty("transport");
      expectSessionEntryEnsure(mocks.ensureClientVoiceAgentSessionEntry, "main", "agent:main:main");
      expect(mocks.readSessionPreviewItemsFromTranscriptAsync).toHaveBeenCalledWith(
        {
          agentId: "main",
          sessionId: "session-main",
          sessionKey: "agent:main:main",
          storePath: expect.any(String),
        },
        16,
        800,
        "model-context",
      );
      expect(mocks.createOrResumeClientVoiceSession).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "openai" }),
        expect.objectContaining({ source: expect.any(Object), release: expect.any(Function) }),
      );
      const createdVoiceSessionId = mockCallArg(
        mocks.createOrResumeClientVoiceSession,
      ).voiceSessionId;
      expect(createdVoiceSessionId).toMatch(/^[a-f0-9-]{36}$/);
      expectRespondOk(respond, {
        provider: "openai",
        transport: "webrtc",
        voiceSessionId: createdVoiceSessionId,
      });
    },
  );

  it.each(["requested model", "native handoff"])(
    "uses resolved delegation capabilities for %s",
    async (variant) => {
      const handoff = variant === "native handoff";
      if (handoff) {
        mocks.resolveClientVoiceAgentSessionId.mockResolvedValue(undefined);
        mocks.resolveRealtimeVoiceAgentContextInstructions.mockResolvedValue(
          `${REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS}\n\nBounded profile context.`,
        );
      }
      const createBrowserSession = createBrowserSessionMock();
      const provider = {
        ...createBrowserProvider(createBrowserSession),
        ...(handoff
          ? {
              capabilities: {
                transports: ["webrtc"],
                inputAudioFormats: [],
                outputAudioFormats: [],
              },
            }
          : {}),
      };
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider,
        providerConfig: handoff ? {} : { model: "gpt-live-1" },
        capabilities: {
          transports: ["webrtc"],
          handlesAgentConsult: true,
          supportsToolCalls: false,
          supportsVideoFrames: false,
          ...(handoff ? { inputAudioFormats: [], outputAudioFormats: [] } : {}),
        },
      });

      const respond = await invokeTalkHandler("talk.client.create", {
        params: handoff
          ? { sessionKey: "main", transport: "webrtc" }
          : { sessionKey: "main", model: "gpt-live-1" },
        client: handoff
          ? { connId: "conn-1" }
          : { connId: "conn-1", connect: { scopes: ["operator.write"] } },
        config: realtimeConfig(
          handoff
            ? {
                provider: "openai",
                providers: { openai: {} },
                instructions: "Speak warmly.",
              }
            : { provider: "openai", model: "gpt-realtime-2.1" },
        ),
      });
      const createInput = mockCallArg(createBrowserSession) as Record<string, unknown>;
      expect(createInput).not.toHaveProperty("tools");
      if (handoff) {
        expect(createInput.instructions).toBe(
          `Speak warmly.\n\n${REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS}\n\nBounded profile context.`,
        );
        expect(createInput.initialItems).toEqual([]);
        expect(createInput.instructions).not.toContain("openclaw_agent_consult");
      } else {
        expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "main",
            providerConfigOverrides: { model: "gpt-live-1" },
          }),
        );
        expectRecordFields(createInput, {
          model: "gpt-live-1",
          runAgentConsult: expect.any(Function),
        });
        await (
          createInput.runAgentConsult as (params: { prompt: string }) => Promise<{ text: string }>
        )({ prompt: "Check the repository" });
        const consultInput = mockCallArg(mocks.consultRealtimeVoiceAgent) as Record<
          string,
          unknown
        >;
        expect(consultInput.senderIsOwner).toBe(false);
        expect(consultInput.toolsAllow).toBeUndefined();
      }
      expectRespondOk(respond, { provider: "openai", transport: "webrtc" });
    },
  );

  it("fails a requested Gateway-owned session without provider/auth support", async () => {
    const createBrowserSession = vi.fn();
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
      provider: createBrowserProvider(createBrowserSession),
      providerConfig: { model: "gpt-realtime-2.1" },
      capabilities: {
        transports: ["webrtc"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsToolCalls: true,
      },
    });

    const respond = await invokeTalkHandler("talk.client.create", {
      params: { sessionKey: "main", capabilities: ["gateway-control-v1"] },
      config: realtimeConfig({ provider: "openai" }) as OpenClawConfig,
    });

    expect(createBrowserSession).not.toHaveBeenCalled();
    expect(mocks.createTalkClientGatewayControlOwner).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: ErrorCodes.UNAVAILABLE,
      message:
        'Realtime provider "openai" does not support gateway-control-v1 with its configured authentication',
    });
  });

  it.each([
    {
      failure: "startup",
      expiresIn: undefined,
      transport: "webrtc",
      message: "Error: provider startup failed",
    },
    {
      failure: "persistence",
      expiresIn: 60_000,
      transport: "webrtc",
      message: "Error: store failed",
    },
    {
      failure: "expired",
      expiresIn: 1_000,
      transport: "webrtc",
      message: "Error: Realtime browser session expired during startup; try again",
    },
    {
      failure: "transport",
      expiresIn: undefined,
      transport: "provider-websocket",
      message:
        'Realtime provider "openai" does not support requested browser transport "provider-websocket"',
    },
  ])(
    "cancels minted browser credentials after $failure failure",
    async ({ failure, expiresIn, transport, message }) => {
      const browserSession = {
        provider: "openai",
        transport: "webrtc" as const,
        clientSecret: "session-secret",
        ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + expiresIn }),
      };
      if (failure === "persistence") {
        mocks.ensureClientVoiceAgentSessionEntry.mockRejectedValueOnce(new Error("store failed"));
      }
      if (failure === "startup") {
        mocks.resolveClientVoiceAgentSessionId.mockResolvedValue(undefined);
      }
      const createBrowserSession = vi.fn(async (_input: unknown) => {
        if (failure === "startup") {
          throw new Error("provider startup failed");
        }
        return browserSession;
      });
      const provider = createBrowserProvider(createBrowserSession);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider,
        providerConfig: failure === "startup" ? { apiKey: "test-api-key" } : {},
      });

      const respond = await invokeTalkHandler("talk.client.create", {
        params: {
          sessionKey: "main",
          transport,
        },
      });
      if (failure === "startup") {
        expect(createBrowserSession).toHaveBeenCalledWith(
          expect.objectContaining({ initialItems: [] }),
        );
      } else {
        expect(mocks.cancelInternalRealtimeVoiceBrowserSession).toHaveBeenCalledWith({
          provider,
          request: expect.objectContaining({ providerConfig: {} }),
          session: browserSession,
        });
      }
      if (failure !== "persistence") {
        expect(mocks.ensureClientVoiceAgentSessionEntry).not.toHaveBeenCalled();
      }
      expect(mocks.createOrResumeClientVoiceSession).not.toHaveBeenCalled();
      expectRespondError(respond, { message });
    },
  );

  it("adds describe_view to camera clients whose provider supports video frames", async () => {
    const createBrowserSession = vi.fn(async (_input: unknown) => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "test-client-secret",
    }));
    const provider = {
      ...createBrowserProvider(createBrowserSession),
      capabilities: { supportsVideoFrames: true },
    };
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
      provider,
      providerConfig: { apiKey: "test-api-key" },
      capabilities: provider.capabilities,
    });

    const respond = await invokeTalkHandler("talk.client.create", {
      params: {
        sessionKey: "main",
        transport: "webrtc",
        capabilities: ["camera-frame"],
      },
    });

    const createInput = mockCallArg(createBrowserSession) as Record<string, unknown>;
    expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        surface: "browser-session",
        requiredCapabilities: { supportsVideoFrames: true },
      }),
    );
    expect(createInput.tools).toContainEqual(
      expect.objectContaining({ name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME }),
    );
    expectRespondOk(respond, { provider: "openai", transport: "webrtc" });

    createBrowserSession.mockClear();
    respond.mockClear();
    await callTalkHandler("talk.client.create", {
      params: { sessionKey: "main", transport: "webrtc" },
      id: "audio",
      respond,
    });
    expect((mockCallArg(createBrowserSession) as Record<string, unknown>).tools).not.toContainEqual(
      expect.objectContaining({ name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME }),
    );

    provider.id = "google";
    createBrowserSession.mockClear();
    respond.mockClear();
    await callTalkHandler("talk.client.create", {
      params: {
        sessionKey: "main",
        transport: "webrtc",
        capabilities: ["camera-frame"],
      },
      id: "2",
      respond,
    });
    expect((mockCallArg(createBrowserSession) as Record<string, unknown>).tools).toContainEqual(
      expect.objectContaining({ name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME }),
    );

    provider.capabilities.supportsVideoFrames = false;
    createBrowserSession.mockClear();
    respond.mockClear();
    await callTalkHandler("talk.client.create", {
      params: {
        sessionKey: "main",
        transport: "webrtc",
        capabilities: ["camera-frame"],
      },
      id: "3",
      respond,
    });
    expect(createBrowserSession).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("does not support") }),
    );
  });

  it.each<{
    name: string;
    config: OpenClawConfig;
    providerId: string;
    registeredModel?: string;
    expectedProvider?: string;
    expectedModel?: string;
    expectedProviders: Record<string, unknown>;
    expectedInput?: Record<string, unknown>;
    absentModel?: boolean;
    fallback?: boolean;
  }>([
    {
      name: "supported realtime default",
      providerId: "openai",
      registeredModel: "gpt-realtime-default",
      config: {
        ...voiceModelConfig("openai/gpt-realtime-default"),
        ...realtimeConfig({
          providers: { openai: { apiKey: "openai-key" } },
          speakerVoiceId: "voice-123",
        }),
      },
      expectedProvider: "openai",
      expectedModel: "gpt-realtime-default",
      expectedProviders: { openai: { apiKey: "openai-key" } },
      expectedInput: { model: "gpt-realtime-default", voice: "voice-123" },
    },
    {
      name: "speech-only model",
      providerId: "openai",
      registeredModel: "gpt-realtime",
      absentModel: true,
      config: {
        ...voiceModelConfig("openai/gpt-4o-mini-tts"),
        ...realtimeConfig({ providers: { openai: { apiKey: "openai-key" } } }),
      },
      expectedProvider: "openai",
      expectedProviders: { openai: { apiKey: "openai-key" } },
    },
    {
      name: "configured fallback",
      providerId: "openai",
      registeredModel: "gpt-realtime-2",
      fallback: true,
      config: {
        agents: {
          defaults: {
            voiceModel: { primary: "google/gemini-live", fallbacks: ["openai/gpt-realtime-2"] },
          },
        },
        ...realtimeConfig({ providers: { openai: { apiKey: "openai-key" } } }),
      },
      expectedProvider: "openai",
      expectedModel: "gpt-realtime-2",
      expectedProviders: { openai: { apiKey: "openai-key" } },
      expectedInput: { model: "gpt-realtime-2" },
    },
    {
      name: "unregistered realtime provider",
      providerId: "openai",
      registeredModel: "gpt-realtime",
      config: voiceModelConfig("elevenlabs/eleven_multilingual_v2"),
      expectedProviders: {},
    },
    {
      name: "unmigrated Voice Call settings",
      providerId: "openai",
      config: {
        ...voiceModelConfig("elevenlabs/eleven_multilingual_v2"),
        ...voiceCallConfig({
          realtime: {
            provider: "openai",
            providers: { openai: { apiKey: "openai-key" } },
          },
        }),
      },
      expectedProviders: {},
    },
    {
      name: "explicit single provider over unrelated defaults",
      providerId: "custom",
      config: {
        ...voiceModelConfig("openai/gpt-realtime-default"),
        ...realtimeConfig({ providers: { custom: { apiKey: "custom-key" } } }),
      },
      expectedProvider: "custom",
      expectedProviders: { custom: { apiKey: "custom-key" } },
    },
  ])(
    "resolves browser defaults for $name",
    async ({
      config,
      providerId,
      registeredModel,
      expectedProvider,
      expectedModel,
      expectedProviders,
      expectedInput,
      absentModel,
      fallback,
    }) => {
      const createBrowserSession = vi.fn(async (_input: unknown) => ({
        provider: providerId,
        transport: "webrtc" as const,
        clientSecret: "secret",
      }));
      const provider = {
        ...createBrowserProvider(createBrowserSession),
        id: providerId,
        ...(registeredModel ? { defaultModel: registeredModel, models: [registeredModel] } : {}),
        isConfigured: ({ providerConfig }: { providerConfig: Record<string, unknown> }) =>
          !fallback || providerConfig.apiKey === "openai-key",
      };
      const providers = fallback
        ? [
            {
              id: "google",
              label: "Google Live",
              defaultModel: "gemini-live",
              models: ["gemini-live"],
              isConfigured: () => false,
              createBrowserSession: vi.fn(),
              createBridge: vi.fn(),
            },
            provider,
          ]
        : [provider];
      mocks.listRealtimeVoiceProviders.mockReturnValue(providers as never);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider,
        providerConfig: {
          apiKey: `${providerId}-key`,
          ...(expectedModel ? { model: expectedModel } : {}),
        },
      });

      const respond = await invokeTalkHandler("talk.client.create", { config });
      expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProviderAsync), {
        configuredProviderId: expectedProvider,
        providerConfigs: expectedProviders,
        defaultModel: expectedModel,
      });
      if (expectedInput) {
        expectRecordFields(mockCallArg(createBrowserSession), expectedInput);
      }
      if (absentModel) {
        expect(mockCallArg(createBrowserSession)).not.toHaveProperty("model");
      }
      expectRespondOk(respond, { provider: providerId, transport: "webrtc" });
    },
  );

  it.each([
    { model: "gpt-live-test-canary", publicModel: false },
    { model: "gpt-live-1-codex", publicModel: true },
  ])(
    "projects browser session model $model according to provider policy",
    async ({ model, publicModel }) => {
      const createBrowserSession = vi.fn(async () => ({
        provider: "openai",
        transport: "webrtc" as const,
        clientSecret: "secret",
        model,
        ...(publicModel ? { voice: "spruce" } : {}),
      }));
      const provider = {
        ...createBrowserProvider(createBrowserSession),
        defaultModel: "gpt-realtime",
        models: publicModel ? ["gpt-realtime", model] : ["gpt-realtime"],
      };
      Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
        value: {
          isBrowserSessionConfigured: () => true,
          projectPublicProjection: ({ config }: { config: Record<string, unknown> }) => {
            if (publicModel) {
              return { config };
            }
            const { model: _model, ...publicConfig } = config;
            return { config: publicConfig };
          },
        },
      });
      mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
      resolveRealtimeProvider(provider, { apiKey: "openai-key", model });

      const respond = await invokeTalkHandler("talk.client.create", {
        params: { model },
        config: realtimeConfig({
          provider: "openai",
          providers: { openai: { apiKey: "openai-key", model } },
        }),
      });
      const response = expectRespondOk(respond);
      if (publicModel) {
        expectRecordFields(response, { model, voice: "spruce" });
      } else {
        expect(response).not.toHaveProperty("model");
        expect(JSON.stringify(response)).not.toContain(model);
      }
    },
  );

  it.each<{
    name: string;
    params: Record<string, unknown>;
    config: OpenClawConfig;
    message: string;
  }>([
    {
      name: "relay",
      params: { sessionKey: "main", mode: "realtime", transport: "gateway-relay" },
      config: {},
      message: "talk.client.create is client-owned; use talk.session.create for gateway-relay",
    },
    {
      name: "relay video",
      params: {
        sessionKey: "main",
        mode: "realtime",
        transport: "gateway-relay",
        capabilities: ["camera-frame"],
      },
      config: {},
      message: "gateway-relay does not support browser video frames",
    },
    {
      name: "direct tools",
      params: { sessionKey: "main" },
      config: realtimeConfig({ brain: "direct-tools" }),
      message: 'talk.client.create only supports brain="agent-consult"',
    },
  ])("rejects unsupported browser launch: $name", async ({ params, config, message }) => {
    const respond = await invokeTalkHandler("talk.client.create", { params, config });
    expectRespondError(respond, { message });
    expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).not.toHaveBeenCalled();
  });

  it("rejects Gateway-owned sessions returned by a browser-session provider", async () => {
    const createBrowserSession = vi.fn(async () => ({
      provider: "custom",
      transport: "gateway-relay" as const,
      relaySessionId: "relay-1",
      audio: {
        inputEncoding: "pcm16" as const,
        inputSampleRateHz: 24_000,
        outputEncoding: "pcm16" as const,
        outputSampleRateHz: 24_000,
      },
    }));
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
      provider: {
        id: "custom",
        label: "Custom",
        capabilities: {
          transports: ["gateway-relay"],
          inputAudioFormats: [],
          outputAudioFormats: [],
          supportsBrowserSession: true,
          supportsVideoFrames: true,
        },
        isConfigured: () => true,
        createBrowserSession,
        createBridge: vi.fn(),
      },
      providerConfig: {},
      capabilities: {
        transports: ["gateway-relay"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsBrowserSession: true,
        supportsVideoFrames: true,
      },
    });

    const respond = await invokeTalkHandler("talk.client.create", {
      params: {
        sessionKey: "main",
        mode: "realtime",
        capabilities: ["camera-frame"],
      },
    });

    expect(createBrowserSession).toHaveBeenCalledOnce();
    expect(mocks.ensureClientVoiceAgentSessionEntry).not.toHaveBeenCalled();
    expectRespondError(respond, {
      message: 'Realtime provider "custom" does not support client-owned realtime sessions',
    });
  });
});
describe("role-required Talk session creation", () => {
  it.each([
    { method: "talk.client.create" as const, params: { sessionKey: "agent:main:talk-required" } },
    {
      method: "talk.session.create" as const,
      params: {
        sessionKey: "agent:main:talk-required",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      },
    },
  ])("passes authenticated creator isolation through $method", async ({ method, params }) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      vi.clearAllMocks();
      const profile = ensureProfileForEmail("talk-required@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider: {
          id: "openai",
          label: "OpenAI Realtime",
          isConfigured: () => true,
          createBrowserSession: vi.fn(async () => ({
            provider: "openai",
            transport: "webrtc" as const,
            clientSecret: "test-session-secret",
          })),
          createBridge: vi.fn(),
        },
        providerConfig: {},
      });
      mocks.resolveRealtimeVoiceProviderCapabilitiesAsync.mockImplementation(
        ({ provider }: { provider: { capabilities?: unknown } }) => provider.capabilities,
      );
      mocks.createOrResumeClientVoiceSession.mockResolvedValue("voice-required");
      mocks.createTalkRealtimeRelaySession.mockReturnValue({
        provider: "openai",
        transport: "gateway-relay",
        relaySessionId: "relay-required",
      });
      const config: OpenClawConfig = {
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "none" },
                agents: ["main"],
                scopes: ["operator.talk"],
                sandbox: "required",
              },
            },
          },
        },
        ...realtimeConfig({ provider: "openai", providers: { openai: {} } }),
      };

      const respond = await invokeTalkHandler(method, {
        params,
        client: {
          connId: "conn-required",
          connect: { scopes: ["operator.talk"] },
          authenticatedUserProfile: { profileId: profile.id },
        },
        context: { getRuntimeConfig: () => config, logGateway: { warn: vi.fn() } },
      });

      expectRespondOk(respond);
      expect(mocks.ensureClientVoiceAgentSessionEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          sessionKey: "agent:main:talk-required",
          creation: expect.objectContaining({
            actor: { type: "human", source: "profile", id: profile.id },
            sandbox: "required",
          }),
        }),
      );
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
