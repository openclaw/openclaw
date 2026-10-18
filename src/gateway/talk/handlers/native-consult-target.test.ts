import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../../agents/embedded-agent-runner/runs.test-support.js";
import { REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS } from "../../../agents/realtime-bootstrap-context.test-support.js";
import { replyRunRegistry } from "../../../auto-reply/reply/reply-run-registry.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { controlRealtimeVoiceAgentRun } from "../../../talk/agent-run-control.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceGatewayControl,
  RealtimeVoiceProviderCapabilities,
} from "../../../talk/provider-types.js";
import { makeBridge } from "../../../talk/session-runtime.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../../chat-abort.js";
import { createChatRunState } from "../../server-chat-state.js";
import { handleGatewayRequest } from "../../server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "../../session-sharing-authorization-async.js";
import { sharingPolicyClient } from "../../session-sharing.test-utils.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { drainingRelaySessions } from "../relay/state.js";
import { resolveOwnedActiveTalkRunTarget } from "../run-ownership.js";
import {
  cleanupTalkConnection,
  getUnifiedTalkSession,
  rememberUnifiedTalkSession,
} from "../session-registry.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import {
  completeTalkVoiceChange,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
} from "../voice-selection.js";
import { talkClientHandlers } from "./client.js";
import { registerNativeConsultExactControlTests } from "./native-consult-control.test-support.js";
import { talkSessionHandlers } from "./session.js";

const mocks = vi.hoisted(() => ({
  capabilities: {
    transports: ["webrtc", "gateway-relay"],
    inputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
    outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
    supportsToolCalls: false,
  } satisfies RealtimeVoiceProviderCapabilities,
  resolveProvider: vi.fn(),
  runEmbeddedAgent: vi.fn(async (_params: RunEmbeddedAgentParams) => ({
    payloads: [{ text: "Synthetic consult answer" }],
    meta: { durationMs: 0 },
  })),
}));

vi.mock("../../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbeddedAgent }));
vi.mock("../../../agents/bootstrap-files.js", () => ({
  resolveBootstrapFilesForRun: async () => [],
}));
// mock-isolation: Keep provider registration and credential state outside handler tests.
vi.mock("../../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProviderAsync: mocks.resolveProvider,
}));
vi.mock("../../../talk/provider-registry.js", () => ({ listRealtimeVoiceProviders: () => [] }));

let state: OpenClawTestState;
let config: OpenClawConfig;
let client: ReturnType<typeof sharingPolicyClient> & { connId: string };
let callback: RealtimeVoiceAgentConsultRunner | undefined;
let relayRequest: RealtimeVoiceBridgeCreateRequest | undefined;
let providerInstructions: string | undefined;
const browserVoiceSessionIds = new Set<string>();
let browserControl: RealtimeVoiceGatewayControl | undefined;
const submitProviderResult = vi.fn();
const context = {
  getRuntimeConfig: () => config,
  getClientConnIds: () => new Set([client.connId]),
  chatAbortControllers: new Map(),
  chatRunState: createChatRunState(),
  agentRunSeq: new Map(),
  removeChatRun: vi.fn(),
  broadcastToConnIds: vi.fn(),
  logGateway: { warn: vi.fn() },
} as unknown as GatewayRequestContext;

function expectOk(respond: ReturnType<typeof vi.fn>, result: unknown = expect.any(Object)) {
  expect(respond).toHaveBeenCalledWith(true, result, undefined);
}

function expectDenied(respond: ReturnType<typeof vi.fn>, details: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(details));
}

const participationRequired = {
  details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
};
const steerRelay = (sessionId: string, handlers?: GatewayRequestHandlers) =>
  dispatch("talk.session.steer", { sessionId, text: "status", mode: "status" }, handlers);

function makeConsultBridge(submitToolResult = () => undefined) {
  return {
    connect: async () => undefined,
    sendAudio: () => undefined,
    setMediaTimestamp: () => undefined,
    handleBargeIn: () => undefined,
    submitToolResult,
    acknowledgeMark: () => undefined,
    close: () => undefined,
    isConnected: () => true,
  };
}

type RunTargetParams = Parameters<typeof resolveOwnedActiveTalkRunTarget>[0];
function runTarget(
  sessionTarget: RunTargetParams["sessionTarget"],
  scope: RunTargetParams["scope"] = { kind: "session" },
  assertCurrent?: RunTargetParams["assertCurrent"],
) {
  return resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: client.connId,
    sessionTarget,
    scope,
    assertCurrent,
  });
}

