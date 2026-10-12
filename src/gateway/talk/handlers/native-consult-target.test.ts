import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../../agents/embedded-agent-runner/runs.test-support.js";
import { REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS } from "../../../agents/realtime-bootstrap-context.test-support.js";
import { replyRunRegistry } from "../../../auto-reply/reply/reply-run-registry.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { emitTrustedDiagnosticEvent } from "../../../infra/diagnostic-events.js";
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
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
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
  state = await createOpenClawTestState({ label: "talk-native-consult" });
  config = {
    agents: {
      ownership: "explicit",
      entries: { primary: {}, voice: { workspace: state.workspaceDir } },
    },
    talk: { agentId: "voice" },
  };
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
      browserControl?.bindBridge({
        connect: async () => undefined,
        sendAudio: () => undefined,
        setMediaTimestamp: () => undefined,
        handleBargeIn: () => undefined,
        submitToolResult: submitProviderResult,
        acknowledgeMark: () => undefined,
        close: () => undefined,
        isConnected: () => true,
      });
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
      return {
        connect: async () => undefined,
        sendAudio: () => undefined,
        setMediaTimestamp: () => undefined,
        handleBargeIn: () => undefined,
        submitToolResult: () => undefined,
        acknowledgeMark: () => undefined,
        close: () => undefined,
        isConnected: () => true,
      };
    },
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: { isBrowserSessionConfigured: () => true, cancelBrowserSession: async () => undefined },
  });
  mocks.resolveProvider.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: {
      ...mocks.capabilities,
      supportsGatewayControl: true,
      handlesAgentConsult: true,
    },
  });
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
  expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
  const sessionId = (respond.mock.calls[0]![1] as { sessionId: string }).sessionId;
  const record = getUnifiedTalkSession(sessionId);
  if (record.kind !== "realtime-relay") {
    throw new Error("Expected realtime relay");
  }
  return { sessionId, target: record.sessionTarget };
}

it.each([undefined, "main"])(
  "retains the opaque relay owner when Talk defaults change (key=%s)",
  async (sessionKey) => {
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
    expect(
      await dispatch("talk.session.steer", {
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        text: "status",
        mode: "status",
      }),
    ).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ mode: "status", sessionKey: "global" }),
      undefined,
    );
  },
);

it.each([undefined, "main"])(
  "enforces the retained relay's sharing policy (key=%s)",
  async (sessionKey) => {
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
    expect(
      await dispatch("talk.session.steer", {
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        text: "status",
        mode: "status",
      }),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
      }),
    );
  },
);

it("rejects retained relay mapping changes even when the physical store is unchanged", async () => {
  const { sessionId } = await createRelayCall();
  config = { ...config, session: { mainKey: "home" } };
  expect(
    await dispatch("talk.session.steer", { sessionId, text: "status", mode: "status" }),
  ).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("non-canonical persisted row"),
    }),
  );
});

it("fences an opaque relay record replaced after authorization", async () => {
  const { sessionId } = await createRelayCall();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const pending = dispatch(
    "talk.session.steer",
    { sessionId, text: "status", mode: "status" },
    {
      "talk.session.steer": async (request) => {
        entered.resolve();
        await release.promise;
        await talkSessionHandlers["talk.session.steer"]!(request);
      },
    },
  );
  await entered.promise;
  rememberUnifiedTalkSession(sessionId, { ...getUnifiedTalkSession(sessionId) });
  release.resolve();
  expect(await pending).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      details: expect.objectContaining({ code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" }),
    }),
  );
});

