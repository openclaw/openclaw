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
import type { GatewayClient, GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { gatewayProfile } from "../../server/client-fixtures.test-support.js";
import { bindSessionRowProjection } from "../../session-row-projection-access.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "../../test-helpers.rpc-source.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { preparedTalkSessionProjection as projection } from "../test-helpers.js";
import {
  createBrowserProvider,
  createBrowserSessionMock,
  type BrowserRequest,
} from "./client-fixtures.test-support.js";
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

function configuredRealtime(
  provider: string,
  config: Record<string, unknown> = {},
  options: NonNullable<OpenClawConfig["talk"]>["realtime"] = {},
): OpenClawConfig {
  return realtimeConfig({ provider, providers: { [provider]: config }, ...options });
}

function expectCall(mock: ReturnType<typeof vi.fn>, fields: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

function invokeConsult(question: string, options: Parameters<typeof invokeTalkHandler>[1] = {}) {
  return invokeTalkHandler("talk.client.toolCall", {
    ...options,
    params: {
      sessionKey: "main",
      voiceSessionId: "voice-test",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question },
      ...options.params,
    },
  });
}

const talkVoice = {
  speakerVoice: "talk-speaker",
  speakerVoiceId: "talk-speaker-id",
  voice: "explicit-talk-voice",
  voiceId: "explicit-talk-voice-id",
};
const normalizedTalkVoice = { ...talkVoice, voiceName: "talk-speaker" };

const rawProviderConfig = ({ rawConfig }: { rawConfig: Record<string, unknown> }) => rawConfig;
const configuredWithKey =
  (key: string) =>
  ({ providerConfig }: { providerConfig: Record<string, unknown> }) =>
    providerConfig.apiKey === key;
const providerFields = <T extends object>(id: string, fields: T) => ({ id, label: id, ...fields });

async function readCatalog(config: OpenClawConfig) {
  return expectRespondOk(await invokeTalkHandler("talk.catalog", { client: readClient(), config }));
}

function browserFixture(
  providerConfig: Record<string, unknown> = {},
  capabilities?: Record<string, unknown>,
) {
  const create = createBrowserSessionMock();
  const provider = createBrowserProvider(create);
  mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
    provider,
    providerConfig,
    ...(capabilities ? { capabilities } : {}),
  });
  return { create, provider, input: () => mockCallArg(create) as BrowserRequest };
}

function createRelay(params: Record<string, unknown>, config: OpenClawConfig) {
  return invokeTalkHandler("talk.session.create", {
    params: {
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      ...params,
    },
    config,
  });
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
    model,
    voice,
  };
}