function control(
  target: Parameters<typeof controlRealtimeVoiceAgentRun>[0]["runTarget"],
  text = "cancel",
  options: Partial<Parameters<typeof controlRealtimeVoiceAgentRun>[0]> = {},
) {
  return controlRealtimeVoiceAgentRun({
    sessionKey: "global",
    runTarget: target,
    text,
    ...options,
  });
}

function embeddedHandle(runId: string, abort = vi.fn()) {
  return {
    runId,
    queueMessage: async () => undefined,
    isStreaming: () => true,
    isCompacting: () => false,
    abort,
  };
}

function configureProvider(provider: RealtimeVoiceProviderPlugin, supportsGatewayControl = true) {
  mocks.resolveProvider.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: {
      ...mocks.capabilities,
      handlesAgentConsult: true,
      ...(supportsGatewayControl ? { supportsGatewayControl } : {}),
    },
  });
}

function registerRun(runId: string, sessionId: string, sessionKey = "global", agentId = "voice") {
  return registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId,
    sessionId,
    sessionKey,
    agentId,
    ownerConnId: client.connId,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  handlers: GatewayRequestHandlers = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "native-consult", method, params },
    client,
    context,
    isWebchatConnect: () => false,
    respond,
    extraHandlers: { ...talkClientHandlers, ...talkSessionHandlers, ...handlers },
  });
  const payload = respond.mock.calls.at(-1)?.[1];
  if (
    method === "talk.client.create" &&
    isRecord(payload) &&
    typeof payload.voiceSessionId === "string"
  ) {
    browserVoiceSessionIds.add(payload.voiceSessionId);
  }
  return respond;
}

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "talk-native-consult",
    prepareProfileCatalog: true,
  });
  config = {
    agents: {
      ownership: "explicit",
      entries: { primary: {}, voice: { workspace: state.workspaceDir } },
    },
    talk: { agentId: "voice" },
  };
  setRuntimeConfigSnapshot(config);
  client = {
    ...sharingPolicyClient({ user: ensureProfileForEmail("native-listener@example.test").id }),
    connId: "native-consult-client",
  };
  callback = undefined;
  relayRequest = undefined;
  providerInstructions = undefined;
  browserVoiceSessionIds.clear();
  browserControl = undefined;
  vi.clearAllMocks();
  mocks.runEmbeddedAgent.mockReset().mockResolvedValue({
    payloads: [{ text: "Synthetic consult answer" }],
    meta: { durationMs: 0 },
  });
  context.chatAbortControllers.clear();
  context.chatRunState.clear();
  context.agentRunSeq.clear();
  setActivePluginRegistry(createEmptyPluginRegistry());
  const provider: RealtimeVoiceProviderPlugin = {
    id: "synthetic-voice",
    label: "Synthetic voice",
    capabilities: mocks.capabilities,
    isConfigured: () => true,
    createBrowserSession: async (request) => {
      providerInstructions = request.instructions;
      callback = request.runAgentConsult;
      browserControl = request.gatewayControl;
      browserControl?.bindBridge(makeConsultBridge(submitProviderResult));
      return {
        provider: "synthetic-voice",
        transport: "webrtc",
        clientSecret: "synthetic-offer",
        offerUrl: "/test/offer",
      };
    },
    createBridge: (request) => {
      relayRequest = request;
      providerInstructions = request.instructions;
      callback = request.runAgentConsult;
      return makeConsultBridge();
    },
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: { isBrowserSessionConfigured: () => true, cancelBrowserSession: async () => undefined },
  });
  configureProvider(provider);
});

afterEach(async () => {
  try {
    for (const browserVoiceSessionId of browserVoiceSessionIds) {
      await closeTalkClientGatewayControlSession({
        voiceSessionId: browserVoiceSessionId,
        sessionKey: "main",
        connId: client.connId,
      });
    }
    cleanupTalkConnection(client.connId, context.logGateway);
    await Promise.all(
      [...drainingRelaySessions].map(
        (session) => session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
      ),
    );
  } finally {
    clientVoiceSessionTesting.reset();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    setActivePluginRegistry(createEmptyPluginRegistry());
    await state.cleanup();
  }
});