function registerOwnedEmbeddedRun(runId: string, sessionId: string) {
  const registration = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId,
    sessionId,
    sessionKey: "global",
    agentId: "voice",
    ownerConnId: client.connId,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
  const abort = vi.fn();
  setActiveEmbeddedRun(
    sessionId,
    {
      runId,
      queueMessage: async () => undefined,
      isStreaming: () => true,
      isCompacting: () => false,
      abort,
    },
    "global",
  );
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
  const authorization = resolveSessionMutationAuthorization({
    client,
    method: "talk.client.steer",
    requestParams: { sessionKey: "main" },
    context,
  });
  expect(authorization.error).toBeNull();
  const runTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: client.connId,
    sessionTarget: target,
    scope: { kind: "session" },
    assertCurrent: authorization.authorization!.assertCurrent,
  });
  const pending = controlRealtimeVoiceAgentRun({
    sessionKey: "global",
    runTarget,
    text: "cancel",
    mode: "cancel",
  });
  replaceSessionEntrySync(scope, {
    sessionId: "acl-session",
    updatedAt: 2,
    visibility: "read-only",
    createdActor: { type: "human", source: "profile", id: "another-person" },
  });
  try {
    await expect(pending).rejects.toMatchObject({
      error: expect.objectContaining({
        details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
      }),
    });
    expect(abort).not.toHaveBeenCalled();
  } finally {
    registration.cleanup();
  }
});

it.each([
  "replaced",
  "agent",
  "key",
  "connection",
  "signal",
  "generation",
  "cleanup",
  "voice binding removed",
  "voice binding replaced",
] as const)("fences %s Gateway registration while control preparation waits", async (change) => {
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
  const runTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: client.connId,
    sessionTarget: target,
    scope: { kind: "voice-session", voiceSessionId },
  });
  expect(runTarget?.isCurrent()).toBe(true);
  const preparing = createDeferredCore();
  const prepared = createDeferredCore();
  const control = controlRealtimeVoiceAgentRun({
    sessionKey: "global",
    runTarget,
    text: "cancel",
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
    } else if (change === "agent") {
      entry.agentId = "primary";
    } else if (change === "key") {
      entry.sessionKey = "agent:voice:another";
    } else if (change === "connection") {
      entry.ownerConnId = "another-client";
    } else if (change === "generation") {
      entry.lifecycleGeneration = "retired";
    } else if (change === "cleanup") {
      entry.registrationCleanupRequested = true;
    } else if (change === "voice binding removed") {
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId,
        durationMs: 0,
        outcome: "completed",
      });
      expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
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
      entry.controller = new AbortController();
    }
    prepared.resolve();
    expect(await control).toMatchObject({ ok: false, active: false, reason: "no_active_run" });
    expect(abort).not.toHaveBeenCalled();
  } finally {
    prepared.resolve();
    await Promise.allSettled([control]);
    registration.cleanup();
  }
});

it("preserves status and cancellation for an owned queued chat.send reply", async () => {
  config.session = { scope: "global" };
  const respond = await dispatch("talk.client.create", {
    sessionKey: "main",
    mode: "realtime",
    transport: "webrtc",
    brain: "agent-consult",
    capabilities: ["gateway-control-v1"],
  });
  expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
  const sessionId = loadSessionEntry({ agentId: "voice", sessionKey: "global" })!.sessionId;
  const registration = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: "queued-talk",
    sessionId,
    sessionKey: "global",
    agentId: "voice",
    ownerConnId: client.connId,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
  const operation = replyRunRegistry.begin({
    sessionKey: "global",
    sessionId,
    resetTriggered: false,
    upstreamAbortSignal: registration.controller.signal,
  });
  const runTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: client.connId,
    sessionTarget: await prepareTalkSessionTarget(config, "main"),
    scope: { kind: "session" },
  });
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
  const voiceTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: client.connId,
    sessionTarget: await prepareTalkSessionTarget(config, "main"),
    scope: { kind: "voice-session", voiceSessionId },
  });
  try {
    expect(voiceTarget?.isCurrent()).toBe(true);
    expect(
      await controlRealtimeVoiceAgentRun({
        sessionKey: "global",
        runTarget: voiceTarget,
        text: "status",
      }),
    ).toMatchObject({ active: false });
    expect(
      await controlRealtimeVoiceAgentRun({
        sessionKey: "global",
        runTarget,
        text: "status",
        mode: "status",
      }),
    ).toMatchObject({ active: true, sessionId: resolvedSessionId });
    expect(
      await dispatch("talk.client.steer", { sessionKey: "main", text: "status", mode: "status" }),
    ).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ active: true, sessionId: resolvedSessionId }),
      undefined,
    );
    const abortUnrelated = vi.fn();
    const unrelated = {
      runId: "queued-talk",
      queueMessage: async () => undefined,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortUnrelated,
    };
    setActiveEmbeddedRun(resolvedSessionId, unrelated, "global");
    try {
      expect(
        await controlRealtimeVoiceAgentRun({ sessionKey: "global", runTarget, text: "cancel" }),
      ).toMatchObject({ active: false, aborted: false });
      expect(abortUnrelated).not.toHaveBeenCalled();
    } finally {
      clearActiveEmbeddedRun(resolvedSessionId, unrelated, "global");
    }
    expect(
      await dispatch("talk.client.steer", { sessionKey: "main", text: "cancel", mode: "cancel" }),
    ).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, aborted: true, sessionId: resolvedSessionId }),
      undefined,
    );
    expect(operation.abortSignal.aborted).toBe(true);
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(runTarget?.isCurrent()).toBe(false);
    operation.complete();
    const successor = replyRunRegistry.begin({
      sessionKey: "global",
      sessionId: resolvedSessionId,
      resetTriggered: false,
      upstreamAbortSignal: registration.controller.signal,
    });
    try {
      expect(
        await controlRealtimeVoiceAgentRun({ sessionKey: "global", runTarget, text: "cancel" }),
      ).toMatchObject({ active: false, aborted: false });
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
  mocks.resolveProvider.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: { ...mocks.capabilities, handlesAgentConsult: true },
  });
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
    expect(await closing).toHaveBeenCalledWith(true, { ok: true }, undefined);

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
    expect(transcript.slice(-2).map(({ event }) => event)).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: tailUser }],
        }),
      }),
      expect.objectContaining({
        message: expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: tailAssistant }],
        }),
      }),
    ]);

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
    expect(
      Buffer.byteLength(
        instructions.slice(
          configuredInstructions.length + 2 + REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS.length,
        ),
        "utf8",
      ),
    ).toBeLessThanOrEqual(8_000);

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

