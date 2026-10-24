import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { requestRpcSourceCancellation } from "../../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { drainGlobalSingletonLifecycleState } from "../../../shared/global-singleton.js";
import { captureOpenClawStateDatabaseReadAdmission } from "../../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { resolveRealtimeVoiceProviderCapabilitiesAsync } from "../../../talk/provider-resolver.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceAgentConsultRunner,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceProviderCapabilities,
} from "../../../talk/provider-types.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { createChatRunState } from "../../server-chat-state.js";
import { createRpcSourceForTest, claimRpcSourceForTest } from "../../test-helpers.rpc-source.js";
import { cleanupTalkConnection, prepareTalkConnectionClose } from "../session-registry.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import {
  completeTalkVoiceChange,
  prepareTalkVoiceReplacement,
  registerTalkVoiceSession,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
} from "../voice-selection.js";
import { bindTalkRealtimeRelayAgentConsult } from "./agent-consult.js";
import {
  createIdleRelayProvider,
  createRelayAgentConfig,
  ensureActiveRelayTurnId,
  makeRelayTransport,
  observeRelayTranscriptFailures,
} from "./index.test-support.js";
import { resolveTalkRealtimeRelayPresentation } from "./issues.js";
import {
  acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn,
  closeRelaySession,
  ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites,
  registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun,
  submitTalkRealtimeRelayToolResult,
  stopTalkRealtimeRelaySession as stopTalkRealtimeRelaySessionRaw,
} from "./operations.js";
import { createTalkRealtimeRelaySession as createTalkRealtimeRelaySessionRaw } from "./session-create.js";
import { usePersistentRelayTestState } from "./session-state.test-support.js";
import { drainingRelaySessions, relaySessions, type RelayAgentRun } from "./state.js";
import { MAX_RELAY_TOOL_CALL_IDENTITIES } from "./tool-call-ledger.js";

const activeRelaySessions = new Map<string, string>();
const relayRunSettlements: Array<() => Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const RELAY_AUTH_ERROR =
  "Realtime provider authentication failed. Check the provider credentials and try again.";
const RELAY_CONFIG_ERROR =
  "Realtime session configuration was rejected. Check the provider and model settings.";
const RELAY_RETRY_ERROR = "Realtime provider cannot start this session right now. Try again later.";
const RELAY_UNAVAILABLE_ERROR = "Realtime provider is unavailable. Try again later.";
const RELAY_GENERIC_ERROR = "Realtime provider error.";
const CANCELLED_RESULT = {
  status: "cancelled",
  message: "OpenClaw cancelled this consult before completion. Do not restart it.",
};
const DELIVERED_RESULT = {
  status: "already_delivered",
  message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
};
const providerErrorCases = [
  ["retry later", { status: 429, message: "raw-rate-marker" }, RELAY_RETRY_ERROR],
  ["unavailable", { status: 503, message: "raw-unavailable-marker" }, RELAY_UNAVAILABLE_ERROR],
] as const;

type RelaySessionParams = Parameters<typeof createTalkRealtimeRelaySessionRaw>[0];
type RelayFixtureDefaults = "connId" | "providerConfig" | "instructions" | "tools";

function stopTalkRealtimeRelaySession(
  params: Parameters<typeof stopTalkRealtimeRelaySessionRaw>[0],
): ReturnType<typeof stopTalkRealtimeRelaySessionRaw> {
  const stopped = stopTalkRealtimeRelaySessionRaw(params);
  activeRelaySessions.delete(params.relaySessionId);
  return stopped;
}

async function createTalkRealtimeRelaySession(
  params: Omit<RelaySessionParams, "sessionTarget" | "controlSource" | RelayFixtureDefaults> &
    Partial<Pick<RelaySessionParams, RelayFixtureDefaults>> & { sessionKey?: string },
): Promise<ReturnType<typeof createTalkRealtimeRelaySessionRaw>> {
  const {
    sessionKey,
    connId = "conn-1",
    providerConfig = {},
    instructions = "brief",
    tools = [],
    ...request
  } = params;
  const cfg = params.cfg ?? { agents: { entries: { main: {} } } };
  const capabilities = await resolveRealtimeVoiceProviderCapabilitiesAsync({
    provider: params.provider,
    providerConfig,
    cfg,
    model: params.model,
    surface: "gateway-relay",
  });
  const session = createTalkRealtimeRelaySessionRaw({
    ...request,
    connId,
    providerConfig,
    instructions,
    tools,
    controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
    capabilities,
    context: request.context,
    cfg,
    sessionTarget: await prepareTalkSessionTarget(cfg, sessionKey ?? "agent:main:main"),
  });
  activeRelaySessions.set(session.relaySessionId, connId);
  return session;
}

function indexRpcSourceForTest(ref: ReturnType<typeof createRpcSourceForTest>) {
  rpcSourceTesting.set("run-1", ref);
  void ref.input.settlement.promise.finally(() => rpcSourceTesting.deleteExpected("run-1", ref));
}

async function claimRelayRunForTest(
  source: ReturnType<typeof createRpcSourceForTest>,
  backend?: Parameters<typeof attachActiveEmbeddedRun>[1],
) {
  const release = await claimRpcSourceForTest(source);
  const claim = source.input.claim!;
  const sessionId = source.input.sourceSessionId ?? "";
  const attachment = backend
    ? attachActiveEmbeddedRun(
        sessionId,
        backend,
        source.input.mailbox.key,
        undefined,
        "main",
        claim.operation!,
      )
    : undefined;
  let finished: Promise<void> | undefined;
  const finish = () =>
    (finished ??= Promise.resolve().then(async () => {
      source.input.abortSignal.removeEventListener("abort", onAbort);
      try {
        if (backend && attachment) {
          detachActiveEmbeddedRun(
            sessionId,
            backend,
            source.input.mailbox.key,
            undefined,
            "run_completed",
            attachment,
          );
        }
      } finally {
        release();
      }
      await claim.settlement.promise;
    }));
  // The fixture is the producer: cancellation requests end its work on the next microtask.
  const onAbort = () => {
    void finish();
  };
  source.input.abortSignal.addEventListener("abort", onAbort, { once: true });
  relayRunSettlements.push(finish);
}

async function createOwnedTalkRunControllers(
  backend?: Parameters<typeof attachActiveEmbeddedRun>[1],
) {
  const target = await prepareTalkSessionTarget({}, "main");
  const ref = createRpcSourceForTest(
    {
      requester: { connectionId: "conn-1" },
      kind: "chat-send",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    },
    {
      runId: "run-1",
      sessionId: "embedded-session-1",
      sessionKey: "agent:main:main",
      agentId: "main",
      storeScope: target.storePath,
    },
  );
  await claimRelayRunForTest(ref, backend);
  indexRpcSourceForTest(ref);
}

/** Gateway context fields that exact-run Stop presentation reads. */
function stopCapableContext() {
  return {
    getRuntimeConfig: () => ({}),
    chatRunState: createChatRunState(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
  };
}

function createRelayContext(overrides: Record<string, unknown> = {}) {
  return {
    broadcastToConnIds: vi.fn(),
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn() },
    ...overrides,
  } as never;
}

function relayTarget(session: { relaySessionId: string }, connId = "conn-1") {
  return { relaySessionId: session.relaySessionId, connId };
}

function submitResult(
  session: { relaySessionId: string },
  callId: string,
  result: Parameters<typeof submitTalkRealtimeRelayToolResult>[0]["result"],
  options?: Parameters<typeof submitTalkRealtimeRelayToolResult>[0]["options"],
) {
  return submitTalkRealtimeRelayToolResult({ ...relayTarget(session), callId, result, options });
}

function registerRun(
  session: { relaySessionId: string },
  callId: string | undefined,
  runId = "run-1",
  sessionKey = "agent:main:main",
) {
  return registerTalkRealtimeRelayAgentRun({ ...relayTarget(session), callId, runId, sessionKey });
}

function cancelTurn(
  session: { relaySessionId: string },
  turnId?: string,
  reason?: Parameters<typeof cancelTalkRealtimeRelayTurn>[0]["reason"],
) {
  return cancelTalkRealtimeRelayTurn({ ...relayTarget(session), turnId, reason });
}

function transmitAudio(
  session: { relaySessionId: string },
  audioBase64: string,
  timestamp?: number,
) {
  return sendTalkRealtimeRelayAudio({ ...relayTarget(session), audioBase64, timestamp });
}

function providerEvent(
  request: RealtimeVoiceBridgeCreateRequest | undefined,
  type: string,
  fields: Omit<
    Parameters<NonNullable<RealtimeVoiceBridgeCreateRequest["onEvent"]>>[0],
    "type" | "direction"
  > = {},
) {
  request?.onEvent?.({ direction: "server", type, ...fields });
}

function consultCall(
  request: RealtimeVoiceBridgeCreateRequest | undefined,
  itemId: string,
  callId: string,
  question: string,
) {
  request?.onToolCall?.({ itemId, callId, name: "openclaw_agent_consult", args: { question } });
}

function eventPayloads(events: Array<{ payload: unknown }>, type: string, callId?: string) {
  return events
    .map(({ payload }) => payload)
    .filter(
      (payload): payload is Record<string, unknown> =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as Record<string, unknown>).type === type &&
        (callId === undefined || (payload as Record<string, unknown>).callId === callId),
    );
}

function captureProvider(createBridge: () => RealtimeVoiceBridge) {
  let request: RealtimeVoiceBridgeCreateRequest | undefined;
  return {
    provider: createIdleRelayProvider((input) => {
      request = input;
      return createBridge();
    }),
    get request() {
      return request;
    },
  };
}

function mockEventPayloads(mock: ReturnType<typeof vi.fn>, type: string) {
  return eventPayloads(
    mock.mock.calls.map(([, payload]) => ({ payload })),
    type,
  );
}

function embeddedBackend(abort = vi.fn()) {
  return {
    runId: "run-1",
    queueMessage: vi.fn(async () => undefined),
    isStreaming: () => true,
    isCompacting: () => false,
    abort,
  };
}

describe("talk realtime relay helpers", () => {
  it.each(providerErrorCases)(
    "projects public %s failures to fixed copy",
    (_name, error, expected) => {
      const message = resolveTalkRealtimeRelayPresentation({
        provider: createIdleRelayProvider(),
        providerConfig: {},
      }).publicError(error).message;

      expect(message).toBe(expected);
      expect(message).not.toContain(error.message);
    },
  );

  it("rejects a late relay startup-failure claim while consuming the retained owner", () => {
    const adoptCompletionClaims = vi.fn();
    const claimFailureAppend = vi.fn(() => true);
    const runPrompt = Object.assign(
      vi.fn<RealtimeVoiceAgentConsultRunner>(async () => ({ text: "done" })),
      {
        adoptCompletionClaims,
        claimAppend: vi.fn(() => true),
        claimFailureAppend,
      },
    );
    let current = true;
    const runAgentConsult = bindTalkRealtimeRelayAgentConsult(
      runPrompt,
      () => current,
      async () => {},
    );
    runAgentConsult.adoptCompletionClaims();
    expect(adoptCompletionClaims).toHaveBeenCalledOnce();
    current = false;

    expect(runAgentConsult.claimFailureAppend()).toBe(false);
    expect(claimFailureAppend).toHaveBeenCalledOnce();
  });

  it("forwards requester-final revocation through the relay wrapper", () => {
    const revokeRequesterFinal = vi.fn();
    const runPrompt = Object.assign(
      vi.fn<RealtimeVoiceAgentConsultRunner>(async () => ({ text: "done" })),
      {
        adoptCompletionClaims: vi.fn(),
        claimAppend: vi.fn(() => true),
        claimFailureAppend: vi.fn(() => true),
        revokeRequesterFinal,
      },
    );
    const runAgentConsult = bindTalkRealtimeRelayAgentConsult(
      runPrompt,
      () => true,
      async () => {},
    );

    runAgentConsult.revokeRequesterFinal();

    expect(revokeRequesterFinal).toHaveBeenCalledOnce();
  });
});