function steeredRun(sessionKey: string) {
  return {
    ok: true,
    mode: "steer",
    sessionKey,
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
    const readiness = createDeferred<boolean>();
    mocks.listSpeechProviders.mockReturnValue([
      providerFields("speech", { isConfiguredAsync: () => readiness.promise }),
    ] as never);
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      providerFields("realtime", {
        isConfigured: () => {
          readiness.resolve(true);
          return true;
        },
      }),
    ] as never);
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockRejectedValue(new Error("unavailable"));
    expect(await readCatalog(realtimeConfig({ provider: "realtime" }))).toMatchObject({
      speech: { providers: [{ id: "speech", configured: true }] },
      realtime: { providers: [{ id: "realtime", configured: true }] },
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
          config: { agents: { ownership: "explicit", entries: { primary: {}, voice: {} } } },
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
      providerFields("openai", {
        resolveConfig: () => {
          throw new Error("cold SecretRef");
        },
      }),
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
      const audio = [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }];
      const capabilities = {
        transports: ["provider-websocket", "gateway-relay"],
        inputAudioFormats: audio,
        outputAudioFormats: audio,
        supportsBrowserSession: true,
        supportsBargeIn: true,
        supportsToolCalls: true,
        supportsVideoFrames: true,
        supportsSessionResumption: true,
      };
      mocks.listSpeechProviders.mockReturnValue([
        providerFields("elevenlabs", {
          aliases: ["11labs"],
          models: ["speech-model"],
          voices: ["voice-1"],
          isConfigured: () => true,
        }),
      ] as never);
      mocks.listRealtimeTranscriptionProviders.mockReturnValue([
        providerFields("openai", {
          aliases: ["openai-realtime"],
          defaultModel: "transcribe-default",
          models,
          resolveConfig: rawProviderConfig,
          isConfigured: configuredWithKey("stt-key"),
        }),
        providerFields("deepgram", {
          resolveConfig: rawProviderConfig,
          isConfigured: configuredWithKey("deepgram-key"),
        }),
      ] as never);
      mocks.listRealtimeVoiceProviders.mockReturnValue([
        providerFields("google", {
          defaultModel: "gemini-live",
          capabilities,
          resolveConfig: rawProviderConfig,
          isConfigured: ({ providerConfig }: { providerConfig: Record<string, unknown> }) =>
            providerConfig.apiKey === "live-key" &&
            providerConfig.project === "base" &&
            providerConfig.model === "talk-model",
          createBrowserSession: vi.fn(),
          createBridge: vi.fn(),
        }),
        providerFields("openai", {
          resolveConfig: rawProviderConfig,
          isConfigured: configuredWithKey("openai-key"),
          createBridge: vi.fn(),
        }),
      ] as never);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider: { id: "google" },
        providerConfig: { apiKey: "live-key", project: "base", model: "talk-model" },
        capabilities,
      });
      const catalog = await readCatalog({
        talk: {
          provider: "elevenlabs",
          providers: { elevenlabs: { apiKey: "speech-key" } },
          realtime: {
            provider: "google",
            providers: { google: { apiKey: "live-key", project: "base" } },
            model: "talk-model",
          },
        },
        ...voiceCallConfig({
          streaming: {
            provider: "openai-realtime",
            providers: { "openai-realtime": { apiKey: "stt-key" } },
          },
        }),
      });
      expect(catalog).toMatchObject({
        speech: {
          activeProvider: "elevenlabs",
          providers: [
            {
              id: "elevenlabs",
              aliases: ["11labs"],
              models: ["speech-model"],
              voices: ["voice-1"],
              configured: true,
            },
          ],
        },
        transcription: {
          ready: true,
          activeProvider: "openai",
          providers: [
            {
              id: "openai",
              defaultModel: "transcribe-default",
              aliases: ["openai-realtime"],
              configured: true,
            },
            { id: "deepgram", configured: false },
          ],
        },
        realtime: {
          ready: true,
          activeProvider: "google",
          providers: [
            { id: "google", defaultModel: "gemini-live", ...capabilities, configured: true },
            { id: "openai", configured: false, supportsBrowserSession: false },
          ],
        },
      });
      if (models.length) {
        expect(catalog.transcription.providers[0].models).toEqual(models);
      } else {
        expect(catalog.transcription.providers[0]).not.toHaveProperty("models");
      }
      for (const key of ["speech-key", "stt-key", "live-key"]) {
        expect(JSON.stringify(catalog)).not.toContain(key);
      }
    },
  );

  it("emits realtime models and voices and mirrors create-time configured inputs", async () => {
    const modelFamilySettings = {
      family: "gpt-live",
      unlistedModelVoices: "active",
      unsupportedTransports: ["provider-websocket"],
      gatewayRelayHandlesAgentConsult: true,
      hint: {
        titleKey: "talkPage.gptLive.title",
        descriptionKey: "talkPage.gptLive.hint",
        readyKey: "talkPage.gptLive.ready",
      },
    };
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      providerFields("openai", {
        defaultModel: "gpt-realtime-2.1",
        models: ["gpt-realtime-2.1"],
        voices: ["alloy", "marin"],
        resolveConfig: ({
          rawConfig,
          agentId,
          surface,
        }: RealtimeVoiceProviderResolveConfigContext) => ({
          ...rawConfig,
          model:
            rawConfig.model ??
            (agentId === "voice" && surface === "browser-session"
              ? "scoped-browser-default"
              : "legacy-default"),
        }),
        isConfigured: () => false,
        createBridge: vi.fn(),
        createBrowserSession: vi.fn(),
      }),
    ] as never);
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
      provider: { id: "openai" },
      providerConfig: { model: "gpt-live-test-canary" },
      capabilities: {
        transports: ["gateway-relay"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        voices: ["marin", "cedar"],
        voiceSelectionPolicy: "allowlist-default",
        modelFamilySettings,
      },
    });
    const catalog = await readCatalog({
      talk: {
        agentId: "voice",
        realtime: {
          provider: "openai",
          providers: { openai: { model: "gpt-realtime-2.1" } },
          model: "gpt-live-test-canary",
        },
      },
    });
    expect(catalog.realtime.providers[0]).toMatchObject({
      configured: true,
      defaultModel: "scoped-browser-default",
      models: ["gpt-realtime-2.1"],
      voices: ["alloy", "marin"],
      activeVoices: ["marin", "cedar"],
      activeVoiceSelectionPolicy: "allowlist-default",
      modelFamilySettings,
    });
    expect(JSON.stringify(catalog)).not.toContain("gpt-live-test-canary");
    expectCall(mocks.resolveConfiguredRealtimeVoiceProviderAsync, {
      providerConfigOverrides: { model: "gpt-live-test-canary" },
      agentId: "voice",
    });
  });

  it.each([undefined, "force-agent-consult"])(
    "resolves the relay catalog default for consult policy %s",
    async (consultRouting) => {
      const autoRespondToAudio = consultRouting !== "force-agent-consult";
      const model = autoRespondToAudio ? "relay-default" : "manual-relay-default";
      const azure = { endpoint: "https://example.openai.azure.com" };
      const provider = providerFields("relay", {
        defaultModel: "legacy-default",
        voices: ["relay-default"],
        resolveConfig: vi.fn(rawProviderConfig),
        isConfigured: ({ providerConfig }: { providerConfig: Record<string, unknown> }) =>
          providerConfig.model === model,
        capabilities: { transports: ["gateway-relay"], supportsToolCalls: true },
        createBridge: vi.fn(),
      });
      mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider,
        providerConfig: { model, azure },
        capabilities: provider.capabilities,
      });
      const catalog = await readCatalog({
        talk: {
          agentId: "voice",
          realtime: {
            provider: "relay",
            transport: "gateway-relay",
            consultRouting,
            providers: { relay: { azure } },
          },
        },
      });
      expectCall(mocks.resolveConfiguredRealtimeVoiceProviderAsync, {
        agentId: "voice",
        surface: "gateway-relay",
        autoRespondToAudio,
      });
      expect(catalog.realtime).toMatchObject({
        ready: true,
        providers: [{ configured: true, defaultModel: model, voices: ["relay-default"] }],
      });
      expect(provider.resolveConfig).not.toHaveBeenCalled();
    },
  );

  it.each(["realtime-fast", "realtime-fast-alias"])(
    "reports the runtime-selected automatic providers and configured rows for %s",
    async (configKey) => {
      const enabled = ({ providerConfig }: { providerConfig: Record<string, unknown> }) =>
        providerConfig.enabled === true;
      const transcriptionSlow = providerFields("transcription-slow", {
        autoSelectOrder: 20,
        isConfigured: enabled,
      });
      const transcriptionFast = providerFields("transcription-fast", {
        autoSelectOrder: 10,
        models: ["transcribe-model"],
        isConfigured: ({ providerConfig }: { providerConfig: Record<string, unknown> }) =>
          enabled({ providerConfig }) && providerConfig.model === "transcribe-model",
      });
      const realtimeSlow = providerFields("realtime-slow", {
        autoSelectOrder: 20,
        isConfigured: enabled,
        createBridge: vi.fn(),
      });
      const realtimeFast = providerFields("realtime-fast", {
        autoSelectOrder: 10,
        aliases: ["realtime-fast-alias"],
        isConfigured: enabled,
        createBridge: vi.fn(),
      });
      mocks.listRealtimeTranscriptionProviders.mockReturnValue([
        transcriptionSlow,
        transcriptionFast,
      ] as never);
      mocks.listRealtimeVoiceProviders.mockReturnValue([realtimeSlow, realtimeFast] as never);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider: realtimeFast,
        providerConfig: { enabled: true },
      });
      expect(
        await readCatalog({
          ...voiceModelConfig("transcription-fast/transcribe-model"),
          ...realtimeConfig({
            providers: { "realtime-slow": { enabled: true }, [configKey]: { enabled: true } },
          }),
          ...voiceCallConfig({
            streaming: {
              providers: {
                "transcription-slow": { enabled: true },
                "transcription-fast": { enabled: true },
              },
            },
          }),
        }),
      ).toMatchObject({
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
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      providerFields("openai", { isConfigured: () => false }),
    ] as never);
    const xai = providerFields("xai", {
      resolveConfig: rawProviderConfig,
      isConfigured: configuredWithKey("xai-key"),
    });
    mocks.getRealtimeTranscriptionProvider.mockImplementation((id: string | undefined) =>
      id === "xai" ? (xai as never) : undefined,
    );
    expect(
      await readCatalog(
        voiceCallConfig({ streaming: { providers: { xai: { apiKey: "xai-key" } } } }),
      ),
    ).toMatchObject({
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
    const alias = providerFields("realtime-alias", {
      aliases: ["shared-realtime"],
      isConfigured: () => true,
      createBridge: vi.fn(),
    });
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      providerFields("transcription-alias", {
        aliases: ["shared-transcription"],
        isConfigured: () => true,
      }),
      providerFields("shared-transcription", { isConfigured: () => true }),
    ] as never);
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      alias,
      providerFields("shared-realtime", { isConfigured: () => true, createBridge: vi.fn() }),
    ] as never);
    mocks.canonicalizeRealtimeTranscriptionProviderId.mockReturnValueOnce("shared-transcription");
    mocks.canonicalizeRealtimeVoiceProviderId.mockReturnValueOnce("shared-realtime");
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
      provider: alias,
      providerConfig: { enabled: true },
    });
    expect(
      await readCatalog({
        ...configuredRealtime("shared-realtime", { enabled: true }),
        ...voiceCallConfig({
          streaming: {
            provider: "shared-transcription",
            providers: { "shared-transcription": { enabled: true } },
          },
        }),
      }),
    ).toMatchObject({
      transcription: { ready: true, activeProvider: "transcription-alias" },
      realtime: { ready: true, activeProvider: "realtime-alias" },
    });
  });

  it.each([false, true])(
    "reports unavailable catalog providers with explicit selection=%s",
    async (explicit) => {
      mocks.listRealtimeTranscriptionProviders.mockReturnValue([
        providerFields("transcription", { isConfigured: () => false }),
      ] as never);
      mocks.listRealtimeVoiceProviders.mockReturnValue([
        providerFields("realtime", { isConfigured: () => false, createBridge: vi.fn() }),
      ] as never);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockImplementation(() => {
        throw new Error(
          explicit
            ? "Realtime provider is not configured"
            : "No realtime voice provider configured",
        );
      });
      const catalog = await readCatalog(
        explicit
          ? {
              ...realtimeConfig({ provider: "realtime" }),
              ...voiceCallConfig({ streaming: { provider: "transcription" } }),
            }
          : {},
      );
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
  beforeEach(() => vi.clearAllMocks());
  it.each(["talk:speech", "tts"])(
    "uses the runtime snapshot with cold owner %s",
    async (coldOwnerId) => {
      markTalkOwnerCold(coldOwnerId);
      const runtimeConfig: OpenClawConfig = {
        talk: { provider: "acme", providers: { acme: { ...talkVoice, apiKey: "env-acme-key" } } },
        tts: {
          providers: {
            acme: {
              apiKey: { source: "env", provider: "default", id: "MISSING" },
              speakerVoice: "marin",
              speakerVoiceId: "voice-123",
            },
          },
        },
      };
      setSourceConfig(
        createTalkConfig({ source: "env", provider: "default", id: "ACME_SPEECH_API_KEY" }),
      );
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
          expectRecordFields(talkProviderConfig, normalizedTalkVoice);
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
      mocks.synthesizeSpeech.mockResolvedValue({
        success: true,
        provider: "acme",
        audioBuffer: Buffer.from([1, 2, 3]),
        outputFormat: "mp3",
        voiceCompatible: false,
        fileExtension: ".mp3",
      });
      const respond = await invokeTalkHandler("talk.speak", {
        params: { text: "Hello from talk mode." },
        client: null,
        config: runtimeConfig,
      });
      if (coldOwnerId === "talk:speech") {
        expectRespondError(respond, { code: ErrorCodes.UNAVAILABLE });
        expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
      } else {
        expect(mocks.projectConfigOntoRuntimeSourceSnapshot).not.toHaveBeenCalled();
        expect(mockCallArg(mocks.synthesizeSpeech)).toMatchObject({
          text: "Hello from talk mode.",
          disableFallback: true,
          cfg: { tts: { provider: "acme", providers: { acme: { apiKey: "env-acme-key" } } } },
        });
        expectRespondOk(respond, {
          provider: "acme",
          audioBase64: "AQID",
          outputFormat: "mp3",
          mimeType: "audio/mpeg",
          fileExtension: ".mp3",
        });
      }
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
      runtimeConfig: configuredRealtime(
        "other-realtime",
        { model: "other-live-model", voice: "other-voice" },
        { model: "other-live-model" },
      ),
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
    const providers = realtime.providers as Record<string, unknown> | undefined;
    expectRecordFields(providers?.openai, {
      apiKey: redactedSecretRef,
      azureEndpoint: "https://example.openai.azure.com",
      azureDeployment: "realtime-prod",
    });
    expect(resolveConfig).toHaveBeenCalledOnce();
    expect(mockCallArg(resolveConfig)).toMatchObject({
      rawConfig: { apiKey: "runtime-azure-secret", model: "gpt-realtime" },
    });
    expect(JSON.stringify(response)).not.toContain("runtime-azure-secret");
  });

  it("passes runtime-resolved tts provider secrets to strict provider resolvers", async () => {
    const configWithTts = (apiKey: SecretInput, timeoutMs: number): OpenClawConfig => ({
      talk: {
        provider: "acme",
        providers: {
          acme: talkVoice,
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
        expectRecordFields(talkProviderConfig, normalizedTalkVoice);
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
      expect(talkConfig).toMatchObject({
        providers: {
          acme: { apiKey: secretRef("ACME_SPEECH_API_KEY") },
          other: { apiKey: secretRef("OTHER_SPEECH_API_KEY") },
        },
        realtime: { providers: { openai: { apiKey: secretRef("OPENAI_REALTIME_API_KEY") } } },
        resolved: { provider: "acme" },
      });
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
  it("applies the requested model before automatic transcription provider validation", async () => {
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      providerFields("acme", {
        models: ["voice-default", "voice-current"],
        resolveConfig: ({ rawConfig }: { rawConfig: Record<string, unknown> }) => {
          if (!["voice-default", "voice-current"].includes(String(rawConfig.model))) {
            throw new Error("Unsupported model");
          }
          return rawConfig;
        },
        isConfigured: () => true,
      }),
    ] as never);
    mocks.createTalkTranscriptionRelaySession.mockReturnValue({
      transcriptionSessionId: "model-transcription",
    });
    const config = {
      ...voiceModelConfig("acme/voice-default"),
      ...voiceCallConfig({ streaming: { providers: { acme: { model: "retired-model" } } } }),
    };
    expectRespondOk(
      await invokeTalkHandler("talk.session.create", {
        params: { model: " voice-current ", mode: "transcription" },
        config,
      }),
    );
    expect(mockCallArg(mocks.createTalkTranscriptionRelaySession)).toMatchObject({
      providerConfig: { model: "voice-current" },
    });
  });

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
      ...realtimeProvider(),
      defaultModel: "gpt-realtime-default",
      models: ["gpt-realtime-default", "gpt-realtime"],
    };
    mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
    resolveRealtimeProvider(provider, { apiKey: "openai-key", model: "gpt-realtime" });
    mocks.createTalkRealtimeRelaySession.mockReturnValue(
      relaySession("relay-unified-1", "gpt-realtime", "alloy"),
    );
    const action = (method: string, params: Record<string, unknown> = {}) =>
      invokeTalkHandler(`talk.session.${method}`, {
        params: { sessionId: "relay-unified-1", ...params },
        context: {},
      });
    const expectRelayCall = (mock: ReturnType<typeof vi.fn>, params: Record<string, unknown>) =>
      expect(mock).toHaveBeenCalledWith({
        relaySessionId: "relay-unified-1",
        connId: "conn-1",
        ...params,
      });
    const authority = (scopes: string[]) => ({
      senderIsOwner: false,
      replyCaller: expect.objectContaining({ GatewayClientScopes: scopes }),
      toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only"),
    });
    const created = await invokeTalkHandler("talk.session.create", {
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
        ...configuredRealtime(
          "openai",
          { apiKey: "openai-key" },
          {
            instructions: "Speak warmly.",
            consultRouting: "force-agent-consult",
          },
        ),
      },
    });
    expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProviderAsync), {
      configuredProviderId: "openai",
      defaultModel: "gpt-realtime-default",
      surface: "gateway-relay",
      autoRespondToAudio: false,
    });
    expectSessionEntryEnsure(mocks.ensureClientVoiceAgentSessionEntry, "main", "agent:main:main");
    const input = mockCallArg(mocks.createTalkRealtimeRelaySession);
    expect(input).toMatchObject({
      language: "de",
      consultAuthority: authority(["operator.talk"]),
      providerConfig: { apiKey: "openai-key", model: "gpt-realtime", voice: "alloy" },
      forceAgentConsultOnFinalTranscript: true,
    });
    expect(input.instructions).toContain("Additional realtime instructions:\nSpeak warmly.");
    expectRespondOk(created, {
      sessionId: "relay-unified-1",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
    });

    await action("appendAudio", { audioBase64: "aGVsbG8=", timestamp: 42 });
    expectRelayCall(mocks.sendTalkRealtimeRelayAudio, { audioBase64: "aGVsbG8=", timestamp: 42 });
    mocks.cancelTalkRealtimeRelayTurn.mockResolvedValueOnce({
      status: "applied",
      turnId: "turn-7",
    });
    expectRespondOk(await action("cancelOutput", { reason: "barge-in", turnId: "turn-7" }), {
      ok: true,
      status: "applied",
      turnId: "turn-7",
    });
    expectRelayCall(mocks.cancelTalkRealtimeRelayTurn, { reason: "barge-in", turnId: "turn-7" });
    expectRespondOk(await action("acknowledgeMark", { markName: "audio-mark-1" }), { ok: true });
    expectRelayCall(mocks.acknowledgeTalkRealtimeRelayMark, { markName: "audio-mark-1" });

    const accepted = createDeferred();
    mocks.submitTalkRealtimeRelayToolResult.mockReturnValueOnce(accepted.promise);
    const toolRespond = vi.fn();
    const toolParams = {
      sessionId: "relay-unified-1",
      callId: "call-1",
      result: { status: "working" },
      options: { suppressResponse: true, willContinue: true },
    };
    const toolRequest = callTalkHandler("talk.session.submitToolResult", {
      params: toolParams,
      respond: toolRespond,
      context: {},
    });
    expect(toolRespond).not.toHaveBeenCalled();
    accepted.resolve();
    await toolRequest;
    expectRelayCall(mocks.submitTalkRealtimeRelayToolResult, {
      callId: toolParams.callId,
      result: toolParams.result,
      options: toolParams.options,
    });
    expectRespondOk(toolRespond, { ok: true });
    mocks.submitTalkRealtimeRelayToolResult.mockRejectedValueOnce(
      new Error("provider rejected tool result"),
    );
    expectRespondError(
      await action("submitToolResult", { callId: "call-rejected", result: { ok: true } }),
      {
        code: ErrorCodes.UNAVAILABLE,
        message: "Error: provider rejected tool result",
      },
    );
    expectRespondOk(
      await action("steer", {
        sessionKey: "agent:main:main",
        text: "use the safer plan",
        mode: "steer",
      }),
      { ok: true, mode: "steer", sessionKey: "agent:main:main" },
    );
    expectRelayCall(mocks.steerTalkRealtimeRelayAgentRun, {
      authority: authority([]),
      sessionKey: "agent:main:main",
      text: "use the safer plan",
      mode: "steer",
      assertCurrent: expect.any(Function),
    });

    for (const [sessionId, connId, message] of [
      [" \nunknown-session\t ", "conn-1", "Error: Unknown Talk session"],
      ["relay-unified-1", "conn-other", "Error: Talk session is not owned by this connection"],
    ]) {
      expectRespondError(
        await invokeTalkHandler("talk.session.close", {
          params: { sessionId },
          client: { connId },
          context: {},
        }),
        { code: ErrorCodes.UNAVAILABLE, message },
      );
    }
    expect(mocks.stopTalkRealtimeRelaySession).not.toHaveBeenCalled();
    expectRespondOk(await action("close", { sessionId: " \nrelay-unified-1\t " }), { ok: true });
    expectRelayCall(mocks.stopTalkRealtimeRelaySession, { disposition: undefined });
    expectRespondError(await action("close"), {
      code: ErrorCodes.UNAVAILABLE,
      message: "Error: Unknown Talk session",
    });
  });

  it.each([
    ["configured supported model", "gpt-live-test-canary", undefined, "gpt-live-test-canary"],
    [
      "provider-normalized request override",
      "gpt-realtime-2.1",
      "gpt-live-test-canary",
      "normalized-test-model",
    ],
  ] as const)(
    "resolves relay readiness from the effective model: %s",
    async (_name, configuredModel, requestedModel, resolvedModel) => {
      const capabilities = {
        transports: ["gateway-relay"],
        handlesAgentConsult: true,
        supportsToolCalls: false,
        supportsBargeIn: false,
      };
      const provider = { ...realtimeProvider(), isConfigured: () => false };
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValueOnce({
        provider,
        providerConfig: { model: resolvedModel },
        capabilities,
      });
      mocks.createTalkRealtimeRelaySession.mockReturnValueOnce(
        relaySession("relay-effective-model", "gpt-live-test-canary", "marin"),
      );
      const config = {
        agents: { entries: { "voice-agent": {} } },
        ...configuredRealtime("openai", {}, { model: configuredModel }),
      };
      expectRespondOk(
        await createRelay(
          {
            sessionKey: "agent:voice-agent:main",
            ...(requestedModel ? { model: requestedModel } : {}),
          },
          config,
        ),
        { relaySessionId: "relay-effective-model" },
      );
      expectCall(mocks.resolveConfiguredRealtimeVoiceProviderAsync, {
        agentId: "voice-agent",
        providerConfigOverrides: { model: "gpt-live-test-canary" },
        defaultModel: configuredModel,
        surface: "gateway-relay",
      });
      expectCall(mocks.createTalkRealtimeRelaySession, {
        providerConfig: { model: resolvedModel },
        controlSource: "delegation",
        tools: [],
        model: "gpt-live-test-canary",
        sessionTarget: expect.objectContaining({
          agentId: "voice-agent",
          canonicalKey: "agent:voice-agent:main",
        }),
      });
      expectSessionEntryEnsure(
        mocks.ensureClientVoiceAgentSessionEntry,
        "voice-agent",
        "agent:voice-agent:main",
      );
    },
  );

  it("rejects forced consult routing when the provider resolves gpt-live", async () => {
    const provider = realtimeProvider();
    resolveRealtimeProvider(provider, { model: "gpt-live-test-canary" });
    const message =
      "GPT-Live gateway-relay sessions cannot use forced agent consult routing; GPT-Live delegates to the agent natively";
    mocks.resolveInternalRealtimeVoiceGatewayRelayLaunchError.mockReturnValueOnce(message);
    const respond = await createRelay(
      { model: "gpt-live-test-canary" },
      configuredRealtime(
        "openai",
        { model: "gpt-live-test-canary" },
        { consultRouting: "force-agent-consult" },
      ),
    );
    expectCall(mocks.resolveInternalRealtimeVoiceGatewayRelayLaunchError, {
      provider,
      providerConfig: { model: "gpt-live-test-canary" },
      autoRespondToAudio: false,
    });
    expectRespondError(respond, { code: ErrorCodes.INVALID_REQUEST, message });
    expect(mocks.createTalkRealtimeRelaySession).not.toHaveBeenCalled();
    expect(mocks.ensureClientVoiceAgentSessionEntry).not.toHaveBeenCalled();
  });

  it("returns classified talk issue details when realtime relay creation fails", async () => {
    resolveRealtimeProvider(realtimeProvider(), { apiKey: "bad-key" });
    mocks.createTalkRealtimeRelaySession.mockImplementation(() => {
      throw new Error("OpenAI API key rejected with 401");
    });
    const error = expectRespondError(
      await createRelay(
        { model: "gpt-realtime-2" },
        configuredRealtime("openai", { apiKey: "bad-key" }),
      ),
      {
        code: ErrorCodes.UNAVAILABLE,
        message: "Error: OpenAI API key rejected with 401",
      },
    );
    expect(error.details).toMatchObject({
      talkIssue: {
        code: "realtime_unavailable",
        message: "Error: OpenAI API key rejected with 401",
        phase: "request",
      },
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
      config: {
        session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
      },
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
        expectCall(mocks.resolveSessionKeyFromResolveParams, {
          p: expect.objectContaining({ key: "global", agentId: "ops" }),
        });
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
        const respond = await invokeConsult("Continue the call", {
          client: { connId },
          context: { getRuntimeConfig: () => ({}) },
          params: { voiceSessionId, callId: `call-${voiceSessionId ?? "legacy"}` },
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

    const respond = await invokeConsult("What is running?", {
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
        logGateway: { warn: vi.fn() },
      },
      params: { callId: "call-active" },
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

      const respond = await invokeConsult("What now?", {
        params: { voiceSessionId: "relay-1", relaySessionId: "relay-1" },
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
      const tail = () => [
        { role: "user", text: `2:${"🙂".repeat(799)}` },
        { role: "assistant", text: `3:${"🙂".repeat(799)}` },
      ];
      mocks.readSessionPreviewItemsFromTranscriptAsync.mockReturnValueOnce([
        { role: "user", text: "0:old small item" },
        { role: "assistant", text: `1:${"🙂".repeat(799)}` },
        { role: "tool", text: "internal tool output" },
        ...tail(),
      ]);
      const fixture = browserFixture({ apiKey: "openai-key", model: "gpt-realtime" });
      const launch = {
        vadThreshold: 0.45,
        silenceDurationMs: 650,
        prefixPaddingMs: 250,
        reasoningEffort: "low",
      };
      const respond = await invokeTalkHandler("talk.client.create", {
        params: { sessionKey: "main", ...(source === "request" ? launch : {}) },
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
              ...(source === "config" ? { ...launch, reasoningEffort: " low " } : {}),
            },
          },
        },
      });
      expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProviderAsync), {
        configuredProviderId: "openai",
        providerConfigs: { openai: { apiKey: "openai-key" } },
        defaultModel: "gpt-realtime",
        agentId: "main",
        surface: "browser-session",
      });
      const input = fixture.input();
      expect(input).toMatchObject({
        ...launch,
        agentId: "main",
        workspaceDir: "/tmp/openclaw-agent-workspace",
        model: "gpt-realtime",
        voice: "alloy",
        initialItems: tail(),
      });
      expect(input.instructions).toContain("Additional realtime instructions:\nSpeak warmly.");
      expect(input.instructions).toContain("Bounded profile context.");
      expect(input.tools).not.toContainEqual(
        expect.objectContaining({ name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME }),
      );
      const signal = new AbortController().signal;
      await input.runAgentConsult!({ prompt: "Check the repository", signal });
      expectCall(mocks.consultRealtimeVoiceAgent, {
        agentId: "main",
        sessionKey: "agent:main:main",
        args: { question: "Check the repository" },
        transcript: tail(),
        abortSignal: signal,
        senderIsOwner: false,
        toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only"),
      });
      const voiceSessionId = mockCallArg(mocks.createOrResumeClientVoiceSession).voiceSessionId;
      expect(voiceSessionId).toMatch(/^[a-f0-9-]{36}$/);
      expectRespondOk(respond, { provider: "openai", transport: "webrtc", voiceSessionId });
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
      const fixture = browserFixture(handoff ? {} : { model: "gpt-live-1" }, {
        transports: ["webrtc"],
        handlesAgentConsult: true,
        supportsToolCalls: false,
        supportsVideoFrames: false,
        ...(handoff ? { inputAudioFormats: [], outputAudioFormats: [] } : {}),
      });
      if (handoff) {
        Object.assign(fixture.provider, {
          capabilities: {
            transports: ["webrtc"],
            inputAudioFormats: [],
            outputAudioFormats: [],
          },
        });
      }
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
      const input = fixture.input();
      expect(input).not.toHaveProperty("tools");
      if (handoff) {
        expect(input.instructions).toBe(
          `Speak warmly.\n\n${REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS}\n\nBounded profile context.`,
        );
        expect(input.initialItems).toEqual([]);
        expect(input.instructions).not.toContain("openclaw_agent_consult");
      } else {
        expectCall(mocks.resolveConfiguredRealtimeVoiceProviderAsync, {
          agentId: "main",
          providerConfigOverrides: { model: "gpt-live-1" },
        });
        expect(input.model).toBe("gpt-live-1");
        await input.runAgentConsult!({ prompt: "Check the repository" });
        expect(mockCallArg(mocks.consultRealtimeVoiceAgent)).toMatchObject({
          senderIsOwner: false,
          toolsAllow: undefined,
        });
      }
      expectRespondOk(respond, { provider: "openai", transport: "webrtc" });
    },
  );

  it("fails a requested Gateway-owned session without provider/auth support", async () => {
    const fixture = browserFixture(
      { model: "gpt-realtime-2.1" },
      {
        transports: ["webrtc"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsToolCalls: true,
      },
    );
    const respond = await invokeTalkHandler("talk.client.create", {
      params: { sessionKey: "main", capabilities: ["gateway-control-v1"] },
      config: realtimeConfig({ provider: "openai" }),
    });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(mocks.createTalkClientGatewayControlOwner).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: ErrorCodes.UNAVAILABLE,
      message:
        'Realtime provider "openai" does not support gateway-control-v1 with its configured authentication',
    });
  });

  it.each([
    ["startup", undefined, "webrtc", "Error: provider startup failed"],
    ["persistence", 60_000, "webrtc", "Error: store failed"],
    [
      "expired",
      1_000,
      "webrtc",
      "Error: Realtime browser session expired during startup; try again",
    ],
    [
      "transport",
      undefined,
      "provider-websocket",
      'Realtime provider "openai" does not support requested browser transport "provider-websocket"',
    ],
  ] as const)(
    "cancels minted browser credentials after %s failure",
    async (failure, expiresIn, transport, message) => {
      const fixture = browserFixture(failure === "startup" ? { apiKey: "test-api-key" } : {});
      const session = {
        provider: "openai",
        transport: "webrtc" as const,
        clientSecret: "session-secret",
        ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + expiresIn }),
      };
      fixture.create.mockResolvedValue(session);
      if (failure === "persistence") {
        mocks.ensureClientVoiceAgentSessionEntry.mockRejectedValueOnce(new Error("store failed"));
      }
      if (failure === "startup") {
        mocks.resolveClientVoiceAgentSessionId.mockResolvedValue(undefined);
        fixture.create.mockRejectedValueOnce(new Error("provider startup failed"));
      }
      const respond = await invokeTalkHandler("talk.client.create", {
        params: { sessionKey: "main", transport },
      });
      if (failure === "startup") {
        expectCall(fixture.create, { initialItems: [] });
      } else {
        expect(mocks.cancelInternalRealtimeVoiceBrowserSession).toHaveBeenCalledWith({
          provider: fixture.provider,
          request: expect.objectContaining({ providerConfig: {} }),
          session,
        });
      }
      if (failure !== "persistence") {
        expect(mocks.ensureClientVoiceAgentSessionEntry).not.toHaveBeenCalled();
      }
      expect(mocks.createOrResumeClientVoiceSession).not.toHaveBeenCalled();
      expectRespondError(respond, { message });
    },
  );

  it("adds describe_view only for camera clients with a capable provider", async () => {
    const capabilities = { supportsVideoFrames: true };
    const fixture = browserFixture({ apiKey: "test-api-key" }, capabilities);
    const create = (camera: boolean) =>
      invokeTalkHandler("talk.client.create", {
        params: {
          sessionKey: "main",
          transport: "webrtc",
          ...(camera ? { capabilities: ["camera-frame"] } : {}),
        },
      });
    expectRespondOk(await create(true), { provider: "openai", transport: "webrtc" });
    expectCall(mocks.resolveConfiguredRealtimeVoiceProviderAsync, {
      agentId: "main",
      surface: "browser-session",
      requiredCapabilities: { supportsVideoFrames: true },
    });
    expect(fixture.input().tools).toContainEqual(
      expect.objectContaining({ name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME }),
    );
    fixture.create.mockClear();
    await create(false);
    expect(fixture.input().tools).not.toContainEqual(
      expect.objectContaining({ name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME }),
    );
    capabilities.supportsVideoFrames = false;
    fixture.create.mockClear();
    expectRespondError(await create(true), {
      message: expect.stringContaining("does not support"),
    });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "supported realtime default",
      "openai/gpt-realtime-default",
      "gpt-realtime-default",
      "openai",
      "gpt-realtime-default",
    ],
    ["speech-only model", "openai/gpt-4o-mini-tts", "gpt-realtime", "openai", undefined],
    ["configured fallback", "google/gemini-live", "gpt-realtime-2", "openai", "gpt-realtime-2"],
    [
      "unregistered realtime provider",
      "elevenlabs/eleven_multilingual_v2",
      "gpt-realtime",
      undefined,
      undefined,
    ],
    [
      "unmigrated Voice Call settings",
      "elevenlabs/eleven_multilingual_v2",
      undefined,
      undefined,
      undefined,
    ],
    [
      "explicit single provider over unrelated defaults",
      "openai/gpt-realtime-default",
      undefined,
      "custom",
      undefined,
    ],
  ] as const)(
    "resolves browser defaults for %s",
    async (name, primary, registeredModel, expectedProvider, expectedModel) => {
      const fallback = name === "configured fallback";
      const id = expectedProvider ?? "openai";
      const providerConfig = { apiKey: `${id}-key` };
      const providerMap = expectedProvider ? { [id]: providerConfig } : {};
      const fixture = browserFixture({
        ...providerConfig,
        ...(expectedModel ? { model: expectedModel } : {}),
      });
      fixture.create.mockResolvedValue({
        provider: id,
        transport: "webrtc",
        clientSecret: "secret",
      });
      Object.assign(fixture.provider, {
        id,
        ...(registeredModel ? { defaultModel: registeredModel, models: [registeredModel] } : {}),
        isConfigured: ({ providerConfig: raw }: { providerConfig: Record<string, unknown> }) =>
          !fallback || raw.apiKey === "openai-key",
      });
      mocks.listRealtimeVoiceProviders.mockReturnValue(
        (fallback
          ? [
              providerFields("google", {
                defaultModel: "gemini-live",
                models: ["gemini-live"],
                isConfigured: () => false,
                createBrowserSession: vi.fn(),
                createBridge: vi.fn(),
              }),
              fixture.provider,
            ]
          : [fixture.provider]) as never,
      );
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            voiceModel: { primary, ...(fallback ? { fallbacks: ["openai/gpt-realtime-2"] } : {}) },
          },
        },
        ...(name === "unmigrated Voice Call settings"
          ? voiceCallConfig({
              realtime: { provider: "openai", providers: { openai: { apiKey: "openai-key" } } },
            })
          : expectedProvider
            ? realtimeConfig({
                providers: providerMap,
                ...(name === "supported realtime default" ? { speakerVoiceId: "voice-123" } : {}),
              })
            : {}),
      };
      expectRespondOk(await invokeTalkHandler("talk.client.create", { config }), {
        provider: id,
        transport: "webrtc",
      });
      expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProviderAsync), {
        configuredProviderId: expectedProvider,
        providerConfigs: providerMap,
        defaultModel: expectedModel,
      });
      if (expectedModel) {
        expect(fixture.input().model).toBe(expectedModel);
      }
      if (name === "supported realtime default") {
        expect(fixture.input().voice).toBe("voice-123");
      }
      if (name === "speech-only model") {
        expect(fixture.input()).not.toHaveProperty("model");
      }
    },
  );

  it.each([
    { model: "gpt-live-test-canary", publicModel: false },
    { model: "gpt-live-1-codex", publicModel: true },
  ])(
    "projects browser session model $model according to provider policy",
    async ({ model, publicModel }) => {
      const fixture = browserFixture({ apiKey: "openai-key", model });
      fixture.create.mockResolvedValue({
        provider: "openai",
        transport: "webrtc",
        clientSecret: "secret",
        model,
        ...(publicModel ? { voice: "spruce" } : {}),
      });
      Object.assign(fixture.provider, {
        defaultModel: "gpt-realtime",
        models: publicModel ? ["gpt-realtime", model] : ["gpt-realtime"],
      });
      Object.defineProperty(
        fixture.provider,
        Symbol.for("openclaw.internal.realtime-voice-provider.v1"),
        {
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
        },
      );
      mocks.listRealtimeVoiceProviders.mockReturnValue([fixture.provider] as never);
      const response = expectRespondOk(
        await invokeTalkHandler("talk.client.create", {
          params: { model },
          config: configuredRealtime("openai", { apiKey: "openai-key", model }),
        }),
      );
      if (publicModel) {
        expectRecordFields(response, { model, voice: "spruce" });
      } else {
        expect(response).not.toHaveProperty("model");
        expect(JSON.stringify(response)).not.toContain(model);
      }
    },
  );

  it.each<[string, Record<string, unknown>, OpenClawConfig, string]>([
    [
      "relay",
      { sessionKey: "main", mode: "realtime", transport: "gateway-relay" },
      {},
      "talk.client.create is client-owned; use talk.session.create for gateway-relay",
    ],
    [
      "relay video",
      {
        sessionKey: "main",
        mode: "realtime",
        transport: "gateway-relay",
        capabilities: ["camera-frame"],
      },
      {},
      "gateway-relay does not support browser video frames",
    ],
    [
      "direct tools",
      { sessionKey: "main" },
      realtimeConfig({ brain: "direct-tools" }),
      'talk.client.create only supports brain="agent-consult"',
    ],
  ])("rejects unsupported browser launch: %s", async (_name, params, config, message) => {
    expectRespondError(
      await invokeTalkHandler("talk.client.create", {
        params,
        config,
      }),
      { message },
    );
    expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).not.toHaveBeenCalled();
  });

  it("rejects Gateway-owned sessions returned by a browser-session provider", async () => {
    const create = vi.fn(async () => ({
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
    const capabilities = {
      transports: ["gateway-relay"],
      inputAudioFormats: [],
      outputAudioFormats: [],
      supportsBrowserSession: true,
      supportsVideoFrames: true,
    };
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
      provider: { ...createBrowserProvider(create), id: "custom", capabilities },
      providerConfig: {},
      capabilities,
    });
    expectRespondError(
      await invokeTalkHandler("talk.client.create", {
        params: { sessionKey: "main", mode: "realtime", capabilities: ["camera-frame"] },
      }),
      { message: 'Realtime provider "custom" does not support client-owned realtime sessions' },
    );
    expect(create).toHaveBeenCalledOnce();
    expect(mocks.ensureClientVoiceAgentSessionEntry).not.toHaveBeenCalled();
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
        ...configuredRealtime("openai", {}),
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
      expectCall(mocks.ensureClientVoiceAgentSessionEntry, {
        agentId: "main",
        sessionKey: "agent:main:talk-required",
        creation: expect.objectContaining({
          actor: { type: "human", source: "profile", id: profile.id },
          sandbox: "required",
        }),
      });
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