describe.each(["browser", "relay"] as const)("native %s Talk consultation", (transport) => {
  it.each([
    { name: "custom main", scope: "per-sender" as const, canonicalKey: "agent:voice:home" },
    { name: "global", scope: "global" as const, canonicalKey: "global" },
  ])("uses the created $name session in the provider callback", async ({ scope, canonicalKey }) => {
    config.session = { mainKey: "home", scope };
    config.talk = { ...config.talk, realtime: { instructions: "Keep native answers brief." } };
    const target = await prepareTalkSessionTarget(config, "main");
    const method = transport === "browser" ? "talk.client.create" : "talk.session.create";
    const respond = await dispatch(method, {
      sessionKey: "main",
      mode: "realtime",
      transport: transport === "browser" ? "webrtc" : "gateway-relay",
      brain: "agent-consult",
      ...(transport === "browser" ? { capabilities: ["gateway-control-v1"] } : {}),
    });
    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(providerInstructions).toBe(
      `Keep native answers brief.\n\n${REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS}`,
    );
    const result = respond.mock.calls[0]?.[1] as { voiceSessionId?: string; sessionId?: string };
    const storage = { agentId: "voice", sessionKey: canonicalKey, storePath: target.storePath };
    const created = loadSessionEntry(storage);
    expect(created?.sessionId).toBeTruthy();
    expect(callback).toBeTypeOf("function");
    await expect(callback!({ prompt: "Continue this conversation" })).resolves.toEqual({
      text: "Synthetic consult answer",
    });
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "voice",
        sessionKey: canonicalKey,
        sessionId: created!.sessionId,
        sessionTarget: { ...storage, sessionId: created!.sessionId },
      }),
    );
    expect(
      listSessionEntriesReadOnly({ agentId: "voice", storePath: target.storePath }).map(
        (entry) => entry.sessionKey,
      ),
    ).toEqual([canonicalKey]);
    expect(
      clientVoiceSessionTesting.readRecord("voice", result.voiceSessionId ?? result.sessionId!)
        ?.sessionKey,
    ).toBe("main");
  });
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
        successor = registerChatAbortController({
          chatAbortControllers: context.chatAbortControllers,
          runId,
          sessionId: "successor-session",
          sessionKey: target.canonicalKey,
          agentId: target.agentId,
          ownerConnId: client.connId,
          timeoutMs: 60_000,
          kind: "chat-send",
        });
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