describe("talk realtime gateway relay", () => {
  const { cleanupIsolatedRelayState } = usePersistentRelayTestState(
    activeRelaySessions,
    async () => {
      for (const finish of relayRunSettlements.splice(0)) {
        await finish();
      }
    },
  );

  // Regression for #139278: forced consults must not disable interruption.
  it.each([
    { forced: true, interrupt: undefined, expectedInterrupt: true },
    { forced: false, interrupt: undefined, expectedInterrupt: true },
    { forced: false, interrupt: false, expectedInterrupt: false },
    { forced: true, interrupt: false, expectedInterrupt: false },
  ])(
    "resolves forced audio routing $forced independently of interruption $interrupt",
    async ({ forced, interrupt, expectedInterrupt }) => {
      const captured = captureProvider(() => makeRelayTransport());
      await createTalkRealtimeRelaySession({
        context: { broadcastToConnIds: vi.fn() } as never,
        provider: captured.provider,
        providerConfig: interrupt === undefined ? {} : { interruptResponseOnInputAudio: interrupt },
        forceAgentConsultOnFinalTranscript: forced,
      });
      expect(captured.request).toMatchObject({
        autoRespondToAudio: !forced,
        interruptResponseOnInputAudio: expectedInterrupt,
      });
    },
  );

  it.each([
    [
      { status: "failed" as const, responseId: "response-1", message: "provider failed" },
      "turn.ended",
    ],
    [
      {
        status: "incomplete" as const,
        responseId: "response-1",
        reason: "max_output_tokens",
        message: "provider response incomplete",
      },
      "turn.ended",
    ],
    [
      { status: "cancelled" as const, responseId: "response-1", reason: "client_cancelled" },
      "turn.cancelled",
    ],
  ])("keeps a relay reusable after each terminal response", async (outcome, terminalType) => {
    const close = vi.fn();
    const captured = captureProvider(() => makeRelayTransport({ close }));
    const { provider } = captured;
    const events: Array<{ payload: unknown; delivery?: { dropIfSlow?: boolean } }> = [];
    const context = {
      broadcastToConnIds: (
        _event: string,
        payload: unknown,
        _owners: Set<string>,
        delivery?: { dropIfSlow?: boolean },
      ) => events.push({ payload, delivery }),
    } as never;
    const session = await createTalkRealtimeRelaySession({
      context,
      provider,
      instructions: "be brief",
    });
    await Promise.resolve();
    if (!captured.request) {
      throw new Error("expected realtime bridge request");
    }

    void transmitAudio(session, Buffer.from("first").toString("base64"), 1);
    expect(
      events.some(({ payload }) => (payload as { type?: string }).type === "responseStarted"),
    ).toBe(false);
    providerEvent(captured.request, "response.created", { responseId: outcome.responseId });
    expect(events.at(-1)).toMatchObject({
      payload: {
        type: "responseStarted",
        relaySessionId: session.relaySessionId,
        turnId: expect.any(String),
      },
      delivery: { dropIfSlow: false },
    });
    const firstTurnId = findEventPayload(events, "responseStarted").turnId;
    captured.request.onResponseDone?.(outcome);
    providerEvent(captured.request, "response.done", { responseId: outcome.responseId });

    const firstPayloads = events.map(({ payload }) => payload as Record<string, unknown>);
    const firstTalkEvents = firstPayloads
      .map((payload) => payload.talkEvent)
      .filter((event): event is Record<string, unknown> => Boolean(event));
    expect(firstTalkEvents.filter((event) => event.type === terminalType)).toHaveLength(1);
    expect(firstPayloads.filter((payload) => payload.type === "error")).toHaveLength(
      outcome.status === "failed" || outcome.status === "incomplete" ? 1 : 0,
    );
    expect(firstPayloads.filter((payload) => payload.type === "audioDone")).toEqual([
      expect.objectContaining({ talkEvent: expect.objectContaining({ turnId: firstTurnId }) }),
    ]);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(close).not.toHaveBeenCalled();

    void transmitAudio(session, Buffer.from("later").toString("base64"), 2);
    providerEvent(captured.request, "response.created", { responseId: "response-2" });
    expect(events.at(-1)?.payload).toMatchObject({
      type: "responseStarted",
      turnId: expect.any(String),
    });
    expect(events.at(-1)?.payload).not.toMatchObject({ turnId: firstTurnId });
    captured.request.onResponseDone?.({ status: "completed" });
    providerEvent(captured.request, "response.done", { responseId: "response-2" });

    expect(
      events.filter(
        ({ payload }) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "audioDone",
      ),
    ).toHaveLength(2);
    expect(events.at(-1)?.payload).toMatchObject({
      type: "audioDone",
      talkEvent: { type: "turn.ended" },
    });
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it("redacts failed response outcome details from relay broadcasts", async () => {
    const { session, captured, events } = await createEventRelay(makeRelayTransport(), {
      instructions: "be brief",
    });
    if (!captured.request) {
      throw new Error("expected realtime bridge request");
    }

    void transmitAudio(session, Buffer.from("audio").toString("base64"), 1);
    providerEvent(captured.request, "response.created", { responseId: "response-sensitive" });
    const markers = {
      message: "raw-outcome-message",
      reason: "raw-outcome-reason",
      errorMessage: "raw-error-message",
      errorCode: "raw-error-code",
      errorType: "raw-error-type",
    };
    captured.request.onResponseDone?.({
      status: "incomplete",
      responseId: "response-sensitive",
      message: markers.message,
      reason: markers.reason,
      error: {
        message: markers.errorMessage,
        code: markers.errorCode,
        type: markers.errorType,
      },
    });

    const errorPayload = findEventPayload(events, "error");
    expectRecordFields(errorPayload, { type: "error", message: RELAY_GENERIC_ERROR });
    const talkEvent = expectRecordFields(errorPayload.talkEvent, {
      type: "session.error",
      final: true,
    });
    expectRecordFields(talkEvent.payload, {
      code: "realtime_unavailable",
      message: RELAY_GENERIC_ERROR,
    });
    const broadcastJson = JSON.stringify(events);
    for (const marker of Object.values(markers)) {
      expect(broadcastJson).not.toContain(marker);
    }
  });

  function createRelayEventRecorder() {
    const events: Array<{
      event: string;
      payload: unknown;
      connIds: string[];
      opts?: { dropIfSlow?: boolean };
    }> = [];
    const context = {
      broadcastToConnIds: (
        event: string,
        payload: unknown,
        connIds: ReadonlySet<string>,
        opts?: { dropIfSlow?: boolean },
      ) => events.push({ event, payload, connIds: [...connIds], opts }),
    } as never;
    return { events, context };
  }

  async function createEventRelay(
    bridge: RealtimeVoiceBridge = makeRelayTransport(),
    options: Omit<
      Parameters<typeof createTalkRealtimeRelaySession>[0],
      "provider" | "context"
    > = {},
  ) {
    const captured = captureProvider(() => bridge);
    const { events, context } = createRelayEventRecorder();
    const session = await createTalkRealtimeRelaySession({
      context,
      provider: captured.provider,
      ...options,
    });
    await Promise.resolve();
    return { session, captured, events, bridge };
  }

  it("closes only realtime relays owned by the disconnected connection", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = tempDirs.make("openclaw-relay-disconnect-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const bridgeCloses: Array<ReturnType<typeof vi.fn>> = [];
    const bridgeAudioSends: Array<ReturnType<typeof vi.fn>> = [];
    const bridgeRequests: RealtimeVoiceBridgeCreateRequest[] = [];
    const bridgeToolResults: Array<ReturnType<typeof vi.fn>> = [];
    const lateConnect = createDeferred();
    const provider = createIdleRelayProvider((request) => {
      const bridgeIndex = bridgeCloses.length;
      const close = vi.fn();
      const sendAudio = vi.fn();
      const submitToolResult = vi.fn();
      bridgeRequests.push(request);
      bridgeCloses.push(close);
      bridgeAudioSends.push(sendAudio);
      bridgeToolResults.push(submitToolResult);
      return makeRelayTransport({
        connect: vi.fn(() => (bridgeIndex === 1 ? lateConnect.promise : Promise.resolve())),
        sendAudio,
        submitToolResult,
        close,
      });
    });
    try {
      const logGateway = { warn: vi.fn() };
      const broadcastToConnIds = vi.fn();
      const context = createRelayContext({ broadcastToConnIds, logGateway });
      const createSession = (connId: string) =>
        createTalkRealtimeRelaySession({
          context,
          connId,
          provider,
        });
      const firstOwned = await createSession("conn-owner");
      await ensureTalkRealtimeRelayVoiceSession({
        relaySessionId: firstOwned.relaySessionId,
        connId: "conn-owner",
        sessionKey: "agent:main:main",
      });
      expect(clientVoiceSessionTesting.readRecord("main", firstOwned.relaySessionId)).toMatchObject(
        {
          status: "open",
        },
      );
      const secondOwned = await createSession("conn-owner");
      const unrelated = await createSession("conn-other");
      bridgeCloses[0]?.mockImplementationOnce(() => {
        throw new Error("provider close failed");
      });

      expect(() => cleanupTalkConnection("conn-owner", logGateway)).not.toThrow();
      lateConnect.reject(new Error("late connect failure"));
      await Promise.allSettled([lateConnect.promise]);

      expect(bridgeCloses[0]).toHaveBeenCalledOnce();
      expect(bridgeCloses[1]).toHaveBeenCalledOnce();
      expect(bridgeCloses[2]).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(
          clientVoiceSessionTesting.readRecord("main", firstOwned.relaySessionId)?.status,
        ).toBe("closed"),
      );
      expect(logGateway.warn).toHaveBeenCalledWith(
        "failed to close realtime relay session: provider close failed",
      );
      expect(
        broadcastToConnIds.mock.calls.some(
          ([event, payload]) =>
            event === "talk.event" &&
            payload.relaySessionId === firstOwned.relaySessionId &&
            payload.type === "close" &&
            payload.talkEvent?.type === "session.closed" &&
            payload.talkEvent.final === true,
        ),
      ).toBe(true);
      expect(
        broadcastToConnIds.mock.calls.some(
          ([event, payload]) =>
            event === "talk.event" &&
            payload.relaySessionId === secondOwned.relaySessionId &&
            payload.type === "error",
        ),
      ).toBe(false);
      const eventCountAfterClose = broadcastToConnIds.mock.calls.length;
      const lateRequest = bridgeRequests[0];
      if (!lateRequest?.runAgentConsult) {
        throw new Error("expected relay provider request to include the agent consult runner");
      }
      lateRequest.onReady?.();
      lateRequest.onError?.(new Error("late provider error"));
      providerEvent(lateRequest, "response.created", { responseId: "late-response" });
      lateRequest.onEvent?.({ direction: "server", type: "response.done" });
      lateRequest.onAudio(Buffer.from("late audio"));
      lateRequest.onClearAudio("barge-in");
      lateRequest.onMark?.("late-mark");
      lateRequest.onTranscript?.("user", "late transcript", true);
      consultCall(lateRequest, "late-item", "late-call", "late consult");
      lateRequest.onClose?.("error");
      await expect(lateRequest.runAgentConsult({ prompt: "late direct consult" })).rejects.toThrow(
        "Realtime gateway-relay session is closed",
      );
      await Promise.resolve();
      expect(broadcastToConnIds).toHaveBeenCalledTimes(eventCountAfterClose);
      expect(bridgeToolResults[0]).not.toHaveBeenCalled();
      expect(
        () =>
          void sendTalkRealtimeRelayAudio({
            relaySessionId: firstOwned.relaySessionId,
            connId: "conn-owner",
            audioBase64: "AQI=",
          }),
      ).toThrow("Unknown realtime relay session");
      expect(
        () =>
          void sendTalkRealtimeRelayAudio({
            relaySessionId: secondOwned.relaySessionId,
            connId: "conn-owner",
            audioBase64: "AQI=",
          }),
      ).toThrow("Unknown realtime relay session");

      void sendTalkRealtimeRelayAudio({
        relaySessionId: unrelated.relaySessionId,
        connId: "conn-other",
        audioBase64: "AQI=",
      });
      expect(bridgeAudioSends[2]).toHaveBeenCalledOnce();
      void stopTalkRealtimeRelaySession({
        relaySessionId: unrelated.relaySessionId,
        connId: "conn-other",
      });
      cleanupTalkConnection("conn-other", logGateway);
      expect(bridgeCloses[2]).toHaveBeenCalledOnce();
    } finally {
      await cleanupIsolatedRelayState(tempDir);
      clientVoiceSessionTesting.reset();
      envSnapshot.restore();
    }
  });

  it("rejects a consult when its relay is replaced during startup", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider = createIdleRelayProvider((request) => {
      bridgeRequest = request;
      return createIdleRelayProvider().createBridge(request);
    });
    const session = await createTalkRealtimeRelaySession({
      context: createRelayContext(),
      connId: "conn-replaced-runner",
      provider,
    });
    const original = relaySessions.get(session.relaySessionId);
    const runAgentConsult = bridgeRequest?.runAgentConsult;
    if (!original || !runAgentConsult) {
      throw new Error("expected active relay agent runner");
    }
    expect(bridgeRequest?.agentId).toBe("main");

    const run = runAgentConsult({ prompt: "late consult", signal: AbortSignal.timeout(1_000) });
    const replacement = { ...original, activeAgentRuns: new Map<string, RelayAgentRun>() };
    relaySessions.set(session.relaySessionId, replacement);
    try {
      await expect(run).rejects.toThrow("Realtime gateway-relay session is closed");
      expect(replacement.activeAgentRuns.size).toBe(0);
    } finally {
      relaySessions.set(session.relaySessionId, original);
      void stopTalkRealtimeRelaySession({
        relaySessionId: session.relaySessionId,
        connId: "conn-replaced-runner",
      });
    }
  });

  it.each([
    {
      name: "error before close",
      closesBridge: true,
      terminate: (request: RealtimeVoiceBridgeCreateRequest) => {
        request.onError?.(
          Object.assign(new Error("raw-synchronous-callback-marker"), { status: 401 }),
        );
        request.onClose?.("error");
      },
      expectedError: RELAY_AUTH_ERROR,
      rawMarker: "raw-synchronous-callback-marker",
    },
    {
      name: "close before error",
      closesBridge: true,
      terminate: (request: RealtimeVoiceBridgeCreateRequest) => {
        request.onClose?.("completed");
        request.onError?.(new Error("late provider error"));
      },
      expectedError: "Realtime provider closed during session creation: completed",
      rawMarker: "late provider error",
    },
    {
      name: "construction failure",
      closesBridge: false,
      terminate: () => {
        throw Object.assign(new Error("raw-construction-marker"), { status: 404 });
      },
      expectedError: RELAY_CONFIG_ERROR,
      rawMarker: "raw-construction-marker",
    },
  ])(
    "rejects a synchronous provider $name during bridge creation",
    async ({ terminate, expectedError, rawMarker, closesBridge }) => {
      const connect = vi.fn(async () => undefined);
      const sendAudio = vi.fn();
      const close = vi.fn();
      const bridge = makeRelayTransport({
        connect,
        sendAudio,
        close,
      });
      const provider = createIdleRelayProvider((request) => {
        terminate(request);
        return bridge;
      });
      const broadcastToConnIds = vi.fn();

      let thrown: unknown;
      try {
        await createTalkRealtimeRelaySession({
          context: createRelayContext({ broadcastToConnIds }),
          connId: "conn-early-terminal",
          provider,
          ...(!closesBridge ? { model: "gpt-realtime-test-public" } : {}),
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(expectedError);
      expect((thrown as Error).message).not.toContain(rawMarker);
      expect(connect).not.toHaveBeenCalled();
      expect(sendAudio).not.toHaveBeenCalled();
      if (closesBridge) {
        expect(close).toHaveBeenCalledOnce();
      }
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["agent:main:main", "agent:main:main", "main", "per-sender" as const],
    ["main", "agent:main:work", "work", "per-sender" as const],
    ["agent:main:main", "global", "main", "global" as const],
  ])(
    "appends relay transcripts from %s to %s",
    async (sessionKey, canonicalKey, mainKey, scope) => {
      const outerStateAdmission = captureOpenClawStateDatabaseReadAdmission(
        resolveOpenClawStateSqlitePath(),
      );
      const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
      const tempDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-voice-")),
      );
      setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
      const storePath = path.join(tempDir, "configured", "sessions.sqlite");
      const cfg: OpenClawConfig = { session: { store: storePath, mainKey, scope } };
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      try {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: canonicalKey, storePath },
          { sessionId: "relay-voice-session", updatedAt: Date.now() },
        );
        const provider = createIdleRelayProvider((request) => {
          bridgeRequest = request;
          return createIdleRelayProvider().createBridge?.(request) as RealtimeVoiceBridge;
        });
        const session = await createTalkRealtimeRelaySession({
          context: createRelayContext(),
          connId: "conn-voice",
          cfg,
          provider,
          sessionKey,
        });
        bridgeRequest?.onTranscript?.("user", "relay hello", true);
        bridgeRequest?.onTranscript?.("assistant", "relay response", true);
        await flushTalkRealtimeRelayVoiceWrites({
          relaySessionId: session.relaySessionId,
          connId: "conn-voice",
        });

        const events = readSessionTranscriptMessageEvents({
          agentId: "main",
          sessionId: "relay-voice-session",
          storePath,
        });
        expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)).toMatchObject({
          agentId: "main",
          sessionKey,
          origin: "relay",
        });
        expect(events).toHaveLength(2);
        expect(events[0]?.event).toMatchObject({
          id: `voice:${session.relaySessionId}:1`,
          message: { role: "user", content: [{ type: "text", text: "relay hello" }] },
        });
        expect(events[1]?.event).toMatchObject({
          id: `voice:${session.relaySessionId}:2`,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "relay response" }],
            api: "realtime",
            provider: "relay-test",
            model: "realtime-voice",
          },
        });
        void stopTalkRealtimeRelaySession({
          relaySessionId: session.relaySessionId,
          connId: "conn-voice",
        });
        await vi.waitFor(() =>
          expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
            "closed",
          ),
        );
      } finally {
        await cleanupIsolatedRelayState(tempDir);
        envSnapshot.restore();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
      // Nested relay storage cannot revoke the beforeEach fixture or its worker leases.
      expect(() => outerStateAdmission.assertCurrent()).not.toThrow();
    },
  );

  it("emits one terminal error and close when transcript persistence overflows", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = tempDirs.make("openclaw-relay-voice-overflow-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    setRuntimeConfigSnapshot({});
    const bridgeClose = vi.fn();
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const { promise: queueBlocked, resolve: releaseQueue } = createDeferred();
    try {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "relay-voice-overflow-session", updatedAt: Date.now() },
      );
      const captured = captureProvider(() =>
        makeRelayTransport({
          close: bridgeClose,
        }),
      );
      const { provider } = captured;
      const session = await createTalkRealtimeRelaySession({
        context: createRelayContext({
          broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
            events.push({ event, payload, connIds: [...connIds] });
          },
        }),
        connId: "conn-voice-overflow",
        provider,
      });
      const relay = relaySessions.get(session.relaySessionId);
      if (!relay) {
        throw new Error("expected active relay");
      }
      relay.voiceTranscriptQueue.enqueue(async () => await queueBlocked);

      for (let index = 0; index < 10_000; index += 1) {
        captured.request?.onTranscript?.("user", `message ${index}`, true);
      }

      const errorPayloads = eventPayloads(events, "error");
      const closePayloads = eventPayloads(events, "close");
      expect(errorPayloads).toHaveLength(1);
      expect(errorPayloads[0]).toMatchObject({
        relaySessionId: session.relaySessionId,
        type: "error",
        message: expect.stringContaining("persistence could not keep up"),
      });
      expect(errorPayloads[0]).not.toHaveProperty("code");
      expect(closePayloads).toEqual([
        expect.objectContaining({
          relaySessionId: session.relaySessionId,
          type: "close",
          reason: "error",
        }),
      ]);
      expect(bridgeClose).toHaveBeenCalledOnce();
      expect(relaySessions.has(session.relaySessionId)).toBe(false);
      expect(drainingRelaySessions.has(relay)).toBe(true);

      await createTalkRealtimeRelaySession({
        context: createRelayContext(),
        connId: "conn-voice-overflow",
        provider,
      });
      await expect(
        createTalkRealtimeRelaySession({
          context: createRelayContext(),
          connId: "conn-voice-overflow",
          provider,
        }),
      ).rejects.toThrow("Too many active realtime relay sessions for this connection");

      releaseQueue();
      await relay.voiceSessionClose;
      expect(drainingRelaySessions.has(relay)).toBe(false);
      expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
        "closed",
      );
    } finally {
      releaseQueue();
      await cleanupIsolatedRelayState(tempDir);
      envSnapshot.restore();
    }
  });

  it("creates the relay voice record before binding a transcript-free consult", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-voice-consult-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    try {
      const session = await createTalkRealtimeRelaySession({
        context: createRelayContext(),
        connId: "conn-consult",
        cfg: {},
        provider: createIdleRelayProvider(),
      });
      expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)).toBeUndefined();

      await registerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-consult",
        sessionKey: "agent:main:main",
        runId: "run-before-transcript",
      });
      await registerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-consult",
        sessionKey: "agent:main:other",
        runId: "run-other-session",
      });

      expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)).toMatchObject({
        status: "open",
        consultRunIds: ["run-before-transcript", "run-other-session"],
      });
      void stopTalkRealtimeRelaySession({
        relaySessionId: session.relaySessionId,
        connId: "conn-consult",
      });
      await vi.waitFor(() =>
        expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
          "closed",
        ),
      );
    } finally {
      await cleanupIsolatedRelayState(tempDir);
      clientVoiceSessionTesting.reset();
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    { sessionKey: "main", initialAgent: "main", close: true },
    { sessionKey: " agent:main:main ", initialAgent: "ops", close: false },
  ] as const)(
    "pins the relay owner for $sessionKey",
    async ({ sessionKey, initialAgent, close }) => {
      const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
      const tempDir = tempDirs.make("openclaw-relay-owner-pin-");
      setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
      let runtimeConfig = createRelayAgentConfig(initialAgent);
      try {
        const session = createTalkRealtimeRelaySessionRaw({
          controlSource: "transcript",
          context: {
            broadcastToConnIds: vi.fn(),
            getRuntimeConfig: () => runtimeConfig,
            logGateway: { warn: vi.fn() },
          } as never,
          connId: "conn-owner-pin",
          provider: createIdleRelayProvider(),
          providerConfig: {},
          instructions: "brief",
          tools: [],
          sessionTarget: await prepareTalkSessionTarget(runtimeConfig, sessionKey),
        });
        activeRelaySessions.set(session.relaySessionId, "conn-owner-pin");
        runtimeConfig = createRelayAgentConfig("ops");
        await ensureTalkRealtimeRelayVoiceSession({
          relaySessionId: session.relaySessionId,
          connId: "conn-owner-pin",
          sessionKey: sessionKey.trim(),
        });
        if (close) {
          void stopTalkRealtimeRelaySession({
            relaySessionId: session.relaySessionId,
            connId: "conn-owner-pin",
          });
          await vi.waitFor(() =>
            expect(
              clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status,
            ).toBe("closed"),
          );
        } else {
          expect(
            clientVoiceSessionTesting.readRecord("main", session.relaySessionId),
          ).toMatchObject({
            status: "open",
          });
        }
        expect(clientVoiceSessionTesting.readRecord("ops", session.relaySessionId)).toBeUndefined();
      } finally {
        await cleanupIsolatedRelayState(tempDir);
        envSnapshot.restore();
      }
    },
  );

  it("logs relay transcript append failures", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-voice-failure-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const warn = vi.fn();
    const failures = observeRelayTranscriptFailures();
    try {
      vi.useFakeTimers();
      const provider = createIdleRelayProvider((request) => {
        bridgeRequest = request;
        return createIdleRelayProvider().createBridge?.(request) as RealtimeVoiceBridge;
      });
      const session = await createTalkRealtimeRelaySession({
        context: createRelayContext({ logGateway: { warn } }),
        connId: "conn-voice-failure",
        cfg: {},
        provider,
        sessionKey: "agent:main:missing",
      });
      bridgeRequest?.onTranscript?.("user", "cannot persist", true);
      await failures.afterAttempt(0);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      await failures.afterAttempt(1);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await flushTalkRealtimeRelayVoiceWrites({
        relaySessionId: session.relaySessionId,
        connId: "conn-voice-failure",
      });

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("realtime relay transcript append failed"),
      );
      await stopTalkRealtimeRelaySession({
        relaySessionId: session.relaySessionId,
        connId: "conn-voice-failure",
      });
      expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
        "closed",
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      failures.restore();
      await cleanupIsolatedRelayState(tempDir);
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createForcedConsultFixture(
    nativeCallIds: string[],
    options: {
      firstSubmission?: Promise<void>;
      supportsToolResultContinuation?: boolean;
      supportsToolResultSuppression?: boolean;
    } = {},
  ) {
    vi.useFakeTimers();
    const submitToolResult = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
    if (options.firstSubmission) {
      submitToolResult.mockReturnValueOnce(options.firstSubmission);
    }
    const sendUserMessage = vi.fn();
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: options.supportsToolResultContinuation ?? false,
      supportsToolResultSuppression: options.supportsToolResultSuppression ?? false,
      sendUserMessage,
      submitToolResult,
    });
    const { session, captured, events } = await createEventRelay(bridge, {
      instructions: "be brief",
      forceAgentConsultOnFinalTranscript: true,
    });
    captured.request?.onTranscript?.("user", "Can you check this?", true);
    await vi.advanceTimersByTimeAsync(250);
    const forcedToolCall = findEventPayload(events, "toolCall", { forced: true });
    for (const callId of nativeCallIds) {
      consultCall(captured.request, `item-${callId}`, callId, "Can you check this?");
    }
    return {
      bridgeRequest: captured.request,
      callId: String(forcedToolCall.callId),
      events,
      sendUserMessage,
      session,
      submitToolResult,
    };
  }

  async function createAbortableRelayRunFixture(
    provider = createIdleRelayProvider(),
    options: {
      register?: boolean;
      voiceSelection?: boolean;
      backend?: Parameters<typeof attachActiveEmbeddedRun>[1];
    } = {},
  ) {
    const target = await prepareTalkSessionTarget({}, "main");
    const source = createRpcSourceForTest(
      {
        requester: { connectionId: "conn-1" },
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      {
        runId: "run-1",
        sessionId: "run-1",
        sessionKey: target.canonicalKey,
        agentId: "main",
        storeScope: target.storePath,
      },
    );
    await claimRelayRunForTest(source, options.backend);
    const abortController = {
      signal: source.input.abortSignal,
      abort: (reason?: unknown) => requestRpcSourceCancellation(source, reason),
    };
    const broadcastToConnIds = vi.fn();
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const removeChatRun = vi.fn(() => ({ sessionKey: "agent:main:main", clientRunId: "run-1" }));
    const chatRunState = createChatRunState();
    Object.assign(chatRunState.getOrCreate("run-1"), {
      buffer: "partial answer",
      agentText: {
        assistant: {
          lastSentAt: Date.now(),
          bufferedEvent: {
            payload: {
              runId: "run-1",
              seq: 1,
              stream: "assistant",
              ts: Date.now(),
              data: { text: "pending", delta: "pending" },
            },
          },
        },
      },
    });
    indexRpcSourceForTest(source);
    const context = {
      broadcastToConnIds,
      broadcast,
      nodeSendToSession,
      logGateway: { warn: vi.fn() },
      chatRunState,
      removeChatRun,
      agentRunSeq: new Map(),
      getRuntimeConfig: () => ({}),
    } as never;
    const session = await createTalkRealtimeRelaySession({
      context,
      provider,
      sessionKey: "main",
      ...(options.voiceSelection
        ? {
            clientCapabilities: ["voice-selection" as const],
            voiceSelectionVoices: ["cove", "ember"],
          }
        : {}),
    });
    ensureActiveRelayTurnId(session.relaySessionId);

    if (options.register !== false) {
      await registerRun(session, "call-1", "run-1", "agent:main:main");
    }
    return {
      abortController,
      broadcast,
      nodeSendToSession,
      removeChatRun,
      chatRunState,
      broadcastToConnIds,
      session,
    };
  }

  function startRelayVoiceChange(voiceSessionId: string, ready = true) {
    const selected = resolveTalkVoiceSession({ kind: "client", connId: "conn-1", voiceSessionId });
    const send = vi.fn();
    const changing = requestTalkVoiceChange({
      session: selected,
      voice: "ember",
      requesterConnId: "conn-1",
      assertCurrent: () => {},
      send,
    });
    void changing.catch(() => {});
    const changeId = send.mock.calls[0]?.[0].changeId as string;
    const launch = prepareTalkVoiceReplacement({
      voiceChangeId: changeId,
      connId: "conn-1",
      sessionKey: "main",
    });
    const replacementId = `${voiceSessionId}-replacement`;
    const unregister = registerTalkVoiceSession({
      voiceSessionId: replacementId,
      connId: "conn-1",
      sessionTarget: selected.sessionTarget,
      selection: { ...selected.selection, voice: "ember" },
      launch: selected.launch,
      voiceChangeId: changeId,
      providerReady: ready,
    });
    const completion = ready
      ? completeTalkVoiceChange({
          changeId,
          connId: "conn-1",
          voiceSessionId: replacementId,
          outcome: "ready",
        })
      : undefined;
    void completion?.catch(() => {});
    return {
      launch: launch?.launch,
      send,
      changing,
      changeId,
      replacementId,
      completion,
      cleanup: async () => {
        unregister();
        cleanupTalkConnection("conn-1", { warn: vi.fn() });
        await changing.catch(() => {});
        await completion?.catch(() => {});
      },
    };
  }

  it("keeps client voice selection separate from normalized provider capabilities", async () => {
    const provider = createIdleRelayProvider();
    provider.capabilities = {
      transports: ["gateway-relay"],
      inputAudioFormats: [],
      outputAudioFormats: [],
      supportsToolCalls: false,
      supportsBargeIn: false,
    };
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return makeRelayTransport();
    };
    const session = await createTalkRealtimeRelaySession({
      context: createRelayContext(),
      provider,
      providerConfig: { model: "normalized-provider-model", voice: "cove" },
      model: "requested-model-alias",
      clientCapabilities: ["voice-selection"],
      voiceSelectionVoices: ["cove", "ember"],
      sessionKey: "main",
    });
    expect(session).toMatchObject({ model: "requested-model-alias", voice: "cove" });
    expect(bridgeRequest?.providerConfig).toMatchObject({ model: "normalized-provider-model" });
    const changing = startRelayVoiceChange(session.relaySessionId, false);
    try {
      expect(changing.launch).toMatchObject({ model: "normalized-provider-model", voice: "ember" });
      expect(relaySessions.get(session.relaySessionId)?.capabilities).toBe(provider.capabilities);
    } finally {
      await changing.cleanup();
    }
  });

  it("aborts the exact relay consult when the provider cancels its tool call", async () => {
    const submitToolResult = vi.fn();
    const captured = captureProvider(() =>
      makeRelayTransport({
        submitToolResult,
      }),
    );
    const { provider } = captured;
    const fixture = await createAbortableRelayRunFixture(provider);
    await Promise.resolve();
    consultCall(captured.request, "call-1", "call-1", "status?");

    providerEvent(captured.request, "tool.call.cancelled", { itemId: "call-1" });

    expect(fixture.abortController.signal.aborted).toBe(true);
    expect(mockEventPayloads(fixture.broadcastToConnIds, "toolCallCancelled")).toEqual([
      expect.objectContaining({
        relaySessionId: fixture.session.relaySessionId,
        type: "toolCallCancelled",
        callId: "call-1",
      }),
    ]);
    await submitResult(fixture.session, "call-1", { result: "late" });
    expect(submitToolResult).not.toHaveBeenCalled();

    const eventCount = fixture.broadcastToConnIds.mock.calls.length;
    providerEvent(captured.request, "tool.call.cancelled", { itemId: "call-1" });
    providerEvent(captured.request, "tool.call.cancelled", { itemId: "unknown" });
    consultCall(captured.request, "call-1-replay", "call-1", "status?");
    expect(fixture.broadcastToConnIds).toHaveBeenCalledTimes(eventCount);

    captured.request?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
    captured.request?.onReady?.();
    relaySessions
      .get(fixture.session.relaySessionId)
      ?.harness.talk.startTurn({ turnId: "replacement-turn" });
    consultCall(captured.request, "replacement-item", "call-1", "status?");
    const replacementCall = mockEventPayloads(fixture.broadcastToConnIds, "toolCall").at(-1);
    expect(replacementCall?.itemId).toBe("replacement-item");
    expect(replacementCall?.callId).not.toBe("call-1");
    await submitResult(fixture.session, String(replacementCall?.callId), {
      result: "replacement result",
    });
    expect(submitToolResult).toHaveBeenCalledExactlyOnceWith(
      "call-1",
      { result: "replacement result" },
      undefined,
    );
  });

  it.each([
    { label: "provider", source: "provider", accepted: true },
    { label: "turn with an accepted result", source: "turn", accepted: true },
    { label: "turn with a pending result", source: "turn", accepted: false },
  ])("aborts a consult that registers after $label cancellation", async ({ source, accepted }) => {
    const cancellationAccepted = createDeferred();
    const captured = captureProvider(() =>
      makeRelayTransport({
        submitToolResult: vi.fn(() => cancellationAccepted.promise),
      }),
    );
    const { provider } = captured;
    const fixture = await createAbortableRelayRunFixture(provider, { register: false });
    await Promise.resolve();
    consultCall(captured.request, "call-1", "call-1", "status?");
    try {
      if (source === "provider") {
        providerEvent(captured.request, "tool.call.cancelled", { itemId: "call-1" });
      } else {
        const cancelled = cancelTurn(fixture.session, undefined, "user");
        captured.request?.onEvent?.({ direction: "server", type: "response.cancelled" });
        await cancelled;
        expect(relaySessions.has(fixture.session.relaySessionId)).toBe(true);
        if (accepted) {
          cancellationAccepted.resolve();
          await nextEventLoopTurn();
        }
      }

      await expect(
        registerRun(fixture.session, "call-1", "run-1", "agent:main:main"),
      ).rejects.toThrow("Realtime provider cancelled the tool call before run registration");
      expect(fixture.abortController.signal.aborted).toBe(true);
      const relay = relaySessions.get(fixture.session.relaySessionId);
      expect(relay?.activeAgentRuns.size).toBe(0);
      expect(relay?.activeAgentToolCalls.size).toBe(0);
      if (source === "provider") {
        expect(relay?.providerToolCallIds.size).toBe(0);
        expect(relay?.relayToolCallIdsByProviderId.size).toBe(0);
      }
    } finally {
      cancellationAccepted.resolve();
      await nextEventLoopTurn();
    }
  });

  it("cancels the forced consult owner when a matching native call is cancelled", async () => {
    const submitToolResult = vi.fn();
    const captured = captureProvider(() =>
      makeRelayTransport({
        submitToolResult,
      }),
    );
    const { provider } = captured;
    const fixture = await createAbortableRelayRunFixture(provider, { register: false });
    const relay = relaySessions.get(fixture.session.relaySessionId);
    const forcedConsult = relay?.harness.forcedConsults.prepare("status?", { id: "forced-call" });
    if (!relay || !forcedConsult) {
      throw new Error("missing forced consult fixture");
    }
    relay.harness.forcedConsults.markStarted(forcedConsult);
    await Promise.resolve();
    consultCall(captured.request, "native-call", "native-call", "status?");
    await registerRun(fixture.session, forcedConsult.id, "run-1", "agent:main:main");

    providerEvent(captured.request, "tool.call.cancelled", { itemId: "native-call" });

    expect(fixture.abortController.signal.aborted).toBe(true);
    expect(relay.harness.forcedConsults.isCancelled(forcedConsult)).toBe(true);
    expect(mockEventPayloads(fixture.broadcastToConnIds, "toolCallCancelled")).toEqual([
      expect.objectContaining({
        relaySessionId: fixture.session.relaySessionId,
        type: "toolCallCancelled",
        callId: forcedConsult.id,
      }),
    ]);
    expect(submitResult(fixture.session, forcedConsult.id, { result: "late" })).toBeUndefined();
    expect(submitToolResult).not.toHaveBeenCalled();
  });

  it("ignores provider replay and cancellation after accepted completion", async () => {
    const submitToolResult = vi.fn();
    const captured = captureProvider(() =>
      makeRelayTransport({
        submitToolResult,
      }),
    );
    const { provider } = captured;
    const fixture = await createAbortableRelayRunFixture(provider);
    await Promise.resolve();
    consultCall(captured.request, "call-1", "call-1", "status?");
    await submitResult(fixture.session, "call-1", { result: "done" });
    const toolEvents = () =>
      fixture.broadcastToConnIds.mock.calls
        .map(([, payload]) => payload)
        .filter(
          (payload) =>
            typeof payload === "object" &&
            payload !== null &&
            ["toolCall", "toolCallCancelled"].includes(
              String((payload as Record<string, unknown>).type),
            ),
        );
    expect(toolEvents()).toHaveLength(1);

    consultCall(captured.request, "call-1-replay", "call-1", "status?");
    providerEvent(captured.request, "tool.call.cancelled", { itemId: "call-1" });

    expect(toolEvents()).toHaveLength(1);
    expect(submitToolResult).toHaveBeenCalledTimes(1);
  });

  function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
    if (!record || typeof record !== "object") {
      throw new Error("Expected record");
    }
    const actual = record as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(actual[key]).toEqual(value);
    }
    return actual;
  }

  function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
    const call = mock.mock.calls[callIndex];
    if (!call) {
      throw new Error(`Expected mock call ${callIndex}`);
    }
    return call[argIndex];
  }

  function findEventPayload(
    events: Array<{ payload: unknown }>,
    selector: string | ((payload: Record<string, unknown>) => boolean),
    fields: Record<string, unknown> = {},
  ) {
    const predicate =
      typeof selector === "function"
        ? selector
        : (payload: Record<string, unknown>) =>
            payload.type === selector &&
            Object.entries(fields).every(([key, value]) => payload[key] === value);
    const event = events.find((entry) => {
      const payload = entry.payload;
      return (
        typeof payload === "object" &&
        payload !== null &&
        predicate(payload as Record<string, unknown>)
      );
    });
    if (!event) {
      throw new Error("Expected matching relay event");
    }
    return event.payload as Record<string, unknown>;
  }

  function expectChatAbortPayload(mock: ReturnType<typeof vi.fn>, stopReason: string) {
    expect(mockCallArg(mock)).toBe("chat");
    expectRecordFields(mockCallArg(mock, 0, 1), {
      runId: "run-1",
      sessionKey: "agent:main:main",
      state: "aborted",
      stopReason,
    });
  }

  function expectNodeAbortPayload(mock: ReturnType<typeof vi.fn>) {
    expect(mockCallArg(mock)).toBe("agent:main:main");
    expect(mockCallArg(mock, 0, 1)).toBe("chat");
    expectRecordFields(mockCallArg(mock, 0, 2), { runId: "run-1", state: "aborted" });
  }

  it("resets provider continuity without cancelling the replacement provider", async () => {
    const pendingWorking = createDeferred();
    const handleBargeIn = vi.fn();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(pendingWorking.promise);
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      sendUserMessage: vi.fn(),
      handleBargeIn,
      submitToolResult,
    });
    const captured = captureProvider(() => bridge);
    const { provider } = captured;
    const fixture = await createAbortableRelayRunFixture(provider);
    const relay = relaySessions.get(fixture.session.relaySessionId);
    if (!relay || !captured.request) {
      throw new Error("expected active relay continuity fixture");
    }
    const request = captured.request;
    request.onReady?.();
    relay.harness.talk.startTurn({ turnId: "turn-old" });
    providerEvent(request, "response.created", { responseId: "old-response" });
    providerEvent(request, "response.audio.delta", {
      itemId: "old-item",
      responseId: "old-response",
    });
    request.onAudio(Buffer.from("old audio"));
    request.onToolCall?.({
      itemId: "old-item",
      callId: "call-1",
      name: "custom_tool",
      args: {},
    });
    const working = submitResult(
      fixture.session,
      "call-1",
      { status: "working" },
      { willContinue: true },
    );

    request.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });
    request.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });

    expect(fixture.abortController.signal.aborted).toBe(true);
    expect(handleBargeIn).not.toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();
    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(relay.pendingWorkingToolResults.size).toBe(0);
    expect(relay.activeAgentRuns.size).toBe(0);
    expect(relay.activeAgentToolCalls.size).toBe(0);
    const payloads = fixture.broadcastToConnIds.mock.calls.map(([, payload]) => payload);
    const clears = payloads.filter(
      (payload): payload is Record<string, unknown> =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as Record<string, unknown>).type === "clear",
    );
    expect(clears).toHaveLength(1);
    expectRecordFields(clears[0]?.talkEvent, {
      type: "turn.cancelled",
      payload: { reason: "session.continuity.reset" },
      final: true,
    });

    pendingWorking.resolve();
    await working;
    expect(submitToolResult).toHaveBeenCalledTimes(1);

    request.onEvent?.({ direction: "server", type: "session.created" });
    relay.harness.talk.startTurn({ turnId: "turn-new" });
    providerEvent(request, "response.created", { responseId: "fresh-response" });
    request.onAudio(Buffer.from("fresh audio"));
    const freshAudio = mockEventPayloads(fixture.broadcastToConnIds, "audio").at(-1);
    expectRecordFields(freshAudio, {
      type: "audio",
      audioBase64: Buffer.from("fresh audio").toString("base64"),
    });
    expect(freshAudio).not.toHaveProperty("itemId");
    expect(freshAudio).toHaveProperty("responseId", "fresh-response");

    request.onToolCall?.({
      itemId: "fresh-item",
      callId: "call-1",
      name: "custom_tool",
      args: {},
    });
    const freshToolCall = mockEventPayloads(fixture.broadcastToConnIds, "toolCall").at(-1);
    const freshCallId = freshToolCall?.callId;
    expect(typeof freshCallId).toBe("string");
    expect(freshCallId).not.toBe("call-1");
    await submitResult(fixture.session, "call-1", { stale: true });
    expect(submitToolResult).toHaveBeenCalledTimes(1);
    await submitResult(fixture.session, String(freshCallId), { ok: true });
    expect(submitToolResult).toHaveBeenLastCalledWith("call-1", { ok: true }, undefined);

    request.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });
    request.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });
    expect(mockEventPayloads(fixture.broadcastToConnIds, "clear")).toHaveLength(2);
  });

  it("bridges browser audio, transcripts, and tool results through a backend provider", async () => {
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => {
        captured.request?.onReady?.();
        captured.request?.onTranscript?.("user", "hel", false, { textMode: "snapshot" });
        providerEvent(captured.request, "response.created", { responseId: "response-1" });
        captured.request?.onAudio(Buffer.from("audio-out"));
        captured.request?.onMark?.("mark-1");
        captured.request?.onTranscript?.("user", "hello", true);
        captured.request?.onTranscript?.("assistant", "hi there", true);
        consultCall(captured.request, "item-1", "call-1", "hello");
      }),
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
    });
    const captured = captureProvider(() => bridge);
    const { provider } = captured;
    const { events, context } = createRelayEventRecorder();
    const expectDelivery = (payload: Record<string, unknown>, dropIfSlow: boolean) => {
      expectRecordFields(events.find((entry) => entry.payload === payload)?.opts, { dropIfSlow });
    };

    const session = await createTalkRealtimeRelaySession({
      context,
      provider,
      providerConfig: { model: "provider-model" },
      instructions: "be brief",
      model: "browser-model",
      voice: "voice-a",
      language: "de",
    });
    await Promise.resolve();

    const sessionFields = expectRecordFields(session, {
      provider: "relay-test",
      transport: "gateway-relay",
      model: "browser-model",
      voice: "voice-a",
    });
    expectRecordFields(sessionFields.audio, {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    });
    expectRecordFields(captured.request, {
      providerConfig: { model: "provider-model" },
      audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      instructions: "be brief",
      language: "de",
      autoRespondToAudio: true,
      interruptResponseOnInputAudio: true,
    });
    const expectEvent = (
      type: string,
      fields: Record<string, unknown>,
      talkFields?: Record<string, unknown>,
      dropIfSlow = false,
      selector: Record<string, unknown> = {},
    ) => {
      const payload = findEventPayload(events, type, selector);
      expectRecordFields(payload, { relaySessionId: session.relaySessionId, ...fields });
      if (talkFields) {
        expectRecordFields(payload.talkEvent, talkFields);
      }
      expectDelivery(payload, dropIfSlow);
      return payload;
    };
    const readyPayload = expectEvent(
      "ready",
      {},
      {
        sessionId: session.relaySessionId,
        type: "session.ready",
        seq: 1,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "relay-test",
      },
    );
    expectRecordFields(
      events.find((entry) => entry.payload === readyPayload),
      {
        event: "talk.event",
        connIds: ["conn-1"],
      },
    );
    expectEvent(
      "audio",
      { audioBase64: Buffer.from("audio-out").toString("base64") },
      { type: "output.audio.delta" },
      true,
    );
    expect(expectEvent("mark", { markName: "mark-1" }).talkEvent).toBeUndefined();
    const partialTranscript = findEventPayload(events, "transcript", {
      role: "user",
      final: false,
    });
    expectDelivery(partialTranscript, true);
    expect(partialTranscript.textMode).toBe("snapshot");
    expect(partialTranscript.transcriptId).toBeUndefined();
    expectEvent(
      "transcript",
      {
        role: "user",
        text: "hello",
        final: true,
        transcriptId: `voice:${session.relaySessionId}:1`,
      },
      { type: "transcript.done", final: true },
      false,
      { role: "user", final: true },
    );
    expectEvent(
      "transcript",
      {
        role: "assistant",
        text: "hi there",
        final: true,
        transcriptId: `voice:${session.relaySessionId}:2`,
      },
      { type: "output.text.done", final: true, payload: { text: "hi there" } },
      false,
      { role: "assistant" },
    );
    // Nested args remain exact, independently of the event selection fields.
    const toolCall = expectEvent(
      "toolCall",
      {
        itemId: "item-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
      },
      { type: "tool.call", itemId: "item-1", callId: "call-1" },
    );
    expect(toolCall.args).toEqual({ question: "hello" });

    void transmitAudio(session, Buffer.from("audio-in").toString("base64"), 123);
    void submitResult(session, "call-1", { status: "working" }, { willContinue: true });
    void submitResult(session, "call-1", { ok: true });
    void submitResult(
      session,
      "call-2",
      { status: "already_delivered" },
      { suppressResponse: true },
    );
    acknowledgeTalkRealtimeRelayMark({
      ...relayTarget(session),
      markName: "mark-1",
    });
    void cancelTurn(session, ensureActiveRelayTurnId(session.relaySessionId), "barge-in");
    void stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });

    expect(bridge.sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    expect(bridge.sendUserMessage).not.toHaveBeenCalledWith("hello");
    expect(bridge.setMediaTimestamp).toHaveBeenCalledWith(123);
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(
      1,
      "call-1",
      {
        status: "working",
        tool: "openclaw_agent_consult",
        message:
          "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
      },
      { willContinue: true },
    );
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(
      2,
      "call-1",
      { status: "working" },
      { willContinue: true },
    );
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(3, "call-1", { ok: true }, undefined);
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(
      4,
      "call-2",
      { status: "already_delivered" },
      { suppressResponse: true },
    );
    expect(bridge.handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: true });
    expect(bridge.acknowledgeMark).toHaveBeenCalledWith("mark-1");
    expect(bridge.close).toHaveBeenCalled();
    expectEvent(
      "inputAudio",
      { byteLength: Buffer.from("audio-in").byteLength },
      { type: "input.audio.delta" },
      true,
      { byteLength: Buffer.from("audio-in").byteLength },
    );
    expectEvent(
      "clear",
      {},
      {
        type: "turn.cancelled",
        payload: { reason: "barge-in" },
        final: true,
      },
    );

    const toolResultPayloads = eventPayloads(events, "toolResult", "call-1");
    expect(toolResultPayloads).toHaveLength(3);
    const expectedTalkResults = [
      {
        type: "tool.progress",
        callId: "call-1",
        payload: { name: "openclaw_agent_consult", status: "working" },
      },
      {
        type: "tool.result",
        callId: "call-1",
        final: false,
      },
      {
        type: "tool.result",
        callId: "call-1",
        final: true,
      },
    ];
    for (const [index, talkFields] of expectedTalkResults.entries()) {
      const payload = toolResultPayloads[index];
      expectRecordFields(payload, {
        relaySessionId: session.relaySessionId,
        type: "toolResult",
        callId: "call-1",
      });
      expectRecordFields(payload?.talkEvent, talkFields);
    }
    expect(
      toolResultPayloads.map((payload) => events.find((event) => event.payload === payload)?.opts),
    ).toEqual([{ dropIfSlow: true }, { dropIfSlow: true }, { dropIfSlow: false }]);

    expectEvent("close", { reason: "completed" }, { type: "session.closed", final: true });
  });

  it.each(["connect", "close-before-ready", "error-before-close"] as const)(
    "emits bounded issue details for %s without replacing provider errors",
    async (failure) => {
      const rawMarker = "raw-connect-auth-marker";
      const error = Object.assign(new Error(rawMarker), { status: 401 });
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const provider: RealtimeVoiceProviderPlugin = {
        id: "openai",
        label: "OpenAI Realtime",
        isConfigured: () => true,
        createBridge: (request) => {
          bridgeRequest = request;
          return makeRelayTransport({
            connect: vi.fn(async () => {
              if (failure === "connect") {
                throw error;
              }
            }),
            isConnected: vi.fn(() => failure !== "connect"),
          });
        },
      };
      const { events, context } = createRelayEventRecorder();
      const session = await createTalkRealtimeRelaySession({
        context,
        provider,
        model: "gpt-realtime-2",
      });
      if (failure === "connect") {
        await Promise.resolve();
      } else {
        if (failure === "error-before-close") {
          bridgeRequest?.onError?.(error);
        }
        bridgeRequest?.onClose?.("error");
      }
      const errorPayload = findEventPayload(events, "error");
      expectRecordFields(errorPayload, {
        relaySessionId: session.relaySessionId,
        type: "error",
        ...(failure !== "close-before-ready" ? { message: RELAY_AUTH_ERROR } : {}),
        code: "realtime_unavailable",
        provider: "openai",
        model: "gpt-realtime-2",
        transport: "gateway-relay",
        phase: "connect",
      });
      if (failure === "connect") {
        expectRecordFields(errorPayload.talkEvent, { type: "session.error", final: true });
        expectRecordFields((errorPayload.talkEvent as Record<string, unknown>).payload, {
          code: "realtime_unavailable",
          provider: "openai",
          model: "gpt-realtime-2",
          transport: "gateway-relay",
          phase: "connect",
        });
        expectRecordFields(events.find((event) => event.payload === errorPayload)?.opts, {
          dropIfSlow: false,
        });
      } else if (failure === "close-before-ready") {
        expectRecordFields(findEventPayload(events, "close"), {
          relaySessionId: session.relaySessionId,
          type: "close",
          reason: "error",
        });
      } else {
        expect(
          events.filter(({ payload }) => (payload as { type?: string }).type === "error"),
        ).toHaveLength(1);
      }
      expect(JSON.stringify(events)).not.toContain(rawMarker);
    },
  );

  it.each([
    ["opaque", true, "gpt-live-test-private"],
    ["public", false, "gpt-realtime-test-public"],
  ])("redacts provider details for a %s relay model", async (_name, hideModel, model) => {
    const sensitiveDetails = ["sensitive-route", "sensitive-session", "sensitive-transcript"];
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return makeRelayTransport();
      },
      ...(hideModel
        ? {
            [Symbol.for("openclaw.internal.realtime-voice-provider.v1")]: {
              isBrowserSessionConfigured: () => true,
              projectPublicProjection: ({ config }: { config: Record<string, unknown> }) => {
                const { model: _model, ...publicConfig } = config;
                return { config: publicConfig };
              },
            },
          }
        : {}),
    };
    const { events, context } = createRelayEventRecorder();

    const session = await createTalkRealtimeRelaySession({
      context,
      connId: "conn-private-model",
      provider,
      providerConfig: { model },
      model,
    });
    bridgeRequest?.onError?.(
      Object.assign(new Error(`provider rejected ${model} ${sensitiveDetails.join(" ")}`), {
        status: 401,
      }),
    );

    if (hideModel) {
      expect(session).not.toHaveProperty("model");
    } else {
      expect(session).toHaveProperty("model", model);
    }
    const projected = JSON.stringify(events);
    expect(projected).toContain(hideModel ? RELAY_GENERIC_ERROR : RELAY_AUTH_ERROR);
    for (const privateValue of [...(hideModel ? [model] : []), ...sensitiveDetails]) {
      expect(projected).not.toContain(privateValue);
    }
  });

  it("forces an agent consult when configured and realtime transcript finalizes without a provider tool call", async () => {
    vi.useFakeTimers();

    const sendUserMessage = vi.fn();
    const submitToolResult = vi.fn();
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      sendUserMessage,
      triggerGreeting: vi.fn(),
      submitToolResult,
    });
    const { session, captured, events } = await createEventRelay(bridge, {
      instructions: "be brief",
      forceAgentConsultOnFinalTranscript: true,
    });

    expectRecordFields(captured.request, { autoRespondToAudio: false });

    captured.request?.onTranscript?.("user", "Can you check this?", true);
    expect(bridge.sendUserMessage).not.toHaveBeenCalledWith("Can you check this?");

    await vi.advanceTimersByTimeAsync(250);

    const forcedToolCall = findEventPayload(events, "toolCall", { forced: true });
    expectRecordFields(forcedToolCall, {
      relaySessionId: session.relaySessionId,
      type: "toolCall",
      name: "openclaw_agent_consult",
      forced: true,
    });
    expectRecordFields(forcedToolCall.args, {
      question: "Can you check this?",
      responseStyle: "Reply in a concise spoken tone.",
    });
    expectRecordFields(forcedToolCall.talkEvent, { type: "tool.call" });
    expectRecordFields((forcedToolCall.talkEvent as Record<string, unknown>).payload, {
      forced: true,
    });
    expect(bridge.handleBargeIn).toHaveBeenCalledWith({
      audioPlaybackActive: true,
      force: true,
    });

    const callId = String(forcedToolCall.callId);
    void submitResult(session, callId, { status: "working" }, { willContinue: true });
    expect(bridge.sendUserMessage).toHaveBeenLastCalledWith(
      "Briefly tell the person that you are checking with OpenClaw. Do not answer the request yet. Wait for the OpenClaw result before giving the actual answer.",
    );

    consultCall(captured.request, "native-item", "native-call", "Can you check this?");
    expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
      "native-call",
      {
        status: "working",
        tool: "openclaw_agent_consult",
        message:
          "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
      },
      { willContinue: true },
    );

    const forcedAcceptance = createDeferred();
    submitToolResult.mockImplementationOnce(() => forcedAcceptance.promise);
    const forcedSubmission = submitResult(session, callId, {
      result: "Here is the checked answer.",
    });
    expect(bridge.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Here is the checked answer."),
    );
    forcedAcceptance.resolve();
    await forcedSubmission;
    expect(bridge.submitToolResult).toHaveBeenLastCalledWith("native-call", DELIVERED_RESULT, {
      suppressResponse: true,
    });
    expect(bridge.sendUserMessage).toHaveBeenLastCalledWith(
      [
        "OpenClaw finished checking. Speak this result naturally and concisely.",
        "Do not mention tool calls, JSON, or internal routing.",
        "",
        "Here is the checked answer.",
      ].join("\n"),
    );
    expect(
      submitToolResult.mock.invocationCallOrder[
        submitToolResult.mock.invocationCallOrder.length - 1
      ],
    ).toBeLessThan(
      sendUserMessage.mock.invocationCallOrder[
        sendUserMessage.mock.invocationCallOrder.length - 1
      ] ?? 0,
    );
    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).callId === "native-call"
        );
      }),
    ).toBe(false);

    consultCall(
      captured.request,
      "native-other-item",
      "native-other-call",
      "Can you check something else?",
    );
    expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
      "native-other-call",
      {
        status: "working",
        tool: "openclaw_agent_consult",
        message:
          "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
      },
      { willContinue: true },
    );
    const nativeOtherToolCall = findEventPayload(events, "toolCall", {
      callId: "native-other-call",
    });
    expectRecordFields(nativeOtherToolCall, {
      relaySessionId: session.relaySessionId,
      type: "toolCall",
      callId: "native-other-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check something else?" },
    });
    void stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });
  });

  it.each([
    { label: "without native calls", nativeCallIds: [] },
    { label: "with a matching native call", nativeCallIds: ["native-call"] },
  ])("honors response suppression for forced consults $label", async ({ nativeCallIds }) => {
    const fixture = await createForcedConsultFixture(nativeCallIds, {
      supportsToolResultSuppression: true,
    });
    await submitResult(
      fixture.session,
      fixture.callId,
      { status: "working" },
      { willContinue: true, suppressResponse: true },
    );
    const result = { result: "This answer was delivered elsewhere." };
    await submitResult(fixture.session, fixture.callId, result, { suppressResponse: true });

    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    expect(fixture.submitToolResult).toHaveBeenCalledTimes(nativeCallIds.length);
    if (nativeCallIds.length > 0) {
      expect(fixture.submitToolResult).toHaveBeenCalledWith(
        "native-call",
        expect.objectContaining({ status: "already_delivered" }),
        { suppressResponse: true },
      );
    }
    expect(
      findEventPayload(
        fixture.events,
        (payload) =>
          payload.type === "toolResult" &&
          (payload.talkEvent as { final?: boolean } | undefined)?.final === true,
      ),
    ).toMatchObject({
      callId: fixture.callId,
      talkEvent: { type: "tool.result", payload: { result, forced: true }, final: true },
    });
  });

  it.each([{ nativeCallIds: ["native-call"] }, { nativeCallIds: ["native-1", "native-2"] }])(
    "waits for all native results without suppression ($nativeCallIds)",
    async ({ nativeCallIds }) => {
      const fixture = await createForcedConsultFixture(nativeCallIds);
      const first = createDeferred();
      const second = createDeferred();
      fixture.submitToolResult.mockReturnValueOnce(first.promise);
      if (nativeCallIds.length > 1) {
        fixture.submitToolResult.mockReturnValueOnce(second.promise);
      }
      const submission = submitResult(fixture.session, fixture.callId, { result: "checked" });
      const toolResults = () => eventPayloads(fixture.events, "toolResult", fixture.callId);
      if (nativeCallIds.length === 1) {
        const duplicate = submitResult(fixture.session, fixture.callId, { answer: "duplicate" });
        expect(duplicate).toBe(submission);
        expect(fixture.submitToolResult).toHaveBeenCalledTimes(1);
        expect(fixture.submitToolResult).toHaveBeenCalledWith(
          "native-call",
          { result: "checked" },
          undefined,
        );
        expect(fixture.sendUserMessage).not.toHaveBeenCalled();
      }
      first.resolve();
      if (nativeCallIds.length > 1) {
        await Promise.resolve();
        expect(toolResults()).toHaveLength(0);
        second.resolve();
      }
      await submission;
      expect(fixture.submitToolResult).toHaveBeenCalledTimes(nativeCallIds.length);
      if (nativeCallIds.length === 1) {
        expect(fixture.sendUserMessage).not.toHaveBeenCalled();
        expect(toolResults()).toHaveLength(1);
      }
    },
  );

  it("classifies forced interim and terminal results only from willContinue", async () => {
    const fixture = await createForcedConsultFixture(["native-call"]);

    await submitResult(
      fixture.session,
      fixture.callId,
      { phase: "checking" },
      { willContinue: true },
    );
    expect(fixture.submitToolResult).not.toHaveBeenCalled();

    await submitResult(fixture.session, fixture.callId, { status: "working" });
    expect(fixture.submitToolResult).toHaveBeenCalledWith(
      "native-call",
      { status: "working" },
      undefined,
    );
    const finalStates = fixture.events
      .filter(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === fixture.callId,
      )
      .map((entry) => (entry.payload as { talkEvent?: { final?: boolean } }).talkEvent?.final);
    expect(finalStates).toEqual([false, true]);
  });

  it("drains native calls that join while a forced terminal result is pending", async () => {
    const fixture = await createForcedConsultFixture(["native-1"]);
    const first = createDeferred();
    const second = createDeferred();
    const third = createDeferred();
    const secondStarted = createDeferred();
    const thirdStarted = createDeferred();
    fixture.submitToolResult
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(() => {
        secondStarted.resolve();
        return second.promise;
      })
      .mockImplementationOnce(() => {
        thirdStarted.resolve();
        return third.promise;
      });
    const submission = submitResult(fixture.session, fixture.callId, { result: "checked" });

    consultCall(fixture.bridgeRequest, "late-item", "native-2", "Can you check this?");
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual(["native-1"]);

    first.resolve();
    await secondStarted.promise;
    consultCall(fixture.bridgeRequest, "later-item", "native-3", "Can you check this?");
    second.resolve();
    await vi.waitFor(() =>
      expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual([
        "native-1",
        "native-2",
        "native-3",
      ]),
    );
    await thirdStarted.promise;
    let terminalSettled = false;
    const completion = Promise.resolve(submission).then(() => {
      terminalSettled = true;
    });
    expect(terminalSettled).toBe(false);
    third.resolve();
    await completion;
    expect(terminalSettled).toBe(true);
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "native-1",
      "native-2",
      "native-3",
    ]);
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    expect(
      fixture.events.filter(
        (entry) =>
          (entry.payload as { type?: string }).type === "toolResult" &&
          ["native-2", "native-3"].includes((entry.payload as { callId?: string }).callId ?? ""),
      ),
    ).toHaveLength(0);
  });

  it("retries only rejected native forced results after partial acceptance", async () => {
    const fixture = await createForcedConsultFixture(["native-1", "native-2"]);
    fixture.submitToolResult
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second native rejected"));
    const firstAttempt = submitResult(fixture.session, fixture.callId, { answer: "checked" });
    await expect(firstAttempt).rejects.toThrow("second native rejected");
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();

    await submitResult(fixture.session, fixture.callId, { answer: "checked" });
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "native-1",
      "native-2",
      "native-2",
    ]);
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
  });

  it("satisfies late native forced calls without suppression or duplicate speech", async () => {
    const fixture = await createForcedConsultFixture([]);
    await submitResult(fixture.session, fixture.callId, { result: "checked" });
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(fixture.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("checked"));
    expect(fixture.submitToolResult).not.toHaveBeenCalled();

    consultCall(fixture.bridgeRequest, "late-item", "late-call", "Can you check this?");
    expect(fixture.submitToolResult).toHaveBeenCalledWith("late-call", DELIVERED_RESULT, undefined);
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects direct suppressed results when the provider does not support them", async () => {
    const submitToolResult = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = () => ({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult,
      supportsToolResultSuppression: false,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    const session = await createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      provider,
    });

    expect(() => submitResult(session, "call-1", { ok: true }, { suppressResponse: true })).toThrow(
      "Realtime provider does not support suppressed tool results",
    );
    expect(submitToolResult).not.toHaveBeenCalled();
  });

  it("does not force a duplicate consult after native consult or cancellation", async () => {
    vi.useFakeTimers();

    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
    });
    const captured = captureProvider(() => bridge);
    const { provider } = captured;
    const { events, context } = createRelayEventRecorder();

    const hasForcedConsult = () =>
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).forced === true
        );
      });
    for (const [callId, transcript, question] of [
      ["native-call", "Can you check this?", "Can you check this for me?"],
      ["unicode-native-call", "проверь статус", "проверь статус"],
    ] as const) {
      const session = await createTalkRealtimeRelaySession({
        context,
        provider,
        instructions: "be brief",
        forceAgentConsultOnFinalTranscript: true,
      });
      await Promise.resolve();
      captured.request?.onTranscript?.("user", transcript, true);
      consultCall(captured.request, `item-${callId}`, callId, question);
      await vi.advanceTimersByTimeAsync(250);
      expect(hasForcedConsult()).toBe(false);
      await stopTalkRealtimeRelaySession({
        ...relayTarget(session),
      });
    }

    const cancelledSession = await createTalkRealtimeRelaySession({
      context,
      provider,
      instructions: "be brief",
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();
    captured.request?.onTranscript?.("user", "Cancel this consult", true);
    void cancelTurn(
      cancelledSession,
      ensureActiveRelayTurnId(cancelledSession.relaySessionId),
      "barge-in",
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(hasForcedConsult()).toBe(false);
    expect(relaySessions.has(cancelledSession.relaySessionId)).toBe(true);
  });

  it.each(["disconnect", "explicit-close"])(
    "joins asynchronous relay shutdown and final writes after %s",
    async (start) => {
      const finishProvider = createDeferred();
      const logGateway = { warn: vi.fn() };
      const provider: RealtimeVoiceProviderPlugin = createIdleRelayProvider((request) =>
        makeRelayTransport({
          close: async () => {
            await finishProvider.promise;
            request.onTranscript?.("user", "Final relay speech", true);
          },
        }),
      );
      const session = await createTalkRealtimeRelaySession({
        context: { broadcastToConnIds: vi.fn(), logGateway } as never,
        connId: "conn-relay-drain",
        provider,
      });
      await ensureTalkRealtimeRelayVoiceSession({
        relaySessionId: session.relaySessionId,
        connId: "conn-relay-drain",
        sessionKey: "agent:main:main",
      });
      const talkClose = prepareTalkConnectionClose([{ connId: "conn-relay-drain" }], logGateway);
      let closing: void | Promise<void> = undefined;
      let drain: Promise<void> | undefined;
      try {
        if (start === "explicit-close") {
          closing = stopTalkRealtimeRelaySession({
            relaySessionId: session.relaySessionId,
            connId: "conn-relay-drain",
          });
        }
        cleanupTalkConnection("conn-relay-drain", logGateway);
        let drained = false;
        drain = talkClose.drain().then(() => {
          drained = true;
        });
        await nextEventLoopTurn();
        expect(drained).toBe(false);
        finishProvider.resolve();
        await drain;
        expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)).toMatchObject({
          status: "closed",
          hasUserTranscript: true,
        });
        expect(
          [...drainingRelaySessions].some((relay) => relay.id === session.relaySessionId),
        ).toBe(false);
        await drainGlobalSingletonLifecycleState("restart");
      } finally {
        finishProvider.resolve();
        await Promise.allSettled([closing, drain, talkClose.drain()]);
      }
    },
  );

  it("claims a Talk turn for an ID-less response before browser audio", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider = createIdleRelayProvider((request) => {
      bridgeRequest = request;
      return makeRelayTransport();
    });
    const broadcastToConnIds = vi.fn();
    const session = await createTalkRealtimeRelaySession({
      context: { broadcastToConnIds } as never,
      provider,
    });
    expect(relaySessions.get(session.relaySessionId)?.harness.talk.activeTurnId).toBeUndefined();

    bridgeRequest?.onEvent?.({ direction: "server", type: "response.created" });
    expect(broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      type: "responseStarted",
      relaySessionId: session.relaySessionId,
      turnId: expect.any(String),
    });
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.output_audio.delta",
      itemId: "item-1",
    });
    bridgeRequest?.onAudio(Buffer.from("reply"));
    bridgeRequest?.onResponseDone?.({ status: "completed" });

    const payloads = broadcastToConnIds.mock.calls.map(
      (call) => call[1] as Record<string, unknown>,
    );
    const audioPayload = payloads.find((payload) => payload.type === "audio");
    expect(audioPayload).toMatchObject({ type: "audio" });
    expect(audioPayload).not.toHaveProperty("responseId");
    expect(payloads.filter((payload) => payload.type === "audioDone")).toHaveLength(1);
    expect(payloads.some((payload) => payload.type === "error")).toBe(false);
    expect(payloads.some((payload) => payload.type === "close")).toBe(false);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
  });

  it("splits large provider audio into ordered 20 ms relay frames", async () => {
    const captured = captureProvider(() => makeRelayTransport());
    const { provider } = captured;
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const session = await createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: (event: string, payload: Record<string, unknown>) => {
          events.push({ event, payload });
        },
      } as never,
      provider,
    });
    void transmitAudio(session, Buffer.from("audio").toString("base64"));
    const audio = Buffer.alloc(960 * 33 + 137);
    for (let index = 0; index < audio.length; index += 1) {
      audio[index] = index % 251;
    }
    providerEvent(captured.request, "response.created", { responseId: "response-1" });
    providerEvent(captured.request, "response.output_audio.delta", {
      itemId: "item-1",
      responseId: "response-1",
    });
    captured.request?.onAudio(audio);

    const audioPayloads = events
      .map((entry) => entry.payload)
      .filter((payload) => payload.type === "audio");
    const frames = audioPayloads.map((payload) =>
      Buffer.from(String(payload.audioBase64), "base64"),
    );
    expect(frames).toHaveLength(34);
    expect(frames.every((frame) => frame.byteLength <= 960)).toBe(true);
    expect(frames.at(-1)?.byteLength).toBe(137);
    expect(Buffer.concat(frames)).toEqual(audio);
    for (const [index, payload] of audioPayloads.entries()) {
      expectRecordFields(payload, {
        itemId: "item-1",
        responseId: "response-1",
      });
      expectRecordFields(payload.talkEvent, {
        type: "output.audio.delta",
        turnId: "turn-1",
        seq: index + 3,
        payload: { byteLength: frames[index]?.byteLength },
      });
    }
    expect(events.some((entry) => entry.payload.type === "error")).toBe(false);
    expect(events.some((entry) => entry.payload.type === "close")).toBe(false);
  });

  it.each([
    { phase: "idle", source: "provider" },
    { phase: "replacement transcript before audio", source: "provider" },
    { phase: "replacement audio", source: "provider" },
    { phase: "idle", source: "continuity reset" },
    { phase: "completed response", source: "continuity reset" },
    { phase: "replacement transcript before audio", source: "continuity reset" },
    { phase: "replacement audio", source: "continuity reset" },
  ])("clears the delivered audio owner during $phase ($source)", async ({ phase, source }) => {
    const bridge = makeRelayTransport();
    const captured = captureProvider(() => bridge);
    const { provider } = captured;
    const broadcastToConnIds = vi.fn();
    const session = await createTalkRealtimeRelaySession({
      context: { broadcastToConnIds } as never,
      provider,
    });
    if (!captured.request) {
      throw new Error("expected realtime bridge request");
    }
    const relay = relaySessions.get(session.relaySessionId)!;
    let playbackTurnId: string | undefined;

    if (phase !== "idle") {
      providerEvent(captured.request, "response.created", { responseId: "response-a" });
      captured.request.onAudio(Buffer.alloc(960));
      playbackTurnId = relay.harness.talk.activeTurnId;
      captured.request.onMark?.("audio-1");
      captured.request.onResponseDone?.({ status: "completed", responseId: "response-a" });
      providerEvent(captured.request, "response.done", { responseId: "response-a" });
      expect(relay.harness.talk.activeTurnId).toBeUndefined();
      // The client still owns buffered audio, regardless of provider completion.
      expect(bridge.acknowledgeMark).not.toHaveBeenCalled();
    }
    if (phase.startsWith("replacement")) {
      providerEvent(captured.request, "response.created", { responseId: "response-b" });
      if (phase === "replacement transcript before audio") {
        captured.request.onTranscript?.("assistant", "The next answer", false);
      } else if (phase === "replacement audio") {
        captured.request.onAudio(Buffer.alloc(960));
        playbackTurnId = relay.harness.talk.activeTurnId;
      }
    }
    const activeTurnId = relay.harness.talk.activeTurnId;
    const eventCount = broadcastToConnIds.mock.calls.length;
    const talkEventCount = relay.harness.talk.recentEvents.length;
    const lastTalkEventSeq = relay.harness.talk.recentEvents.at(-1)?.seq ?? 0;

    const resetting = source === "continuity reset";
    if (resetting) {
      captured.request.onEvent?.({ direction: "client", type: "session.continuity.reset" });
    } else {
      captured.request.onClearAudio("barge-in");
    }
    const expectedClears: Array<{ turnId?: string; type: string; reason: string }> = [];
    if (!resetting || !activeTurnId || (playbackTurnId && playbackTurnId !== activeTurnId)) {
      expectedClears.push({
        turnId: playbackTurnId,
        type: "output.audio.done",
        reason: resetting ? "clear" : "barge-in",
      });
    }
    if (resetting && activeTurnId) {
      expectedClears.push({
        turnId: activeTurnId,
        type: "turn.cancelled",
        reason: "session.continuity.reset",
      });
    }
    expect(broadcastToConnIds.mock.calls.slice(eventCount)).toEqual(
      expectedClears.map(({ turnId, type, reason }, index) => [
        "talk.event",
        {
          relaySessionId: session.relaySessionId,
          type: "clear",
          ...(!resetting ? { reason: "barge-in" } : {}),
          ...(turnId
            ? {
                talkEvent: expect.objectContaining({
                  type,
                  turnId,
                  seq: lastTalkEventSeq + index + 1,
                  payload: { reason },
                  final: true,
                }),
              }
            : {}),
        },
        new Set(["conn-1"]),
        { dropIfSlow: false },
      ]),
    );
    expect(relay.harness.talk.activeTurnId).toBe(resetting ? undefined : activeTurnId);
    expect(relay.harness.talk.recentEvents).toHaveLength(
      talkEventCount + expectedClears.filter(({ turnId }) => turnId).length,
    );
    expect(bridge.acknowledgeMark).not.toHaveBeenCalled();

    captured.request.onClearAudio("barge-in");
    expect(broadcastToConnIds).toHaveBeenLastCalledWith(
      "talk.event",
      { relaySessionId: session.relaySessionId, type: "clear", reason: "barge-in" },
      new Set(["conn-1"]),
      { dropIfSlow: false },
    );

    if (resetting) {
      captured.request.onEvent?.({ direction: "server", type: "session.created" });
    }
    if (resetting || phase === "idle" || phase === "completed response") {
      providerEvent(captured.request, "response.created", {
        responseId: resetting ? "response-c" : "response-b",
      });
    }
    captured.request.onAudio(Buffer.from([1, 2]));
    expect(broadcastToConnIds).toHaveBeenLastCalledWith(
      "talk.event",
      expect.objectContaining({
        type: "audio",
        responseId: resetting ? "response-c" : "response-b",
        audioBase64: "AQI=",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
    expect(relaySessions.get(session.relaySessionId)).toBe(relay);
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it.each([
    { source: "turn", reason: "barge-in" },
    { source: "session", reason: "relay-closed" },
    { source: "abort", reason: "relay-closed" },
    { source: "detach", reason: undefined },
    { source: "provider", reason: "relay-error" },
    { source: "disconnect", reason: undefined },
  ] as const)("settles linked agent runs on $source termination", async ({ source, reason }) => {
    const close = vi.fn();
    const captured = captureProvider(() => makeRelayTransport({ close }));
    const { provider } = captured;
    const { abortController, broadcast, nodeSendToSession, removeChatRun, chatRunState, session } =
      await createAbortableRelayRunFixture(provider);
    if (source === "turn") {
      relaySessions.get(session.relaySessionId)?.harness.talk.startTurn({ turnId: "turn-1" });
      void cancelTurn(session, "turn-1", "barge-in");
      expect(removeChatRun).toHaveBeenCalledWith("run-1", "run-1", "agent:main:main");
    } else if (source === "session" || source === "abort" || source === "detach") {
      void stopTalkRealtimeRelaySession({
        ...relayTarget(session),
        ...(source !== "session" ? { disposition: source } : {}),
      });
    } else if (source === "provider") {
      captured.request?.onClose?.("error");
    } else {
      cleanupTalkConnection("conn-1", { warn: vi.fn() });
      expect(close).toHaveBeenCalledOnce();
      expect(relaySessions.has(session.relaySessionId)).toBe(false);
    }
    expect(abortController.signal.aborted).toBe(reason !== undefined);
    if (reason) {
      expect(chatRunState.runs.get("run-1")?.agentText).toBeUndefined();
      expectChatAbortPayload(broadcast, reason);
      expectNodeAbortPayload(nodeSendToSession);
    }
  });

  it.each(["stale", "idle"] as const)(
    "reports %s without mutating an unmatched relay turn",
    async (status) => {
      const { abortController, broadcast, session } = await createAbortableRelayRunFixture();
      const relay = relaySessions.get(session.relaySessionId);
      expect(relay).toBeDefined();
      if (status === "stale") {
        relay?.harness.talk.startTurn({ turnId: "turn-a" });
        relay?.harness.talk.startTurn({ turnId: "turn-b" });
      } else {
        relay?.harness.talk.clearActiveTurn();
      }
      const epoch = relay?.toolResultEpoch;
      const forcedResult = { result: { status: "cancelled" }, turnId: "turn-b", epoch: epoch ?? 0 };
      if (status === "stale") {
        relay?.forcedTerminalProviderResults.set("call-1", forcedResult);
      }
      await expect(cancelTurn(session, "turn-a", "barge-in")).resolves.toEqual({ status });
      expect(relay?.harness.talk.activeTurnId).toBe(status === "stale" ? "turn-b" : undefined);
      expect(relay?.toolResultEpoch).toBe(epoch);
      if (status === "stale") {
        expect(relay?.forcedTerminalProviderResults.get("call-1")).toBe(forcedResult);
      }
      expect(abortController.signal.aborted).toBe(false);
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it.each<{
    mode: "continuous" | "capability";
    fails: boolean;
    replacementReady?: boolean;
  }>([
    { mode: "capability", fails: false },
    { mode: "continuous", fails: true },
    { mode: "continuous", fails: false, replacementReady: false },
    { mode: "continuous", fails: false, replacementReady: true },
  ] as const)(
    "keeps automatic interruption provider-owned and finalizes an explicit stop ($mode, failure=$fails, replacementReady=$replacementReady)",
    async ({ mode, fails, replacementReady }) => {
      const finalization = createDeferred();
      const close = vi.fn(() => finalization.promise);
      const handleBargeIn = vi.fn();
      const sendAudio = vi.fn();
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const provider = createIdleRelayProvider();
      if (mode === "capability") {
        provider.capabilities = {
          transports: ["gateway-relay"],
          inputAudioFormats: [],
          outputAudioFormats: [],
          supportsBargeIn: false,
        };
      }
      provider.createBridge = (request) => {
        bridgeRequest = request;
        return makeRelayTransport({
          close,
          handleBargeIn,
          sendAudio,
          ...(mode === "continuous" ? { outputAudioMode: "continuous" as const } : {}),
        });
      };
      const { abortController, broadcastToConnIds, session } = await createAbortableRelayRunFixture(
        provider,
        { voiceSelection: replacementReady !== undefined },
      );
      const turnId = ensureActiveRelayTurnId(session.relaySessionId);
      bridgeRequest?.onAudio(Buffer.from([1, 2]));
      const target = { relaySessionId: session.relaySessionId, connId: "conn-1" };
      let voiceChange: ReturnType<typeof startRelayVoiceChange> | undefined;
      try {
        await expect(
          cancelTalkRealtimeRelayTurn({ ...target, turnId: "stale-turn", reason: "user" }),
        ).resolves.toEqual({ status: "stale" });
        const eventsBeforeBargeIn = broadcastToConnIds.mock.calls.length;
        const automaticCancellation = cancelTalkRealtimeRelayTurn({
          ...target,
          turnId,
          reason: "barge-in",
        });
        expect(close).not.toHaveBeenCalled();
        await expect(automaticCancellation).resolves.toEqual({ status: "idle" });
        expect(abortController.signal.aborted).toBe(false);
        expect(broadcastToConnIds.mock.calls).toHaveLength(eventsBeforeBargeIn);
        expect(relaySessions.get(session.relaySessionId)?.harness.talk.activeTurnId).toBe(turnId);
        await sendTalkRealtimeRelayAudio({ ...target, audioBase64: "AQI=" });
        expect(sendAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([1, 2]));

        if (replacementReady !== undefined) {
          voiceChange = startRelayVoiceChange(session.relaySessionId, replacementReady);
        }
        const cancellation = cancelTalkRealtimeRelayTurn({ ...target, turnId, reason: "user" });
        void cancellation.catch(() => {});
        expect(close).toHaveBeenCalledExactlyOnceWith({ disposition: "abort" });
        expect(handleBargeIn).not.toHaveBeenCalled();
        expect(abortController.signal.aborted).toBe(true);
        if (voiceChange) {
          expect(voiceChange.send).toHaveBeenLastCalledWith(
            expect.objectContaining({ phase: "cancelled" }),
          );
          await expect(voiceChange.changing).rejects.toThrow("stopped");
          await expect(
            completeTalkVoiceChange({
              changeId: voiceChange.changeId,
              connId: "conn-1",
              voiceSessionId: voiceChange.replacementId,
              outcome: "ready",
            }),
          ).rejects.toThrow("not owned");
        }
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "talk.event",
          expect.objectContaining({
            type: "clear",
            talkEvent: expect.objectContaining({ type: "turn.cancelled", turnId }),
          }),
          new Set(["conn-1"]),
          { dropIfSlow: false },
        );
        expect(() => sendTalkRealtimeRelayAudio({ ...target, audioBase64: "AQI=" })).toThrow(
          "Unknown realtime relay session",
        );
        const eventCount = broadcastToConnIds.mock.calls.length;
        bridgeRequest?.onAudio(Buffer.from([3, 4]));
        expect(broadcastToConnIds.mock.calls).toHaveLength(eventCount);
        const settled = vi.fn();
        void cancellation.then(settled, settled);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        const completion = fails
          ? expect(cancellation).rejects.toThrow("finalization failed")
          : expect(cancellation).resolves.toEqual({ status: "applied", turnId });
        if (fails) {
          finalization.reject(new Error("finalization failed"));
        } else {
          finalization.resolve();
        }
        await completion;
        expect(broadcastToConnIds).toHaveBeenLastCalledWith(
          "talk.event",
          expect.objectContaining({
            type: "close",
            reason: fails ? "error" : "completed",
            talkEvent: expect.objectContaining({
              type: "session.closed",
              payload: { reason: fails ? "error" : "output-cancelled" },
            }),
          }),
          new Set(["conn-1"]),
          { dropIfSlow: false },
        );
      } finally {
        finalization.resolve();
        await voiceChange?.cleanup();
      }
    },
  );

  it.each([false, true])(
    "cancels an interruptible relay voice change on explicit Stop (replacement ready=%s)",
    async (replacementReady) => {
      const { abortController, session } = await createAbortableRelayRunFixture(
        createIdleRelayProvider(),
        { voiceSelection: true },
      );
      const turnId = ensureActiveRelayTurnId(session.relaySessionId);
      const voiceChange = startRelayVoiceChange(session.relaySessionId, replacementReady);
      const target = { relaySessionId: session.relaySessionId, connId: "conn-1" };
      try {
        await expect(
          cancelTalkRealtimeRelayTurn({ ...target, turnId: "stale-turn", reason: "user" }),
        ).resolves.toEqual({ status: "stale" });
        expect(voiceChange.send).toHaveBeenCalledTimes(1);

        const cancellation = cancelTalkRealtimeRelayTurn({ ...target, turnId, reason: "user" });
        void cancellation.catch(() => {});
        expect(voiceChange.send).toHaveBeenLastCalledWith(
          expect.objectContaining({ phase: "cancelled" }),
        );
        await expect(voiceChange.changing).rejects.toThrow("stopped");
        expect(abortController.signal.aborted).toBe(true);
        void stopTalkRealtimeRelaySession(target);
        await cancellation;
        await expect(
          completeTalkVoiceChange({
            changeId: voiceChange.changeId,
            connId: "conn-1",
            voiceSessionId: voiceChange.replacementId,
            outcome: "ready",
          }),
        ).rejects.toThrow("not owned");
      } finally {
        await voiceChange.cleanup();
      }
    },
  );

  it("recovers an exact-response relay only after matching provider cancellation", async () => {
    vi.useFakeTimers();
    const handleBargeIn = vi.fn();
    const close = vi.fn();
    const sendAudio = vi.fn();
    const captured = captureProvider(() =>
      makeRelayTransport({
        handleBargeIn,
        close,
        sendAudio,
        submitToolResult: vi.fn(() => {
          throw new Error("provider rejected cancellation");
        }),
      }),
    );
    const { provider } = captured;
    const { session } = await createAbortableRelayRunFixture(provider);
    providerEvent(captured.request, "response.created", { responseId: "response-1" });

    let cancellationSettled = false;
    const cancellation = cancelTurn(session, ensureActiveRelayTurnId(session.relaySessionId));
    void cancellation.then(() => (cancellationSettled = true));
    await Promise.resolve();
    expect(handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: true });
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(cancellationSettled).toBe(false);

    const resumedAudio = transmitAudio(session, "AQI=");
    captured.request?.onResponseDone?.({ status: "completed", responseId: "response-other" });
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);
    expect(sendAudio).not.toHaveBeenCalled();

    providerEvent(captured.request, "response.cancelled", { responseId: "response-1" });
    await expect(Promise.all([cancellation, resumedAudio])).resolves.toEqual([
      { status: "applied", turnId: expect.any(String) },
      undefined,
    ]);
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["completed", "error"] as const)(
    "passes through provider %s close and settles exact-response cancellation once",
    async (reason) => {
      vi.useFakeTimers();
      const close = vi.fn();
      const captured = captureProvider(() => makeRelayTransport({ close }));
      const { provider } = captured;
      const { broadcastToConnIds, session } = await createAbortableRelayRunFixture(provider);
      providerEvent(captured.request, "response.created", { responseId: "response-1" });
      const cancellation = cancelTurn(session, ensureActiveRelayTurnId(session.relaySessionId));
      const settled = vi.fn();
      void cancellation.then(settled);

      captured.request?.onClose?.(reason);
      captured.request?.onClose?.(reason);

      await expect(cancellation).resolves.toEqual({
        status: "applied",
        turnId: expect.any(String),
      });
      expect(settled).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(relaySessions.has(session.relaySessionId)).toBe(false);
      const closeEvents = mockEventPayloads(broadcastToConnIds, "close");
      expect(closeEvents).toHaveLength(1);
      expect(closeEvents[0]).toMatchObject({ reason });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(relaySessions.has(session.relaySessionId)).toBe(false);
      expect(mockEventPayloads(broadcastToConnIds, "close")).toHaveLength(1);
    },
  );

  it("fails visibly when a replacement response starts before cancellation confirms", async () => {
    const close = vi.fn();
    const captured = captureProvider(() => makeRelayTransport({ close }));
    const { provider } = captured;
    const { broadcastToConnIds, session } = await createAbortableRelayRunFixture(provider);
    providerEvent(captured.request, "response.created", { responseId: "response-1" });
    const cancellation = cancelTurn(session, ensureActiveRelayTurnId(session.relaySessionId));

    providerEvent(captured.request, "response.created", { responseId: "response-2" });

    expect(relaySessions.get(session.relaySessionId)?.harness.talk.activeTurnId).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(relaySessions.has(session.relaySessionId)).toBe(false);
    await expect(cancellation).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
    expect(mockEventPayloads(broadcastToConnIds, "error").length > 0).toBe(true);
    expect(mockEventPayloads(broadcastToConnIds, "responseStarted")).toHaveLength(1);
  });

  it("provider close owns turn-bound drain teardown and late drain cannot touch a successor", async () => {
    vi.useFakeTimers();
    const pending = createDeferred();
    const close = vi.fn();
    const captured = captureProvider(() =>
      makeRelayTransport({ close, submitToolResult: vi.fn(() => pending.promise) }),
    );
    const { provider } = captured;
    const { session } = await createAbortableRelayRunFixture(provider);
    const cancellation = cancelTurn(session, ensureActiveRelayTurnId(session.relaySessionId));

    captured.request?.onClose?.("completed");
    await expect(cancellation).resolves.toEqual({
      status: "applied",
      turnId: expect.any(String),
    });
    expect(close).toHaveBeenCalledOnce();

    const successor = await createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      provider: createIdleRelayProvider(),
    });
    pending.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(relaySessions.has(successor.relaySessionId)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("serializes a final consult result behind async working acceptance", async () => {
    const working = createDeferred();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(working.promise)
      .mockReturnValueOnce(undefined);
    const captured = captureProvider(() =>
      makeRelayTransport({
        supportsToolResultContinuation: true,
        submitToolResult,
      }),
    );
    const { provider } = captured;
    const events: Array<{ payload: Record<string, unknown> }> = [];
    const session = await createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: (_event: string, payload: unknown) => {
          events.push({ payload: payload as Record<string, unknown> });
        },
      } as never,
      provider,
    });
    ensureActiveRelayTurnId(session.relaySessionId);
    consultCall(captured.request, "item-1", "call-1", "check");
    const finalSubmission = submitResult(session, "call-1", { answer: "done" });

    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(
      events.map((entry) => (entry.payload.talkEvent as { type?: string } | undefined)?.type),
    ).toContain("tool.call");
    expect(
      events.map((entry) => (entry.payload.talkEvent as { type?: string } | undefined)?.type),
    ).not.toContain("tool.progress");

    working.resolve();
    await finalSubmission;
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ status: "working" }),
      { answer: "done" },
    ]);
    const talkTypes = events
      .map((entry) => (entry.payload.talkEvent as { type?: string } | undefined)?.type)
      .filter(Boolean);
    expect(talkTypes.indexOf("tool.call")).toBeLessThan(talkTypes.indexOf("tool.progress"));
    expect(talkTypes.indexOf("tool.progress")).toBeLessThan(talkTypes.indexOf("tool.result"));
  });

  it.each([false, true])(
    "serializes a final result behind client interims (rejection=%s)",
    async (rejects) => {
      const firstAccepted = createDeferred();
      const secondAccepted = createDeferred();
      const submitToolResult = vi
        .fn<RealtimeVoiceBridge["submitToolResult"]>()
        .mockReturnValueOnce(firstAccepted.promise)
        .mockReturnValueOnce(rejects ? undefined : secondAccepted.promise)
        .mockReturnValueOnce(undefined);
      const provider = createIdleRelayProvider(() => makeRelayTransport({ submitToolResult }));
      const session = await createTalkRealtimeRelaySession({
        context: { broadcastToConnIds: vi.fn() } as never,
        provider,
      });

      const firstInterim = submitResult(
        session,
        "call-1",
        { phase: rejects ? "checking" : "first" },
        { willContinue: true },
      );
      const secondInterim = rejects
        ? undefined
        : submitResult(session, "call-1", { phase: "second" }, { willContinue: true });
      expect(submitToolResult).toHaveBeenCalledTimes(1);

      if (!rejects) {
        firstAccepted.resolve();
        await firstInterim;
        expect(submitToolResult).toHaveBeenCalledTimes(2);
      }

      const final = submitResult(session, "call-1", { answer: "done" });
      expect(submitToolResult).not.toHaveBeenCalledWith("call-1", { answer: "done" }, undefined);

      if (rejects) {
        firstAccepted.reject(new Error("interim rejected"));
        await expect(firstInterim).rejects.toThrow("interim rejected");
      } else {
        secondAccepted.resolve();
        await Promise.all([firstInterim, secondInterim]);
      }
      await final;
      expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual(
        rejects
          ? [{ phase: "checking" }, { answer: "done" }]
          : [{ phase: "first" }, { phase: "second" }, { answer: "done" }],
      );
    },
  );

  it("supersedes queued interims and a stale final with canonical cancellation", async () => {
    const interimAccepted = createDeferred();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(interimAccepted.promise)
      .mockReturnValueOnce(undefined);
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({
        submitToolResult,
      });
    const { broadcastToConnIds, session } = await createAbortableRelayRunFixture(provider);
    const firstInterim = submitResult(
      session,
      "call-1",
      { phase: "first" },
      { willContinue: true },
    );
    const secondInterim = submitResult(
      session,
      "call-1",
      { phase: "second" },
      { willContinue: true },
    );
    const final = submitResult(session, "call-1", { answer: "stale" });
    void cancelTurn(session, ensureActiveRelayTurnId(session.relaySessionId), "barge-in");
    const cancellation = submitResult(session, "call-1", { error: "aborted" });

    interimAccepted.resolve();
    await Promise.all([firstInterim, secondInterim, final, cancellation]);
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { phase: "first" },
      CANCELLED_RESULT,
    ]);
    expect(submitToolResult.mock.calls[1]?.[2]).toEqual({ suppressResponse: true });
    expect(
      mockEventPayloads(broadcastToConnIds, "toolResult").some(({ callId }) => callId === "call-1"),
    ).toBe(false);
  });

  it.each([false, true])(
    "terminally cancels a queued final without affecting a replacement (continuity reset: %s)",
    async (continuityReset) => {
      const workingAccepted = createDeferred();
      const cancellationAccepted = createDeferred();
      const submitToolResult = vi
        .fn<RealtimeVoiceBridge["submitToolResult"]>()
        .mockReturnValueOnce(workingAccepted.promise)
        .mockReturnValueOnce(cancellationAccepted.promise);
      const captured = captureProvider(() =>
        makeRelayTransport({
          submitToolResult,
          supportsToolResultSuppression: false,
        }),
      );
      const { provider } = captured;
      const { broadcastToConnIds, session } = await createAbortableRelayRunFixture(provider);
      consultCall(captured.request, "original-item", "call-1", "status?");
      const working = submitResult(
        session,
        "call-1",
        { status: "working" },
        { willContinue: true },
      );
      const final = submitResult(session, "call-1", { answer: "stale" });

      const cancelled = cancelTurn(
        session,
        ensureActiveRelayTurnId(session.relaySessionId),
        "barge-in",
      );
      try {
        expect(relaySessions.has(session.relaySessionId)).toBe(true);
        workingAccepted.resolve();
        await working;
        await vi.waitFor(() => expect(submitToolResult).toHaveBeenCalledTimes(2));
        expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
          { status: "working" },
          CANCELLED_RESULT,
        ]);
        expect(submitToolResult.mock.calls[1]?.[2]).toBeUndefined();
        captured.request?.onEvent?.({ direction: "server", type: "response.cancelled" });
        await cancelled;

        let replacementCallId: string | undefined;
        if (continuityReset) {
          captured.request?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
          captured.request?.onReady?.();
          providerEvent(captured.request, "response.created", {
            responseId: "replacement-response",
          });
          consultCall(captured.request, "replacement-item", "call-1", "replacement status?");
          const replacementCall = mockEventPayloads(broadcastToConnIds, "toolCall").at(-1);
          expect(replacementCall?.itemId).toBe("replacement-item");
          replacementCallId = String(replacementCall?.callId);
          expect(replacementCallId).not.toBe("call-1");
          await expect(
            registerRun(session, replacementCallId, "run-2", "agent:main:main"),
          ).resolves.toMatchObject({ run: { runId: "run-2" } });
        }

        cancellationAccepted.resolve();
        await final;
        await nextEventLoopTurn();
        expect(relaySessions.has(session.relaySessionId)).toBe(true);
        if (replacementCallId) {
          expect(
            relaySessions.get(session.relaySessionId)?.activeAgentToolCalls.get(replacementCallId)
              ?.run.runId,
          ).toBe("run-2");
          await submitResult(session, replacementCallId, { answer: "replacement" });
          expect(submitToolResult).toHaveBeenLastCalledWith(
            "call-1",
            { answer: "replacement" },
            undefined,
          );
        }
        expect(
          mockEventPayloads(broadcastToConnIds, "toolResult").some(
            ({ callId }) => callId === "call-1",
          ),
        ).toBe(false);
        expect(submitToolResult).toHaveBeenCalledTimes(continuityReset ? 3 : 2);
      } finally {
        workingAccepted.resolve();
        cancellationAccepted.resolve();
        captured.request?.onEvent?.({ direction: "server", type: "response.cancelled" });
        await Promise.allSettled([working, final, cancelled]);
        await nextEventLoopTurn();
      }
    },
  );

  it.each([false, true])(
    "supersedes a rejected final with canonical cancellation (forced: %s)",
    async (forced) => {
      const nativeSubmit = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
      const fixture = forced
        ? await createForcedConsultFixture(["native-call"])
        : {
            session: (
              await createAbortableRelayRunFixture(
                createIdleRelayProvider(() =>
                  makeRelayTransport({ submitToolResult: nativeSubmit }),
                ),
              )
            ).session,
            callId: "call-1",
            submitToolResult: nativeSubmit,
          };
      const rejectedFinal = createDeferred();
      const cancellationAccepted = createDeferred();
      fixture.submitToolResult
        .mockReturnValueOnce(rejectedFinal.promise)
        .mockReturnValueOnce(forced ? undefined : cancellationAccepted.promise);
      const target = {
        ...relayTarget(fixture.session),
        callId: fixture.callId,
      };
      const staleFinal = submitTalkRealtimeRelayToolResult({
        ...target,
        result: { answer: "stale" },
      });
      void cancelTalkRealtimeRelayTurn({
        ...target,
        reason: "barge-in",
        turnId: ensureActiveRelayTurnId(fixture.session.relaySessionId),
      });
      const cancellation = submitTalkRealtimeRelayToolResult({
        ...target,
        result: forced ? { status: "working" } : { error: "aborted" },
        ...(forced ? { options: { willContinue: true } } : {}),
      });
      const message = forced ? "forced final rejected" : "stale final rejected";
      rejectedFinal.reject(new Error(message));
      await expect(staleFinal).rejects.toThrow(message);
      if (forced) {
        await cancellation;
      } else {
        await vi.waitFor(() => expect(fixture.submitToolResult).toHaveBeenCalledTimes(2));
        const duplicate = submitTalkRealtimeRelayToolResult({
          ...target,
          result: { error: "duplicate aborted" },
        });
        expect(fixture.submitToolResult).toHaveBeenCalledTimes(2);
        cancellationAccepted.resolve();
        await Promise.all([cancellation, duplicate]);
      }
      expect(fixture.submitToolResult.mock.calls.map((call) => call[1])).toEqual([
        { answer: "stale" },
        CANCELLED_RESULT,
      ]);
    },
  );

  it("waits for provider acceptance before broadcasting and clearing a final tool result", async () => {
    const deferred = createDeferred();
    const bridge = makeRelayTransport({
      submitToolResult: vi.fn(() => deferred.promise),
    });
    const provider: RealtimeVoiceProviderPlugin = createIdleRelayProvider(() => bridge);
    const { abortController, broadcast, broadcastToConnIds, session } =
      await createAbortableRelayRunFixture(provider);

    const submission = submitResult(session, "call-1", { ok: true });
    if (!submission) {
      throw new Error("Expected asynchronous provider submission");
    }
    const duplicate = submitResult(session, "call-1", { ok: "duplicate" });
    const followUp = submitResult(session, "call-1", { status: "working" }, { willContinue: true });

    expect(duplicate).toBe(submission);
    expect(followUp).toBe(submission);
    expect(bridge.submitToolResult).toHaveBeenCalledTimes(1);
    expect(mockEventPayloads(broadcastToConnIds, "toolResult").length > 0).toBe(false);

    deferred.resolve();
    await submission;

    const toolResultEvents = () => mockEventPayloads(broadcastToConnIds, "toolResult");
    expect(toolResultEvents()).toHaveLength(1);
    expect(submitResult(session, "call-1", { ok: "already completed" })).toBeUndefined();
    expect(bridge.submitToolResult).toHaveBeenCalledTimes(1);
    expect(toolResultEvents()).toHaveLength(1);
    void cancelTurn(session, ensureActiveRelayTurnId(session.relaySessionId), "barge-in");
    expect(abortController.signal.aborted).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted" }),
      expect.anything(),
    );
  });

  it.each([
    { nextAction: "cancel", error: "provider rejected tool result", initialOk: true },
    { nextAction: "retry", error: "temporary rejection", initialOk: false },
  ] as const)(
    "preserves rejected tool results for $nextAction",
    async ({ nextAction, error, initialOk }) => {
      let attempt = 0;
      const bridge = makeRelayTransport({
        submitToolResult: vi.fn(() => {
          attempt += 1;
          return nextAction === "cancel" || attempt === 1
            ? Promise.reject(new Error(error))
            : undefined;
        }),
      });
      const provider = createIdleRelayProvider(() => bridge);
      const { abortController, broadcastToConnIds, session } =
        await createAbortableRelayRunFixture(provider);
      const target = { relaySessionId: session.relaySessionId, connId: "conn-1", callId: "call-1" };
      const submission = submitTalkRealtimeRelayToolResult({
        ...target,
        result: { ok: initialOk },
      });
      if (!submission) {
        throw new Error("Expected asynchronous provider submission");
      }
      await expect(submission).rejects.toThrow(error);
      const resultEvents = () => mockEventPayloads(broadcastToConnIds, "toolResult");
      expect(resultEvents()).toHaveLength(0);
      if (nextAction === "cancel") {
        void cancelTalkRealtimeRelayTurn({
          ...target,
          reason: "barge-in",
          turnId: ensureActiveRelayTurnId(session.relaySessionId),
        });
        expect(abortController.signal.aborted).toBe(true);
      } else {
        expect(
          submitTalkRealtimeRelayToolResult({ ...target, result: { ok: true } }),
        ).toBeUndefined();
        expect(bridge.submitToolResult).toHaveBeenCalledTimes(2);
        expect(resultEvents()).toHaveLength(1);
      }
    },
  );

  it.each([
    [true, "replacement"],
    [false, "replacement"],
    [true, "idle"],
    [false, "idle"],
    [true, "disconnect"],
    [false, "disconnect"],
  ] as const)(
    "pins control admission before a %s native / %s transition",
    async (native, transition) => {
      let request: RealtimeVoiceBridgeCreateRequest | undefined;
      const bridge = makeRelayTransport({ sendUserMessage: vi.fn() });
      const capabilities: RealtimeVoiceProviderCapabilities = {
        transports: ["gateway-relay"],
        inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        supportsToolCalls: transition !== "idle",
      };
      const provider: RealtimeVoiceProviderPlugin = {
        id: "relay-test",
        label: "Relay Test",
        capabilities,
        isConfigured: () => true,
        createBridge: (input) => {
          request = input;
          return bridge;
        },
      };
      Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
        value: {
          isBrowserSessionConfigured: () => true,
          resolveGatewayRelayCapabilities: () => ({ ...capabilities, handlesAgentConsult: native }),
        },
      });
      const fixture = await createAbortableRelayRunFixture(provider);
      const relay = relaySessions.get(fixture.session.relaySessionId);
      if (!relay || !request) {
        throw new Error("Missing relay fixture");
      }
      const controls = rpcSourceTesting;
      const original = controls.get("run-1");
      if (!original) {
        throw new Error("Missing original registration");
      }
      const queueMessage = vi.fn(async () => undefined);
      const abort = vi.fn();
      const backend = {
        runId: "run-1",
        queueMessage,
        abort,
        isStreaming: () => true,
        isCompacting: () => false,
      };
      const originalAttachment = attachActiveEmbeddedRun(
        "run-1",
        backend,
        original.input.claim!.operation!.key,
        undefined,
        "main",
        original.input.claim!.operation!,
      );
      const replacementBackend = { ...backend };
      let replacementAttachment: ReturnType<typeof attachActiveEmbeddedRun>;
      try {
        if (transition === "idle") {
          controls.delete("run-1");
        }
        const respond = vi.fn();
        if (native) {
          expect(request.handleDelegationInput?.("cancel", respond)).toBe("control");
        } else {
          request.onTranscript?.("user", "cancel", true);
        }
        controls.set("run-1", { ...original });
        replacementAttachment = attachActiveEmbeddedRun(
          "run-1",
          replacementBackend,
          original.input.claim!.operation!.key,
          undefined,
          "main",
          original.input.claim!.operation!,
        );
        if (transition === "disconnect") {
          cleanupTalkConnection("conn-1", { warn: vi.fn() });
        }
        await nextEventLoopTurn();
        if (transition !== "disconnect") {
          await vi.waitFor(() =>
            expect(native ? respond : bridge.sendUserMessage).toHaveBeenCalledWith(
              expect.stringContaining("There is no active OpenClaw run to cancel."),
            ),
          );
        } else {
          expect(respond).not.toHaveBeenCalled();
        }
        expect(abort).not.toHaveBeenCalled();
        expect(queueMessage).not.toHaveBeenCalled();
      } finally {
        for (const attachment of [replacementAttachment, originalAttachment]) {
          if (attachment) {
            detachActiveEmbeddedRun(
              attachment.sessionId,
              attachment.handle,
              attachment.sessionKey,
              undefined,
              "run_completed",
              attachment,
            );
          }
        }
      }
    },
  );

  it("returns structured relay steering status and emits Talk progress", async () => {
    const provider = createIdleRelayProvider();
    const { events, context } = createRelayEventRecorder();
    const session = await createTalkRealtimeRelaySession({ context, provider });

    await expect(
      steerTalkRealtimeRelayAgentRun({
        ...relayTarget(session),
        sessionKey: "agent:other:main",
        text: "status",
        mode: "status",
      }),
    ).rejects.toThrow("Realtime relay steering session key does not match the relay session");

    const result = await steerTalkRealtimeRelayAgentRun({
      ...relayTarget(session),
      sessionKey: "agent:main:main",
      text: "status",
      mode: "status",
    });

    expect(result).toMatchObject({
      ok: true,
      mode: "status",
      sessionKey: "agent:main:main",
      active: false,
    });
    const progressPayload = findEventPayload(events, "toolProgress");
    expectRecordFields(progressPayload, {
      relaySessionId: session.relaySessionId,
      type: "toolProgress",
    });
    expectRecordFields(progressPayload.talkEvent, {
      type: "tool.progress",
      final: true,
    });
  });

  it.each([
    {
      supportsSuppression: undefined,
      expectedOptions: { suppressResponse: true },
      expectedSuppress: false,
    },
    { supportsSuppression: false, expectedOptions: undefined, expectedSuppress: true },
  ])(
    "submits a final provider result when voice cancel aborts an active relay run ($supportsSuppression)",
    async ({ supportsSuppression, expectedOptions, expectedSuppress }) => {
      const abortEmbeddedRun = vi.fn();
      const backend = embeddedBackend(abortEmbeddedRun);
      const bridge = makeRelayTransport({
        supportsToolResultSuppression: supportsSuppression,
      });
      const provider: RealtimeVoiceProviderPlugin = createIdleRelayProvider(() => bridge);
      const { abortController, broadcast, session } = await createAbortableRelayRunFixture(
        provider,
        { backend },
      );

      const result = await steerTalkRealtimeRelayAgentRun({
        ...relayTarget(session),
        text: "cancel that",
        mode: "cancel",
      });
      void cancelTurn(session, ensureActiveRelayTurnId(session.relaySessionId), "barge-in");

      expect(result).toMatchObject({
        ok: true,
        mode: "cancel",
        suppress: expectedSuppress,
        providerResult: {
          status: "cancelled",
          message: "Cancelled the active OpenClaw run.",
        },
      });
      expect(abortEmbeddedRun).toHaveBeenCalledTimes(1);
      expect(bridge.submitToolResult).toHaveBeenCalledWith(
        "call-1",
        {
          status: "cancelled",
          message: "Cancelled the active OpenClaw run.",
        },
        expectedOptions,
      );
      expect(abortController.signal.aborted).toBe(true);
      expect(broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId: "run-1", state: "aborted" }),
        expect.anything(),
      );

      void submitResult(session, "call-1", { error: "aborted" });
      expect(bridge.submitToolResult).toHaveBeenCalledTimes(1);
    },
  );

  it("finalizes accepted cancel calls independently when another provider result rejects", async () => {
    const backend = embeddedBackend();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second cancel rejected"));
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({
        submitToolResult,
      });
    const { broadcastToConnIds, session } = await createAbortableRelayRunFixture(provider, {
      backend,
    });
    await registerRun(session, "call-2", "run-1", "agent:main:main");

    await expect(
      steerTalkRealtimeRelayAgentRun({
        ...relayTarget(session),
        text: "cancel that",
        mode: "cancel",
      }),
    ).rejects.toThrow("second cancel rejected");

    expect(
      mockEventPayloads(broadcastToConnIds, "toolResult").filter(
        ({ callId }) => callId === "call-1",
      ),
    ).toHaveLength(1);
    expect(submitResult(session, "call-1", { late: true })).toBeUndefined();
    expect(submitToolResult).toHaveBeenCalledTimes(2);

    await submitResult(session, "call-2", { retry: true });
    expect(submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "call-1",
      "call-2",
      "call-2",
    ]);
  });

  it("does not broadcast steering progress after the relay closes during provider acceptance", async () => {
    const backend = embeddedBackend();
    const accepted = createDeferred();
    const submitToolResult = vi.fn(() => accepted.promise);
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({
        submitToolResult,
      });
    const { broadcastToConnIds, session } = await createAbortableRelayRunFixture(provider, {
      backend,
    });

    const steering = steerTalkRealtimeRelayAgentRun({
      ...relayTarget(session),
      text: "cancel that",
      mode: "cancel",
    });
    await vi.waitFor(() => expect(submitToolResult).toHaveBeenCalledTimes(1));
    void stopTalkRealtimeRelaySession({
      ...relayTarget(session),
    });
    accepted.resolve();
    await steering;

    expect(mockEventPayloads(broadcastToConnIds, "toolProgress")).toHaveLength(0);
  });

  it.each([false, true])(
    "settles forced consult cancellation without losing delivery (native rejection: %s)",
    async (nativeRejects) => {
      vi.useFakeTimers();
      const abortEmbeddedRun = vi.fn();
      const backend = embeddedBackend(abortEmbeddedRun);
      let rejectNextSubmission = false;
      const bridge = makeRelayTransport({
        supportsToolResultContinuation: true,
        sendUserMessage: vi.fn(),
        triggerGreeting: vi.fn(),
        submitToolResult: vi.fn(() => {
          if (!rejectNextSubmission) {
            return undefined;
          }
          rejectNextSubmission = false;
          return Promise.reject(new Error("provider cancellation rejected"));
        }),
      });
      const captured = captureProvider(() => bridge);
      const { provider } = captured;
      const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
      await createOwnedTalkRunControllers(backend);
      const session = await createTalkRealtimeRelaySession({
        context: {
          ...stopCapableContext(),
          broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
            events.push({ event, payload, connIds: [...connIds] });
          },
        } as never,
        provider,
        instructions: "be brief",
        sessionKey: "main",
        forceAgentConsultOnFinalTranscript: true,
      });
      await Promise.resolve();
      captured.request?.onTranscript?.("user", "Can you check this?", true);
      await vi.advanceTimersByTimeAsync(250);
      const forcedToolCall = findEventPayload(events, "toolCall", { forced: true });
      const callId = String(forcedToolCall.callId);
      if (nativeRejects) {
        consultCall(captured.request, "native-item", "native-call", "Can you check this?");
      }
      await registerRun(session, callId, "run-1", "agent:main:main");
      rejectNextSubmission = nativeRejects;
      const cancellation = steerTalkRealtimeRelayAgentRun({
        ...relayTarget(session),
        text: "cancel that",
        mode: "cancel",
      });
      if (nativeRejects) {
        await expect(cancellation).rejects.toThrow("provider cancellation rejected");
        await submitResult(session, callId, { result: "Here is the checked answer." });
        expect(bridge.submitToolResult).toHaveBeenLastCalledWith("native-call", DELIVERED_RESULT, {
          suppressResponse: true,
        });
        expect(bridge.sendUserMessage).toHaveBeenLastCalledWith(
          expect.stringContaining("Here is the checked answer."),
        );
      } else {
        expect(await cancellation).toMatchObject({
          ok: true,
          mode: "cancel",
          providerResult: { status: "cancelled", message: "Cancelled the active OpenClaw run." },
        });
        expect(abortEmbeddedRun).toHaveBeenCalledTimes(1);
        expect(bridge.submitToolResult).not.toHaveBeenCalled();
        const toolResult = findEventPayload(events, "toolResult", { callId });
        expectRecordFields(toolResult, {
          relaySessionId: session.relaySessionId,
          type: "toolResult",
          callId,
        });
      }
    },
  );

  it("terminally cancels late forced working even when willContinue is set", async () => {
    const fixture = await createForcedConsultFixture(["native-1"]);
    void cancelTurn(
      fixture.session,
      ensureActiveRelayTurnId(fixture.session.relaySessionId),
      "barge-in",
    );
    const startedTurns = () =>
      fixture.events.filter(
        (entry) =>
          (entry.payload as { talkEvent?: { type?: string } }).talkEvent?.type === "turn.started",
      ).length;
    const beforeLateCalls = startedTurns();

    consultCall(fixture.bridgeRequest, "late-native-item", "native-2", "Can you check this?");
    await submitResult(
      fixture.session,
      fixture.callId,
      { status: "working" },
      { willContinue: true },
    );

    expect(startedTurns()).toBe(beforeLateCalls);
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual(["native-1"]);
    for (const call of fixture.submitToolResult.mock.calls) {
      expect(call[1]).toEqual(CANCELLED_RESULT);
      expect(call[2]).toBeUndefined();
    }
    expect(
      fixture.events.filter(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolCall" &&
          (entry.payload as { callId?: string }).callId === "native-2",
      ),
    ).toHaveLength(0);
    const terminal = findEventPayload(
      fixture.events,
      (payload) =>
        payload.type === "toolResult" &&
        payload.callId === fixture.callId &&
        (payload.talkEvent as { final?: boolean } | undefined)?.final === true,
    );
    expectRecordFields((terminal.talkEvent as Record<string, unknown>).payload, {
      result: CANCELLED_RESULT,
      forced: true,
    });
  });

  it("terminally cancels a forced final queued behind native working acceptance", async () => {
    const workingAccepted = createDeferred();
    const fixture = await createForcedConsultFixture(["native-call"], {
      firstSubmission: workingAccepted.promise,
      supportsToolResultContinuation: true,
    });
    const final = submitResult(fixture.session, fixture.callId, { answer: "stale" });

    void cancelTurn(
      fixture.session,
      ensureActiveRelayTurnId(fixture.session.relaySessionId),
      "barge-in",
    );
    workingAccepted.resolve();
    await final;

    expect(fixture.submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ status: "working" }),
      CANCELLED_RESULT,
    ]);
    expect(fixture.submitToolResult.mock.calls[1]?.[2]).toBeUndefined();
    expect(
      fixture.events.some(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === fixture.callId,
      ),
    ).toBe(true);
  });

  it.each([
    ["status", false, false, "I'm not working on an active request right now."],
    ["status", true, false, undefined],
    ["cancel", false, true, "There is no active OpenClaw run to cancel."],
  ])(
    "routes idle %s (tools=%s, delegation=%s)",
    async (text, supportsToolCalls, handlesAgentConsult, reply) => {
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const bridge = makeRelayTransport({
        sendUserMessage: vi.fn(),
      });
      const capabilities: RealtimeVoiceProviderCapabilities = {
        transports: ["gateway-relay"],
        inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        supportsToolCalls: true,
      };
      const provider: RealtimeVoiceProviderPlugin = {
        id: "relay-test",
        label: "Relay Test",
        isConfigured: () => true,
        capabilities,
        createBridge: (req) => {
          bridgeRequest = req;
          return bridge;
        },
      };
      Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
        value: {
          isBrowserSessionConfigured: () => true,
          resolveGatewayRelayCapabilities: () => ({
            ...capabilities,
            supportsToolCalls,
            handlesAgentConsult,
          }),
        },
      });
      const context = {
        broadcastToConnIds: vi.fn(),
      } as never;
      const session = await createTalkRealtimeRelaySession({
        context,
        provider,
      });
      await registerRun(session, "call-1", "stale-run", "agent:main:main");

      const respond = vi.fn();
      expect(bridgeRequest?.handleDelegationInput).toEqual(
        handlesAgentConsult ? expect.any(Function) : undefined,
      );
      if (handlesAgentConsult) {
        expect(bridgeRequest?.handleDelegationInput?.("Check the weather.", respond)).toBe(
          "consult",
        );
        expect(bridgeRequest?.handleDelegationInput?.(text, respond)).toBe("control");
      }
      bridgeRequest?.onTranscript?.("user", text, true);

      await flushTalkRealtimeRelayVoiceWrites({
        ...relayTarget(session),
      });
      await nextEventLoopTurn();
      if (reply) {
        expect(
          handlesAgentConsult ? respond : bridge.sendUserMessage,
        ).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(reply));
      } else {
        expect(bridge.sendUserMessage).not.toHaveBeenCalled();
      }
      if (handlesAgentConsult) {
        expect(bridge.sendUserMessage).not.toHaveBeenCalled();
        const lateReply = vi.fn();
        const handleInput = bridgeRequest?.handleDelegationInput;
        expect(handleInput?.(text, lateReply)).toBe("control");
        void stopTalkRealtimeRelaySession({
          ...relayTarget(session),
        });
        expect(handleInput?.("Check another task.", lateReply)).toBe("control");
        await nextEventLoopTurn();
        expect(lateReply).not.toHaveBeenCalled();
      }
      expect(bridge.submitToolResult).not.toHaveBeenCalled();
    },
  );

  it.each(["client-stop", "provider-close", "provider-error", "explicit-abort"] as const)(
    "applies pending voice replacement policy when the relay ends via %s",
    async (ending) => {
      const close = vi.fn();
      const provider = createIdleRelayProvider();
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      provider.createBridge = (request) => {
        bridgeRequest = request;
        return makeRelayTransport({ close });
      };
      const { abortController, session } = await createAbortableRelayRunFixture(provider, {
        voiceSelection: true,
      });
      const voiceChange = startRelayVoiceChange(session.relaySessionId);
      try {
        if (ending === "client-stop") {
          void stopTalkRealtimeRelaySession({
            ...relayTarget(session),
          });
        } else if (ending === "explicit-abort") {
          const relay = relaySessions.get(session.relaySessionId);
          if (!relay) {
            throw new Error("Expected the active relay");
          }
          void closeRelaySession(relay, "completed", { disposition: "abort" });
        } else {
          if (ending === "provider-error") {
            bridgeRequest?.onError?.(new Error("Provider connection failed"));
          }
          bridgeRequest?.onClose?.(ending === "provider-error" ? "error" : "completed");
        }
        expect(close).toHaveBeenCalledExactlyOnceWith({
          disposition: ending === "explicit-abort" || ending === "client-stop" ? "abort" : "detach",
        });
        expect(abortController.signal.aborted).toBe(
          ending === "explicit-abort" || ending === "client-stop",
        );
        expect(relaySessions.has(session.relaySessionId)).toBe(false);
        expect(() =>
          resolveTalkVoiceSession({
            kind: "client",
            connId: "conn-1",
            voiceSessionId: session.relaySessionId,
          }),
        ).toThrow("No active voice call");
        await voiceChange.completion;
        await expect(voiceChange.changing).resolves.toMatchObject({
          status: "applied",
          voice: "ember",
        });
      } finally {
        await voiceChange.cleanup();
      }
    },
  );

  it.each([
    {
      name: "expires",
      aborts: true,
      close: (session: { relaySessionId: string }) => {
        const relay = relaySessions.get(session.relaySessionId);
        if (!relay) {
          throw new Error("expected active relay");
        }
        relay.expiresAtMs = Date.now() - 1;
        void transmitAudio(session, "AQI=");
      },
    },
    {
      name: "fails connection ownership",
      aborts: false,
      close: (session: { relaySessionId: string }) => {
        void sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId: "conn-other",
          audioBase64: "AQI=",
        });
      },
    },
  ])(
    "settles relay control without crossing ownership when the relay $name",
    async ({ close, aborts }) => {
      const fixture = await createAbortableRelayRunFixture();

      expect(() => close(fixture.session)).toThrow("Unknown realtime relay session");

      expect(fixture.abortController.signal.aborted).toBe(aborts);
      if (aborts) {
        expectChatAbortPayload(fixture.broadcast, "relay-closed");
        expectNodeAbortPayload(fixture.nodeSendToSession);
      } else {
        expect(fixture.broadcast).not.toHaveBeenCalled();
        expect(fixture.nodeSendToSession).not.toHaveBeenCalled();
        expect(relaySessions.has(fixture.session.relaySessionId)).toBe(true);
        expect(() => transmitAudio(fixture.session, "AQI=")).not.toThrow();
        expect(fixture.abortController.signal.aborted).toBe(false);
      }
    },
  );

  it("fails closed when retained relay tool-call identities reach their hard cap", async () => {
    const close = vi.fn();
    const submitToolResult = vi.fn();
    const captured = captureProvider(() =>
      makeRelayTransport({
        submitToolResult,
        close,
      }),
    );
    const { provider } = captured;
    const broadcastToConnIds = vi.fn();
    const session = await createTalkRealtimeRelaySession({
      context: { broadcastToConnIds } as never,
      provider,
    });
    const retainedSession = relaySessions.get(session.relaySessionId);
    expect(retainedSession).toBeDefined();
    ensureActiveRelayTurnId(session.relaySessionId);
    const toolCallEventCount = () => mockEventPayloads(broadcastToConnIds, "toolCall").length;

    for (let index = 0; index < MAX_RELAY_TOOL_CALL_IDENTITIES; index += 1) {
      captured.request?.onToolCall?.({
        itemId: `item-${index}`,
        callId: `call-${index}`,
        name: "lookup",
        args: {},
      });
    }

    expect(retainedSession?.toolCalls.size).toBe(MAX_RELAY_TOOL_CALL_IDENTITIES);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(toolCallEventCount()).toBe(MAX_RELAY_TOOL_CALL_IDENTITIES);

    captured.request?.onToolCall?.({
      itemId: "item-overflow",
      callId: "call-overflow",
      name: "lookup",
      args: {},
    });

    expect(close).toHaveBeenCalledOnce();
    expect(relaySessions.has(session.relaySessionId)).toBe(false);
    expect(retainedSession?.toolCalls.has("call-overflow")).toBe(false);
    expect(toolCallEventCount()).toBe(MAX_RELAY_TOOL_CALL_IDENTITIES);
    expect(submitToolResult).not.toHaveBeenCalled();
    expect(mockEventPayloads(broadcastToConnIds, "error")).toHaveLength(1);
    expect(mockEventPayloads(broadcastToConnIds, "close")).toHaveLength(1);

    captured.request?.onToolCall?.({
      itemId: "item-late",
      callId: "call-late",
      name: "lookup",
      args: {},
    });
    expect(close).toHaveBeenCalledOnce();
    expect(retainedSession?.toolCalls.size).toBe(MAX_RELAY_TOOL_CALL_IDENTITIES);
    expect(retainedSession?.toolCalls.has("call-late")).toBe(false);
    expect(toolCallEventCount()).toBe(MAX_RELAY_TOOL_CALL_IDENTITIES);
    expect(submitToolResult).not.toHaveBeenCalled();
  });

  it("does not emit continuity events after tool-call overflow closes the relay", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const captured = captureProvider(() =>
      makeRelayTransport({
        close,
      }),
    );
    const { provider } = captured;
    const broadcastToConnIds = vi.fn();
    const session = await createTalkRealtimeRelaySession({
      context: { broadcastToConnIds } as never,
      provider,
      forceAgentConsultOnFinalTranscript: true,
    });
    const retainedSession = relaySessions.get(session.relaySessionId);
    expect(
      retainedSession?.toolCalls.tryAdmit(
        Array.from({ length: MAX_RELAY_TOOL_CALL_IDENTITIES }, (_, index) => `call-${index}`),
      ),
    ).toBe(true);
    captured.request?.onTranscript?.("user", "check this", true);

    captured.request?.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });

    const terminalTypes = broadcastToConnIds.mock.calls
      .map(([, payload]) =>
        typeof payload === "object" && payload !== null
          ? (payload as { type?: string }).type
          : undefined,
      )
      .filter((type) => type === "error" || type === "close" || type === "clear");
    expect(terminalTypes).toEqual(["error", "close"]);
    expect(close).toHaveBeenCalledOnce();
    expect(relaySessions.has(session.relaySessionId)).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
