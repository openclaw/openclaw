import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing as embeddedRunTesting,
} from "../../../agents/embedded-agent-runner/runs.test-support.js";
import { REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS } from "../../../agents/realtime-bootstrap-context.test-support.js";
import * as workspace from "../../../agents/workspace.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  listSessionEntriesReadOnly,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { createReplyOperation } from "../../../sessions/session-controller.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../../sessions/session-controller.mailbox.js";
import { updateRpcSourceSessionId } from "../../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
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
import { adoptRpcSourceSessionKeyForTest } from "../../test-helpers.rpc-source.js";
import type { GatewayControlOwner } from "../client-agent-consult.types.js";
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
import {
  createNativeTalkCall,
  registerNativeConsultExactControlTests,
} from "./native-consult-control.test-support.js";
import { registerOwnedNativeConsultRun } from "./native-consult-target.test-support.js";
import { talkSessionHandlers } from "./session.js";
import { talkVoiceHandlers } from "./voice.js";

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
let callback: GatewayControlOwner["runAgentConsult"] | undefined;
let relayRequest: RealtimeVoiceBridgeCreateRequest | undefined;
let providerInstructions: string | undefined;
const browserVoiceSessionIds = new Set<string>();
let browserControl: RealtimeVoiceGatewayControl | undefined;
const submitProviderResult = vi.fn();
const context = {
  getRuntimeConfig: () => config,
  getClientConnIds: () => new Set([client.connId]),
  chatRunState: createChatRunState(),
  agentRunSeq: new Map(),
  removeChatRun: vi.fn(),
  broadcast: vi.fn(),
  nodeSendToSession: vi.fn(),
  broadcastToConnIds: vi.fn(),
  logGateway: { warn: vi.fn() },
} as unknown as GatewayRequestContext;

function expectOk(respond: ReturnType<typeof vi.fn>, result: unknown = expect.any(Object)) {
  expect(respond).toHaveBeenCalledWith(true, result, undefined);
}

function expectDenied(respond: ReturnType<typeof vi.fn>, details: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(details));
}

function registerOwnedRun(
  runId: string,
  sessionId: string,
  options: Parameters<typeof registerOwnedNativeConsultRun>[4] = {},
) {
  return registerOwnedNativeConsultRun(config, client.connId, runId, sessionId, options);
}