async function createRelayCall(params: Record<string, unknown> = {}) {
  const respond = await dispatch("talk.session.create", {
    sessionKey: "main",
    mode: "realtime",
    transport: "gateway-relay",
    brain: "agent-consult",
    ...params,
  });
  expectOk(respond);
  const sessionId = (respond.mock.calls[0]![1] as { sessionId: string }).sessionId;
  const record = getUnifiedTalkSession(sessionId);
  if (record.kind !== "realtime-relay") {
    throw new Error("Expected realtime relay");
  }
  return { sessionId, target: record.sessionTarget };
}

it("retains the opaque relay owner when Talk defaults change without a key", async () => {
  config.session = { scope: "global" };
  const { sessionId } = await createRelayCall();
  expect(providerInstructions).toBe(REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS);
  await replaceSessionEntry(
    { agentId: "primary", sessionKey: "global" },
    {
      sessionId: "private-primary",
      updatedAt: 1,
      visibility: "draft",
      createdActor: { type: "human", source: "profile", id: "another-person" },
    },
  );
  config = { ...config, talk: { agentId: "primary" } };
  setRuntimeConfigSnapshot(config);
  expectOk(
    await steerRelay(sessionId),
    expect.objectContaining({ mode: "status", sessionKey: "global" }),
  );
});

it("enforces the retained relay's sharing policy without a key", async () => {
  await replaceSessionEntry(
    { agentId: "voice", sessionKey: "agent:voice:main" },
    {
      sessionId: "shared-before-call",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: "another-person" },
    },
  );
  const { sessionId, target } = await createRelayCall();
  const scope = {
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
  };
  await replaceSessionEntry(scope, {
    ...loadSessionEntry(scope)!,
    visibility: "read-only",
  });
  expectDenied(await steerRelay(sessionId), participationRequired);
});

it("rejects retained relay mapping changes even when the physical store is unchanged", async () => {
  const { sessionId } = await createRelayCall();
  config = { ...config, session: { mainKey: "home" } };
  setRuntimeConfigSnapshot(config);
  expectDenied(await steerRelay(sessionId), {
    code: "INVALID_REQUEST",
    message: expect.stringContaining("non-canonical persisted row"),
  });
});

it("fences an opaque relay record replaced after authorization", async () => {
  const { sessionId } = await createRelayCall();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const pending = steerRelay(sessionId, {
    "talk.session.steer": async (request) => {
      entered.resolve();
      await release.promise;
      await talkSessionHandlers["talk.session.steer"]!(request);
    },
  });
  await entered.promise;
  rememberUnifiedTalkSession(sessionId, { ...getUnifiedTalkSession(sessionId) });
  release.resolve();
  expectDenied(await pending, {
    details: expect.objectContaining({ code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" }),
  });
});

function registerOwnedEmbeddedRun(runId: string, sessionId: string) {
  const registration = registerRun(runId, sessionId);
  const abort = vi.fn();
  setActiveEmbeddedRun(sessionId, embeddedHandle(runId, abort), "global");
  return { registration, abort };
}

it("rechecks RPC sharing authorization after the control runtime import", async () => {
  config.session = { scope: "global" };
  const target = await prepareTalkSessionTarget(config, "main");
  const scope = { agentId: "voice", sessionKey: "global", storePath: target.storePath };
  await replaceSessionEntry(scope, {
    sessionId: "acl-session",
    updatedAt: 1,
    visibility: "shared",
  });
  const { registration, abort } = registerOwnedEmbeddedRun("acl-run", "acl-session");
  const authorization = await resolveSessionMutationAuthorizationAsync({
    client,
    method: "talk.client.steer",
    requestParams: { sessionKey: "main" },
    context,
  });
  expect(authorization.error).toBeNull();
  const targetRun = runTarget(target, undefined, authorization.authorization!.assertCurrent);
  const pending = control(targetRun, "cancel", { mode: "cancel" });
  replaceSessionEntrySync(scope, {
    sessionId: "acl-session",
    updatedAt: 2,
    visibility: "read-only",
    createdActor: { type: "human", source: "profile", id: "another-person" },
  });
  try {
    await expect(pending).rejects.toMatchObject({
      error: expect.objectContaining(participationRequired),
    });
    expect(abort).not.toHaveBeenCalled();
  } finally {
    authorization.authorization?.release?.();
    registration.cleanup();
  }
});

it.each<{ change: string; patch?: Partial<ReturnType<typeof registerRun>["entry"]> }>([
  { change: "replaced" },
  { change: "agent", patch: { agentId: "primary" } },
  { change: "key", patch: { sessionKey: "agent:voice:another" } },
  { change: "connection", patch: { ownerConnId: "another-client" } },
  { change: "signal", patch: { controller: new AbortController() } },
  { change: "generation", patch: { lifecycleGeneration: "retired" } },
  { change: "cleanup", patch: { registrationCleanupRequested: true } },
  { change: "voice binding replaced" },
])(
  "fences $change Gateway registration while control preparation waits",
  async ({ change, patch }) => {
    config.session = { scope: "global" };
    const target = await prepareTalkSessionTarget(config, "main");
    const runId = "captured-run";
    const voiceScope = { agentId: target.agentId, sessionKey: target.sessionKey };
    const voiceSessionId = await createOrResumeClientVoiceSession({
      ...voiceScope,
      origin: "client",
    });
    await registerClientVoiceConsultRun({ ...voiceScope, voiceSessionId, runId });
    const { registration, abort } = registerOwnedEmbeddedRun(runId, "captured-session");
    const targetRun = runTarget(target, { kind: "voice-session", voiceSessionId });
    expect(targetRun?.isCurrent()).toBe(true);
    const preparing = createDeferredCore();
    const prepared = createDeferredCore();
    const pending = control(targetRun, "cancel", {
      mode: "cancel",
      getToolAuthorityOverlay: () => ({
        senderIsOwner: false,
        disableTools: false,
        traceAuthorized: false,
      }),
      prepareToolAuthorityOverlay: async () => {
        preparing.resolve();
        await prepared.promise;
      },
    });
    await preparing.promise;
    try {
      const entry = context.chatAbortControllers.get(runId)!;
      if (change === "replaced") {
        context.chatAbortControllers.set(runId, { ...entry });
      } else if (change === "voice binding replaced") {
        const replacementVoiceSessionId = await createOrResumeClientVoiceSession({
          ...voiceScope,
          origin: "client",
        });
        await registerClientVoiceConsultRun({
          ...voiceScope,
          voiceSessionId: replacementVoiceSessionId,
          runId,
        });
      } else {
        Object.assign(entry, patch);
      }
      prepared.resolve();
      expect(await pending).toMatchObject({ ok: false, active: false, reason: "no_active_run" });
      expect(abort).not.toHaveBeenCalled();
    } finally {
      prepared.resolve();
      await Promise.allSettled([pending]);
      registration.cleanup();
    }
  },
);

it("preserves status and cancellation for an owned queued chat.send reply", async () => {
  config.session = { scope: "global" };
  const respond = await dispatch("talk.client.create", {
    sessionKey: "main",
    mode: "realtime",
    transport: "webrtc",
    brain: "agent-consult",
    capabilities: ["gateway-control-v1"],
  });
  expectOk(respond);
  const sessionId = loadSessionEntry({ agentId: "voice", sessionKey: "global" })!.sessionId;
  const registration = registerRun("queued-talk", sessionId);
  const replyParams = {
    sessionKey: "global",
    resetTriggered: false,
    upstreamAbortSignal: registration.controller.signal,
  };
  const operation = replyRunRegistry.begin({ ...replyParams, sessionId });
  const targetRun = runTarget(await prepareTalkSessionTarget(config, "main"));
  const resolvedSessionId = "materialized-reply-session";
  context.chatAbortControllers.get("queued-talk")!.sessionId = resolvedSessionId;
  operation.updateSessionId(resolvedSessionId);
  const voiceSessionId = (respond.mock.calls[0]![1] as { voiceSessionId: string }).voiceSessionId;
  await registerClientVoiceConsultRun({
    agentId: "voice",
    sessionKey: "main",
    voiceSessionId,
    runId: "queued-talk",
  });
  const voiceTarget = runTarget(await prepareTalkSessionTarget(config, "main"), {
    kind: "voice-session",
    voiceSessionId,
  });
  try {
    expect(voiceTarget?.isCurrent()).toBe(true);
    expect(await control(voiceTarget, "status")).toMatchObject({ active: false });
    expect(await control(targetRun, "status", { mode: "status" })).toMatchObject({
      active: true,
      sessionId: resolvedSessionId,
    });
    expectOk(
      await dispatch("talk.client.steer", { sessionKey: "main", text: "status", mode: "status" }),
      expect.objectContaining({ active: true, sessionId: resolvedSessionId }),
    );
    const abortUnrelated = vi.fn();
    const unrelated = embeddedHandle("queued-talk", abortUnrelated);
    setActiveEmbeddedRun(resolvedSessionId, unrelated, "global");
    try {
      expect(await control(targetRun)).toMatchObject({ active: false, aborted: false });
      expect(abortUnrelated).not.toHaveBeenCalled();
    } finally {
      clearActiveEmbeddedRun(resolvedSessionId, unrelated, "global");
    }
    expectOk(
      await dispatch("talk.client.steer", { sessionKey: "main", text: "cancel", mode: "cancel" }),
      expect.objectContaining({ ok: true, aborted: true, sessionId: resolvedSessionId }),
    );
    expect(operation.abortSignal.aborted).toBe(true);
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(targetRun?.isCurrent()).toBe(false);
    operation.complete();
    const successor = replyRunRegistry.begin({ ...replyParams, sessionId: resolvedSessionId });
    try {
      expect(await control(targetRun)).toMatchObject({ active: false, aborted: false });
      expect(successor.abortSignal.aborted).toBe(false);
    } finally {
      successor.complete();
    }
  } finally {
    operation.complete();
    registration.cleanup();
  }
});

it("restores bounded relay history after the original voice provider finishes closing", async () => {
  const configuredInstructions = "Keep native answers brief.";
  config.talk = { ...config.talk, realtime: { instructions: configuredInstructions } };
  const closeStarted = createDeferredCore();
  const finishClose = createDeferredCore();
  const requests: RealtimeVoiceBridgeCreateRequest[] = [];
  const tailUser = "The final preference is the blue bicycle.";
  const tailAssistant = "I will remember the blue bicycle.";
  const provider: RealtimeVoiceProviderPlugin = {
    id: "synthetic-voice",
    label: "Synthetic voice",
    voices: ["cove", "ember"],
    capabilities: mocks.capabilities,
    isConfigured: () => true,
    createBridge: (request) => {
      requests.push(request);
      const original = requests.length === 1;
      return makeBridge({
        close: async () => {
          if (original) {
            closeStarted.resolve();
            await finishClose.promise;
            request.onTranscript?.("user", tailUser, true);
            request.onTranscript?.("assistant", tailAssistant, true);
          }
        },
      });
    },
  };
  configureProvider(provider, false);
  const original = await createRelayCall({ voice: "cove", capabilities: ["voice-selection"] });
  const originalRequest = requests[0];
  if (!originalRequest) {
    throw new Error("Expected original relay provider");
  }
  originalRequest.onReady?.();
  const utterances = Array.from(
    { length: 20 },
    (_, index) =>
      `HISTORY_ENTRY_${String(index).padStart(2, "0")}: ${`detail-${index} `.repeat(120)}`,
  );
  for (const text of utterances) {
    originalRequest.onTranscript?.("user", text, true);
  }
  const send = vi.fn();
  const changing = requestTalkVoiceChange({
    session: resolveTalkVoiceSession({
      kind: "client",
      connId: client.connId,
      voiceSessionId: original.sessionId,
    }),
    voice: "ember",
    requesterConnId: client.connId,
    assertCurrent: () => {},
    send,
  });
  void changing.catch(() => {});
  const changeId = send.mock.calls[0]?.[0].changeId as string;
  const closing = dispatch("talk.session.close", { sessionId: original.sessionId });
  try {
    await closeStarted.promise;
    expect(requests).toHaveLength(1);
    finishClose.resolve();
    expectOk(await closing, { ok: true });

    const storedSessionId = loadSessionEntry({
      agentId: original.target.agentId,
      sessionKey: original.target.canonicalKey,
      storePath: original.target.storePath,
    })!.sessionId;
    const transcript = readSessionTranscriptMessageEvents({
      agentId: original.target.agentId,
      sessionId: storedSessionId,
      storePath: original.target.storePath,
    });
    expect(transcript).toHaveLength(22);
    expect(transcript[0]?.event).toMatchObject({
      message: { content: [{ type: "text", text: utterances[0]?.trim() }] },
    });
    expect(transcript.slice(-2).map(({ event }) => event)).toEqual(
      [
        ["user", tailUser],
        ["assistant", tailAssistant],
      ].map(([role, text]) =>
        expect.objectContaining({
          message: expect.objectContaining({ role, content: [{ type: "text", text }] }),
        }),
      ),
    );

    const replacement = await createRelayCall({
      voiceChangeId: changeId,
      capabilities: ["voice-selection"],
    });
    const replacementRequest = requests[1];
    if (!replacementRequest?.runAgentConsult) {
      throw new Error("Expected replacement relay provider and consult callback");
    }
    replacementRequest.onReady?.();
    await completeTalkVoiceChange({
      changeId,
      connId: client.connId,
      voiceSessionId: replacement.sessionId,
      outcome: "ready",
    });
    await expect(changing).resolves.toMatchObject({ status: "applied", voice: "ember" });

    const instructions = replacementRequest.instructions ?? "";
    expect(instructions).toContain(configuredInstructions);
    expect(instructions).toContain(tailUser);
    expect(instructions).toContain(tailAssistant);
    expect(instructions).toContain("HISTORY_ENTRY_19");
    expect(instructions).not.toContain("HISTORY_ENTRY_00");
    expect([...instructions.matchAll(/HISTORY_ENTRY_\d{2}/gu)].length).toBeLessThanOrEqual(16);
    const history = instructions.slice(
      configuredInstructions.length + 2 + REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS.length,
    );
    expect(Buffer.byteLength(history, "utf8")).toBeLessThanOrEqual(8_000);

    await expect(
      replacementRequest.runAgentConsult({ prompt: "What bicycle did I choose?" }),
    ).resolves.toEqual({ text: "Synthetic consult answer" });
    const agentPrompt = mocks.runEmbeddedAgent.mock.calls.at(-1)?.[0].prompt ?? "";
    expect(agentPrompt).toContain(tailUser);
    expect(agentPrompt).toContain(tailAssistant);
    expect(agentPrompt).toContain("HISTORY_ENTRY_19");
    expect(agentPrompt).not.toContain("HISTORY_ENTRY_00");
  } finally {
    finishClose.resolve();
    await closing;
    cleanupTalkConnection(client.connId, context.logGateway);
    await changing.catch(() => {});
  }
});

it.for(["status", "cancelled", "successor"] as const)(
  "keeps a native relay consult bound while voice registration waits (%s)",
  async (phase, { signal }) => {
    const { target } = await createRelayCall();
    const entered = createDeferredCore<string>();
    const resume = createDeferredCore();
    const caller = new AbortController();
    const registerVoice = voiceSessions.registerClientVoiceConsultRun;
    const registering = vi
      .spyOn(voiceSessions, "registerClientVoiceConsultRun")
      .mockImplementationOnce(async (params) => {
        const release = await registerVoice(params);
        entered.resolve(params.runId);
        await resume.promise;
        return release;
      });
    let successor: ReturnType<typeof registerChatAbortController> | undefined;
    const consult = callback!({ prompt: "Keep this pending consult", signal: caller.signal });
    void consult.catch(() => {});
    try {
      const runId = await withinTest(
        Promise.race([
          entered.promise,
          consult.then(() => {
            throw new Error("Consult completed before voice registration");
          }),
        ]),
        signal,
      );
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
      if (phase === "status") {
        expect(relayRequest?.handleDelegationInput?.("status", vi.fn())).toBe("control");
      } else if (phase === "cancelled") {
        caller.abort(new Error("Pending native consult cancelled"));
      } else {
        context.chatAbortControllers.delete(runId);
        successor = registerRun(runId, "successor-session", target.canonicalKey, target.agentId);
      }
      resume.resolve();
      if (phase === "status") {
        await expect(consult).resolves.toEqual({ text: "Synthetic consult answer" });
        expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(context.chatAbortControllers.has(runId)).toBe(false);
      } else {
        await expect(consult).rejects.toThrow(
          phase === "cancelled" ? "Pending native consult cancelled" : "no longer current",
        );
        expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
        if (successor) {
          expect(context.chatAbortControllers.get(runId)).toBe(successor.entry);
          expect(successor.controller.signal.aborted).toBe(false);
        } else {
          expect(context.chatAbortControllers.has(runId)).toBe(false);
        }
      }
      expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
    } finally {
      resume.resolve();
      await consult.catch(() => {});
      successor?.cleanup();
      registering.mockRestore();
    }
  },
);

registerNativeConsultExactControlTests({
  getConfig: () => config,
  getCallback: () => callback!,
  getBrowserControl: () => browserControl!,
  runEmbeddedAgent: mocks.runEmbeddedAgent,
  context,
  dispatch,
  submitProviderResult,
});