function registerQueuedRun(
  target: { storePath: string; canonicalKey: string; agentId: string },
  runId: string,
  sessionId: string,
) {
  const identity = { sessionKey: target.canonicalKey, agentId: target.agentId };
  return registerChatAbortController({
    ...identity,
    runId,
    sessionId,
    target: captureSessionTarget({
      ...identity,
      storeScope: target.storePath,
      incarnation: sessionId,
    }),
    ownerConnId: client.connId,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
}

const participationRequired = {
  details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
};
const privateActor = { type: "human", source: "profile", id: "another-person" } as const;
const replyIdentity = { sessionKey: "global", agentId: "voice", resetTriggered: false };
const steerRelay = (sessionId: string, handlers?: GatewayRequestHandlers) =>
  dispatch("talk.session.steer", { sessionId, text: "status", mode: "status" }, handlers);

function makeConsultBridge(submitToolResult = () => undefined) {
  return makeBridge({
    triggerGreeting: undefined,
    handleBargeIn: () => undefined,
    submitToolResult,
  });
}

type RunTargetParams = Parameters<typeof resolveOwnedActiveTalkRunTarget>[0];
function sessionScope(target: RunTargetParams["sessionTarget"]) {
  return { agentId: target.agentId, sessionKey: target.canonicalKey, storePath: target.storePath };
}

function runTarget(
  sessionTarget: RunTargetParams["sessionTarget"],
  scope: RunTargetParams["scope"] = { kind: "session" },
  assertCurrent?: RunTargetParams["assertCurrent"],
) {
  return resolveOwnedActiveTalkRunTarget({
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

function unrelatedRun(storePath: string, sessionId: string, runId: string) {
  const operation = createReplyOperation({
    ...replyIdentity,
    sessionId,
    target: captureSessionTarget({
      storeScope: `${storePath}.unrelated`,
      sessionKey: "global",
      agentId: "voice",
      incarnation: sessionId,
    }),
  });
  const abort = vi.fn();
  const handle = createEmbeddedRunHandle({ runId, abort });
  setActiveEmbeddedRun(sessionId, handle, "global", undefined, "voice", operation);
  return {
    operation,
    abort,
    dispose() {
      clearActiveEmbeddedRun(sessionId, handle, "global");
      operation.complete();
    },
  };
}

function pauseControl(
  target: Parameters<typeof control>[0],
  cancelRun?: NonNullable<Parameters<typeof control>[2]>["cancelRun"],
) {
  const preparing = createDeferredCore();
  const prepared = createDeferredCore();
  const pending = control(target, "cancel", {
    mode: "cancel",
    cancelRun,
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
  return { preparing, prepared, pending };
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
  mocks.runEmbeddedAgent.mockReset();
  rpcSourceTesting.clear();
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
  const { sessionId } = await createNativeTalkCall(dispatch, false, params);
  if (!sessionId) {
    throw new Error("Expected a relay session ID");
  }
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
      createdActor: privateActor,
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
      createdActor: privateActor,
    },
  );
  const { sessionId, target } = await createRelayCall();
  const scope = sessionScope(target);
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

it("rechecks RPC sharing authorization after the control runtime import", async () => {
  config.session = { scope: "global" };
  const target = await prepareTalkSessionTarget(config, "main");
  const scope = sessionScope(target);
  await replaceSessionEntry(scope, {
    sessionId: "acl-session",
    updatedAt: 1,
    visibility: "shared",
  });
  const { registration, abort } = await registerOwnedRun("acl-run", "acl-session");
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
    createdActor: privateActor,
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

it.each([
  "replaced",
  "agent",
  "key",
  "connection",
  "signal",
  "generation",
  "claim retired",
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
  const { registration, abort } = await registerOwnedRun(runId, "captured-session", {
    executionStarted: change !== "agent" && change !== "key",
  });
  const targetRun = runTarget(
    target,
    change === "agent" || change === "key"
      ? { kind: "session" }
      : { kind: "voice-session", voiceSessionId },
  );
  expect(targetRun?.isCurrent()).toBe(true);
  const { preparing, prepared, pending } = pauseControl(targetRun);
  await preparing.promise;
  const entry = rpcSourceTesting.get(runId)!;
  if (change === "replaced") {
    rpcSourceTesting.set(runId, { ...entry });
  } else if (change === "agent" || change === "key") {
    const destinationKey = change === "agent" ? "global" : "agent:voice:another";
    await adoptRpcSourceSessionKeyForTest(
      entry,
      captureSessionTarget({
        storeScope: target.storePath,
        sessionKey: destinationKey,
        agentId: change === "agent" ? "primary" : "voice",
      }),
    );
  } else if (change === "connection") {
    Object.assign(entry.adapter.requester!, { connectionId: "another-client" });
  } else if (change === "generation") {
    rotateAgentEventLifecycleGeneration();
  } else if (change === "claim retired") {
    const claim = entry.input.claim!;
    claim.operation!.complete();
    releaseSessionControllerClaim(claim);
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
    registration.controller.abort();
  }
  try {
    prepared.resolve();
    expect(await pending).toMatchObject({ ok: false, active: false, reason: "no_active_run" });
    expect(abort).toHaveBeenCalledTimes(change === "signal" || change === "generation" ? 1 : 0);
  } finally {
    prepared.resolve();
    await Promise.allSettled([pending]);
    registration.cleanup();
  }
});

it.each([
  { source: "queued", override: false },
  { source: "native", override: false },
  { source: "native", override: true },
] as const)(
  "refuses a colliding physical owner after $source control preparation (override=$override)",
  async ({ source, override }) => {
    config.session = { scope: "global" };
    const target = await prepareTalkSessionTarget(config, "main");
    const runId = "prepared-owned-run";
    const sessionId = "prepared-owned-session";
    const { registration, abort } = await registerOwnedRun(runId, sessionId, {
      executionStarted: source === "native",
    });
    const operation = registration.entry.input.claim!.operation!;
    const cancelRun = override ? vi.fn(async () => true) : undefined;
    const { preparing, prepared, pending } = pauseControl(runTarget(target), cancelRun);
    await preparing.promise;
    const foreign = unrelatedRun(target.storePath, sessionId, runId);
    try {
      prepared.resolve();
      expect(await pending).toMatchObject({
        ok: false,
        active: false,
        aborted: false,
        reason: "no_active_run",
      });
      expect(abort).not.toHaveBeenCalled();
      expect(foreign.abort).not.toHaveBeenCalled();
      if (cancelRun) {
        expect(cancelRun).not.toHaveBeenCalled();
      }
      expect(operation.abortSignal.aborted).toBe(false);
      expect(foreign.operation.abortSignal.aborted).toBe(false);
    } finally {
      prepared.resolve();
      await Promise.allSettled([pending]);
      foreign.dispose();
    }
  },
);

it.each(["source", "claim"] as const)(
  "preserves status and cancellation for an owned queued chat.send reply with %s signal",
  async (signalOwner) => {
    config.session = { scope: "global" };
    const { voiceSessionId } = await createNativeTalkCall(dispatch, true);
    const sessionId = loadSessionEntry({ agentId: "voice", sessionKey: "global" })!.sessionId;
    const target = await prepareTalkSessionTarget(config, "main");
    const registration = registerQueuedRun(target, "queued-talk", sessionId);
    if (!registration.registered) {
      throw new Error("Missing queued Talk source");
    }
    const claim = await claimSessionControllerTask(registration.entry.input, (selected) => {
      createReplyOperation({
        ...replyIdentity,
        sessionId,
        upstreamAbortSignal:
          signalOwner === "source"
            ? registration.entry.input.abortSignal
            : selected.abortController.signal,
        mailboxClaim: selected,
        target: registration.entry.input.mailbox.owner.target,
      });
    });
    const operation = claim.operation!;
    onTestFinished(() => {
      operation.complete();
      releaseSessionControllerClaim(claim);
      registration.cleanup();
    });
    const targetRun = runTarget(target);
    const resolvedSessionId = "materialized-reply-session";
    updateRpcSourceSessionId(rpcSourceTesting.get("queued-talk")!, resolvedSessionId);
    operation.updateSessionId(resolvedSessionId);
    await registerClientVoiceConsultRun({
      agentId: "voice",
      sessionKey: "main",
      voiceSessionId: voiceSessionId!,
      runId: "queued-talk",
    });
    const voiceTarget = runTarget(target, {
      kind: "voice-session",
      voiceSessionId: voiceSessionId!,
    });
    try {
      expect(voiceTarget?.isCurrent()).toBe(true);
      registration.cleanup();
      expect(rpcSourceTesting.get("queued-talk")).toBe(registration.entry);
      expect(targetRun?.isCurrent()).toBe(true);
      expect(await control(voiceTarget, "status")).toMatchObject({ active: false });
      expectOk(
        await dispatch("talk.client.steer", { sessionKey: "main", text: "status", mode: "status" }),
        expect.objectContaining({ active: true, sessionId: resolvedSessionId }),
      );
      // Colliding session IDs must not cross the distinct physical controller target.
      const unrelated = unrelatedRun(target.storePath, resolvedSessionId, "queued-talk");
      try {
        expect(await control(targetRun)).toMatchObject({ active: false, aborted: false });
        expect(unrelated.abort).not.toHaveBeenCalled();
        expect(unrelated.operation.abortSignal.aborted).toBe(false);
        expect(operation.abortSignal.aborted).toBe(false);
      } finally {
        unrelated.dispose();
      }
      expectOk(
        await dispatch("talk.client.steer", { sessionKey: "main", text: "cancel", mode: "cancel" }),
        expect.objectContaining({ ok: true, aborted: true, sessionId: resolvedSessionId }),
      );
      expect(operation.abortSignal.aborted).toBe(true);
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(targetRun?.isCurrent()).toBe(false);
      operation.complete();
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
      const successor = createReplyOperation({
        ...replyIdentity,
        sessionId: resolvedSessionId,
        target: registration.entry.input.mailbox.owner.target,
      });
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
  },
);

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
  const originalRequest = expectDefined(requests[0], "original relay provider");
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

    const storedSessionId = loadSessionEntry(sessionScope(original.target))!.sessionId;
    const transcript = readSessionTranscriptMessageEvents({
      agentId: original.target.agentId,
      sessionId: storedSessionId,
      storePath: original.target.storePath,
    });
    expect(transcript).toHaveLength(22);
    expect(transcript[0]?.event).toMatchObject({
      message: { content: [{ type: "text", text: utterances[0]?.trim() }] },
    });
    expect(
      transcript.slice(-2).map(({ event }) => (isRecord(event) ? event.message : undefined)),
    ).toEqual([
      expect.objectContaining({ role: "user", content: [{ type: "text", text: tailUser }] }),
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: tailAssistant }],
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
        awaitGateBeforeSettlement(
          entered.promise,
          consult,
          "Consult completed before voice registration",
        ),
        signal,
      );
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
      if (phase === "status") {
        expect(relayRequest?.handleDelegationInput?.("status", vi.fn())).toBe("control");
      } else if (phase === "cancelled") {
        caller.abort(new Error("Pending native consult cancelled"));
      } else {
        rpcSourceTesting.delete(runId);
        successor = registerQueuedRun(target, runId, "successor-session");
      }
      resume.resolve();
      if (phase === "status") {
        await expect(consult).resolves.toEqual({ text: "Synthetic consult answer" });
        expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(rpcSourceTesting.has(runId)).toBe(false);
      } else {
        await expect(consult).rejects.toThrow(
          phase === "cancelled" ? "Pending native consult cancelled" : "no longer current",
        );
        expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
        if (successor) {
          expect(rpcSourceTesting.get(runId)).toBe(successor.entry);
          expect(successor.controller.signal.aborted).toBe(false);
        } else {
          expect(rpcSourceTesting.has(runId)).toBe(false);
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

it.each(["browser", "relay"] as const)(
  "uses the created custom-main session in the native %s provider callback",
  async (transport) => {
    const canonicalKey = "agent:voice:home";
    config.session = { mainKey: "home", scope: "per-sender" };
    config.talk = { ...config.talk, realtime: { instructions: "Keep native answers brief." } };
    const target = await prepareTalkSessionTarget(config, "main");
    const result = await createNativeTalkCall(dispatch, transport === "browser");
    expect(providerInstructions).toBe(
      `Keep native answers brief.\n\n${REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS}`,
    );
    const storage = { agentId: "voice", sessionKey: canonicalKey, storePath: target.storePath };
    const created = loadSessionEntry(storage);
    expect(created?.sessionId).toBeTruthy();
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
  },
);

it.each(["before admission", "during preparation"] as const)(
  "rejects native consult storage changes %s",
  async (changeAt) => {
    config = { ...config, session: { store: state.statePath("route-a.sqlite") } };
    setRuntimeConfigSnapshot(config);
    const { voiceSessionId } = await createNativeTalkCall(dispatch, true);
    const voiceId = expectDefined(voiceSessionId, "created browser call");
    const providerConsult = expectDefined(callback, "provider-owned consult callback");
    providerConsult.adoptCompletionClaims?.();
    const retained = resolveTalkVoiceSession({
      kind: "client",
      connId: client.connId,
      voiceSessionId: voiceId,
    }).sessionTarget;
    const readVoice = () =>
      dispatch("talk.voice.get", { voiceSessionId: voiceId }, talkVoiceHandlers);
    const oldScope = sessionScope(retained);
    expectOk(await readVoice());
    await expect(providerConsult({ prompt: "Before the store change" })).resolves.toEqual({
      text: "Synthetic consult answer",
    });
    providerConsult.claimAppend?.();
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
    const before = expectDefined(loadSessionEntry(oldScope), "ordinary consult session persisted");
    await replaceSessionEntry(oldScope, { ...before, updatedAt: 1 });

    const preparing = createDeferredCore();
    const resume = createDeferredCore();
    if (changeAt === "during preparation") {
      const ensureWorkspace = workspace.ensureAgentWorkspace;
      const preparation = vi
        .spyOn(workspace, "ensureAgentWorkspace")
        .mockImplementationOnce(async (...args) => {
          const result = await ensureWorkspace(...args);
          preparing.resolve();
          await resume.promise;
          return result;
        });
      onTestFinished(() => preparation.mockRestore());
    }
    const consult = () =>
      providerConsult({ prompt: "A new consultation" }).then(
        () => {
          providerConsult.claimAppend?.();
        },
        (error: unknown) => {
          providerConsult.claimFailureAppend?.();
          return error;
        },
      );
    const pending = changeAt === "during preparation" ? consult() : undefined;
    try {
      if (pending) {
        await awaitGateBeforeSettlement(
          preparing.promise,
          pending,
          "Consult must reach preparation",
        );
      }
      config = {
        ...config,
        session: { ...config.session, store: state.statePath("route-b.sqlite") },
      };
      setRuntimeConfigSnapshot(config);
      const fresh = await prepareTalkSessionTarget(config, retained.sessionKey);
      expect(fresh.storePath).not.toBe(retained.storePath);
      fresh.assertCurrent(config);
      const changed = "Talk session storage target changed; retry the request";
      expect(() => retained.assertCurrent(config)).toThrow(changed);
      expectDenied(await readVoice(), {
        code: "UNAVAILABLE",
        message: expect.stringContaining(changed),
      });
      resume.resolve();
      expect(await (pending ?? consult())).toEqual(new Error(changed));
      expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(loadSessionEntry(oldScope)).toMatchObject({
        sessionId: before.sessionId,
        updatedAt: 1,
      });
      expect(loadSessionEntry(sessionScope(fresh))).toBeUndefined();
    } finally {
      resume.resolve();
      await pending;
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
