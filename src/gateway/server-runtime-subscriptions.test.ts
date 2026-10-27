import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { configureExecutionIdentityAdmissionSink } from "../audit/execution-identity-admission.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type AgentEventPayload,
  emitAgentEvent,
  emitAgentEventForOwner,
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  getAgentRunContextOwnerStatus as ownerStatus,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { createGatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import { heartbeatNotifications } from "../infra/heartbeat-events.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  PROGRESS_CARD_REFRESH_SOURCE_TOOL,
  progressCardRefreshRunProjection,
} from "../sessions/input-provenance.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { getRpcSourceIdentity } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  waitForChatAbortControllerRemoval,
  waitForChatAbortTerminalPersistence,
} from "./chat-abort-lifecycle-internal.js";
import { abortChatRunById } from "./chat-abort.js";
import { createGatewayServerActiveWorkInspectors } from "./server-active-work.js";
import type { AgentEventHandlerOptions } from "./server-chat.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { fixedStoreOwnershipConfig } from "./server-methods/sessions-fixed-store.test-support.js";
import * as eventDispatch from "./server-runtime-event-dispatch.js";
import {
  registerActivitySummaryPublicationTests,
  registerActivitySummaryRunTests,
} from "./server-runtime-subscriptions.activity-summary.test-support.js";
import { registerSessionPublicationTests } from "./server-runtime-subscriptions.publication.test-support.js";
import {
  createSubscriptionTestFixture,
  lifecycleState,
  readLifecycleState,
  registerSubscriptionChatRun,
  registerSubscriptionRegistrationTests,
  registerAuditSubscriptionTests,
  registerAssistantTailSubscriptionTests,
  waitForFast,
} from "./server-runtime-subscriptions.test-support.js";
import { registerTranscriptScopePublicationTests } from "./server-runtime-subscriptions.transcript-scope.test-support.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { createRpcSourceForTest, claimRpcSourceForTest } from "./test-helpers.rpc-source.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const { warn, createParams } = createSubscriptionTestFixture();

const auditTestState = vi.hoisted(() => ({
  created: 0,
  recorded: 0,
  messages: 0,
  identityRecorded: 0,
  decisionRecorded: 0,
  stopped: 0,
}));
const agentEventHandlerMocks = vi.hoisted(() => ({
  create: vi.fn(),
  persistLifecycle: vi.fn<
    typeof import("./session-lifecycle-state.js").persistGatewaySessionLifecycleEvent
  >(async () => {}),
  resolveSession: vi.fn(() => ({ sessionKey: "agent:main:main", agentId: "main" })),
}));
const transcriptBroadcastMocks = vi.hoisted(() => ({
  useActualHandler: false,
  readMessageById:
    vi.fn<typeof import("./session-transcript-readers.js").readSessionMessageByIdAsync>(),
}));
const runtimeConfigState = vi.hoisted(() => ({ value: {} as OpenClawConfig }));
const observeActivitySummary = vi.hoisted(() =>
  vi.fn<
    (
      options: Parameters<
        typeof import("./session-activity-summaries.js").createSessionActivitySummaries
      >[0],
    ) => void
  >(),
);

vi.mock("./session-activity-summaries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-activity-summaries.js")>();
  return {
    ...actual,
    createSessionActivitySummaries: (
      options: Parameters<typeof actual.createSessionActivitySummaries>[0],
    ) => {
      observeActivitySummary(options);
      return actual.createSessionActivitySummaries(options);
    },
  };
});

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => runtimeConfigState.value,
}));

vi.mock("../audit/audit-recorder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/audit-recorder.js")>();
  return {
    ...actual,
    createAuditEventRecorder: (options: Parameters<typeof actual.createAuditEventRecorder>[0]) => {
      auditTestState.created += 1;
      return actual.createAuditEventRecorder({
        ...options,
        writer: {
          ready: Promise.resolve(),
          record: (event) => {
            auditTestState[event.kind === "message" ? "messages" : "recorded"] += 1;
            return true;
          },
          recordRun: () => {
            auditTestState.recorded += 2;
            return true;
          },
          recordExecutionIdentity: () => {
            auditTestState.identityRecorded += 1;
            return true;
          },
          recordExecutionDecision: () => {
            auditTestState.decisionRecorded += 1;
            return true;
          },
          recordExecutionDecisionWork: () => true,
          stop: async () => {
            auditTestState.stopped += 1;
          },
        },
      });
    },
  };
});

vi.mock("./server-chat.js", () => ({
  createAgentEventHandler: (...args: unknown[]) => agentEventHandlerMocks.create(...args),
}));

// mock-isolation: Subscription custody tests control persistence without a database.
vi.mock("./session-lifecycle-state.js", () => ({
  persistGatewaySessionLifecycleEvent: agentEventHandlerMocks.persistLifecycle,
  prepareGatewaySessionLifecycleEvent:
    (
      params: Parameters<
        typeof import("./session-lifecycle-state.js").persistGatewaySessionLifecycleEvent
      >[0],
    ) =>
    () =>
      agentEventHandlerMocks.persistLifecycle(params),
}));

vi.mock("./server-session-key.js", () => ({
  resolveSessionForRun: agentEventHandlerMocks.resolveSession,
}));

vi.mock("./session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-transcript-readers.js")>();
  return {
    ...actual,
    readSessionMessageByIdAsync: transcriptBroadcastMocks.readMessageById,
  };
});

vi.mock("./server-session-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-session-events.js")>();
  return {
    ...actual,
    createTranscriptUpdateBroadcastHandler: (
      ...args: Parameters<typeof actual.createTranscriptUpdateBroadcastHandler>
    ) => {
      if (transcriptBroadcastMocks.useActualHandler) {
        return actual.createTranscriptUpdateBroadcastHandler(...args);
      }
      return () => {
        throw new Error("transcript handler failure");
      };
    },
  };
});

const { startGatewayEventSubscriptions } = await import("./server-runtime-subscriptions.js");

type LifecycleTransition = { state: string; lifecycle?: ReturnType<typeof readLifecycleState> };

describe("startGatewayEventSubscriptions", () => {
  let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    auditTestState.created = 0;
    auditTestState.recorded = 0;
    auditTestState.messages = 0;
    auditTestState.identityRecorded = 0;
    auditTestState.decisionRecorded = 0;
    auditTestState.stopped = 0;
    transcriptBroadcastMocks.useActualHandler = false;
    transcriptBroadcastMocks.readMessageById.mockReset();
    runtimeConfigState.value = {};
    agentEventHandlerMocks.persistLifecycle.mockReset().mockResolvedValue(undefined);
    agentEventHandlerMocks.resolveSession.mockClear();
    agentEventHandlerMocks.create.mockReset().mockImplementation(() => {
      throw new Error("server-chat lazy load failure");
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await unsubs?.agentUnsub();
    heartbeatNotifications.onEvent = () => {};
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    resetAgentEventsForTest();
    configureExecutionIdentityAdmissionSink(() => false)();
  });

  it.each(["before startup", "during close"] as const)(
    "stops observer events %s while chat events continue draining",
    async (phase) => {
      using dispatch = vi.spyOn(eventDispatch, "dispatchEventHandler");
      const connectionWork = new GatewayConnectionWork();
      const handler = Object.assign(vi.fn(), { dispose: vi.fn() });
      agentEventHandlerMocks.create.mockReturnValue(handler);
      if (phase === "before startup") {
        connectionWork.beginClose();
      }
      unsubs = startGatewayEventSubscriptions({
        ...createParams(),
        signal: connectionWork.signal,
      });
      const observe = vi.spyOn(unsubs.sessionObserver, "handleEventAsync");
      const emit = () =>
        emitAgentEvent({ runId: "closing-observer", stream: "assistant", data: { text: "late" } });
      if (phase === "during close") {
        emit();
        connectionWork.beginClose();
      }
      for (let index = 0; index < 9; index++) {
        emit();
      }
      await unsubs.agentUnsub();

      expect(warn).not.toHaveBeenCalled();
      expect(observe).toHaveBeenCalledTimes(phase === "during close" ? 1 : 0);
      expect(handler).toHaveBeenCalledTimes(phase === "during close" ? 10 : 9);
      const deliveries = dispatch.mock.calls.filter(
        ([params]) => params.failureMessage === "Agent event dispatch failed",
      );
      expect({
        deliveryGuards: new Set(deliveries.map(([params]) => params.isDeliveryCurrent)).size,
        terminalFailureHandlers: deliveries.filter(([params]) => params.onFailure !== undefined)
          .length,
      }).toEqual({ deliveryGuards: 1, terminalFailureHandlers: 0 });
      emit();
      expect(handler).toHaveBeenCalledTimes(phase === "during close" ? 10 : 9);
      observe.mockRestore();
    },
  );

  it.each(["same-id reset", "missing row", "missing row without ID", "missing projection"])(
    "does not attach a successor row after a queued %s",
    async (change) => {
      const prepared = createDeferred();
      const original = { sessionId: "original" };
      let current: typeof original | undefined = change.startsWith("missing row")
        ? undefined
        : original;
      let admitted = change !== "missing projection";
      const projection = {
        capture: () => current,
        ensureMaterialized: () => prepared.promise,
        withPreparedExactRows: async (_queries: unknown, consume: (read: unknown) => unknown) => {
          await prepared.promise;
          return consume(undefined);
        },
        isCurrent: (record: typeof original) => record === current,
        snapshot: () => ({ row: current ? { key: "agent:main:queued", ...current } : null }),
      } as unknown as SessionRowProjection;
      const delivered = vi.fn();
      agentEventHandlerMocks.create.mockImplementation((options: AgentEventHandlerOptions) =>
        Object.assign(
          (event: AgentEventPayload) => {
            delivered(
              options.loadGatewaySessionLifecycleSnapshotForEvent?.("agent:main:queued", {
                agentId: "main",
                ownerEvent: event,
              }).row,
            );
          },
          { dispose: vi.fn() },
        ),
      );
      unsubs = startGatewayEventSubscriptions({
        ...createParams(),
        getSessionRowProjection: () => (admitted ? projection : undefined),
      });
      emitAgentEvent({
        runId: "queued-owner",
        agentId: "main",
        sessionKey: "agent:main:queued",
        sessionId: change === "missing row without ID" ? undefined : "original",
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1 },
      });
      current = { sessionId: "original" };
      admitted = true;
      prepared.resolve();
      await waitForFast(() => expect(delivered).toHaveBeenCalledWith(null));
    },
  );

  it("delivers tool progress without enriching a cold optional session row", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const query = { agentId: "main", key: "agent:main:tool-progress" };
      replaceSessionEntrySync(
        { agentId: query.agentId, sessionKey: query.key },
        { sessionId: "tool-progress", updatedAt: 1, label: "Progress session" },
      );
      const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      const delivered = vi.fn();
      agentEventHandlerMocks.create.mockImplementation((options: AgentEventHandlerOptions) =>
        Object.assign(
          () => delivered(options.loadGatewaySessionLifecycleSnapshotForEvent?.(query.key)),
          { dispose: vi.fn() },
        ),
      );
      unsubs = startGatewayEventSubscriptions({
        ...createParams(),
        getSessionRowProjection: () => projection,
      });
      const emit = () =>
        emitAgentEvent({
          runId: "cold-tool-progress",
          stream: "tool",
          data: { phase: "update" },
        });
      try {
        await projection.ensureMaterialized();
        expect(projection.needsMaterialization).toBe(false);
        const materialized = projection.materializedCount;
        emit();
        await waitForFast(() => expect(delivered).toHaveBeenCalledTimes(1));
        expect(delivered).toHaveBeenLastCalledWith({ row: null });
        expect(projection.materializedCount).toBe(materialized);

        await projection.withPreparedExactRows(
          () => [query],
          () => undefined,
        );
        emit();
        await waitForFast(() => expect(delivered).toHaveBeenCalledTimes(2));
        expect(delivered).toHaveBeenLastCalledWith(
          expect.objectContaining({ row: expect.objectContaining({ sessionId: "tool-progress" }) }),
        );
      } finally {
        await unsubs.agentUnsub();
        heartbeatNotifications.onEvent = () => {};
        unsubs.transcriptUnsub();
        unsubs.lifecycleUnsub();
        unsubs = undefined;
        projection.dispose();
      }
    });
  });

  registerActivitySummaryPublicationTests(
    (projection, signal) => {
      const params = createParams();
      unsubs = startGatewayEventSubscriptions({
        ...params,
        signal: signal ?? params.signal,
        getSessionRowProjection: () => projection,
      });
      return { params, unsubs };
    },
    () => observeActivitySummary.mock.calls[0]?.[0].onChanged,
  );

  it("broadcasts suspension immediately and stops with the gateway lifecycle", () => {
    resetGatewayWorkAdmission();
    const params = createParams();
    unsubs = startGatewayEventSubscriptions(params);
    try {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      suspension?.drain();
      suspension?.commit();
      suspension?.release();
      expect(vi.mocked(params.broadcast).mock.calls).toEqual([
        ["gateway.suspension", { phase: "preparing" }],
        ["gateway.suspension", { phase: "draining" }],
        ["gateway.suspension", { phase: "prepared" }],
        ["gateway.suspension", { phase: "accepting" }],
      ]);
      unsubs.lifecycleUnsub();
      vi.mocked(params.broadcast).mockClear();
      tryBeginGatewaySuspendAdmission(() => {})?.rollback();
      expect(params.broadcast).not.toHaveBeenCalled();
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  registerAuditSubscriptionTests({
    start: () => {
      unsubs = startGatewayEventSubscriptions(createParams());
      return unsubs;
    },
    runtimeConfigState,
    auditTestState,
    warn,
  });

  it("logs lazy agent event handler failures", async () => {
    const runId = "run-claimed-terminal";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const claimId = claimAgentRunContext(
      runId,
      {
        lifecycleGeneration,
        sessionId: "session-1",
      },
      { exclusive: true, ownsContext: true, trackOwner: true },
    );
    if (!claimId) {
      throw new Error("expected terminal event claim");
    }
    agentEventHandlerMocks.resolveSession.mockReturnValueOnce({
      sessionKey: "global",
      agentId: "research",
    });
    agentEventHandlerMocks.persistLifecycle.mockRejectedValue(new Error("terminal write rejected"));
    unsubs = startGatewayEventSubscriptions(createParams());

    emitAgentEventForOwner(
      {
        runId,
        sessionId: "session-1",
        stream: "lifecycle",
        data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
      },
      claimId,
    );

    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(agentEventHandlerMocks.persistLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "global",
        agentId: "research",
        assertCommitAllowed: expect.any(Function),
      }),
    );
    expect(agentEventHandlerMocks.resolveSession).toHaveBeenCalledWith(runId, {
      agentId: undefined,
      projection: undefined,
    });
    expect(warn).toHaveBeenCalledWith(
      "Agent event dispatch failed",
      expect.objectContaining({ runId, stream: "lifecycle" }),
    );
    expect(warn).toHaveBeenCalledWith(
      "Terminal session persistence failed",
      expect.objectContaining({ runId }),
    );
    expect(ownerStatus(runId, claimId, lifecycleGeneration)).toBe("clear-requested");
    releaseAgentRunContext(runId, claimId);
  });

  it.each(["agent store", "other physical store"])(
    "uses the persisted bare-key owner in the prepared %s",
    async (physicalStore) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        runtimeConfigState.value = fixedStoreOwnershipConfig(
          resolveSessionStorePathCore(undefined, { agentId: "ops" }),
        );
        const handler = Object.assign(vi.fn(), { dispose: vi.fn() });
        agentEventHandlerMocks.create.mockReturnValue(handler);
        const params = createParams();
        const projection = await createSessionRowProjection({
          cfg: runtimeConfigState.value,
          modelCatalog: [],
          placementFactsReader: createWorkerSessionPlacementStore(),
        });
        const source = createRpcSourceForTest(
          {},
          {
            sessionKey: "global",
            sessionId: "session-ops",
            storeScope:
              physicalStore === "agent store"
                ? projection.state.scope({ agentId: "ops" }).path
                : "/synthetic/subscription/other-store/sessions",
          },
        );
        const release = await claimRpcSourceForTest(source);
        rpcSourceTesting.set("run-ops", source);
        unsubs = startGatewayEventSubscriptions({
          ...params,
          getSessionRowProjection: () => projection,
        });
        try {
          emitAgentEvent({ runId: "load-handler", stream: "lifecycle", data: { phase: "error" } });
          await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());
          const options = agentEventHandlerMocks.create.mock.calls[0]?.[0] as {
            resolveSessionActiveRunState?: (session: {
              requestedKey: string;
              canonicalKey: string;
              storePath?: string;
              sessionId?: string;
              agentId?: string;
            }) => { active: boolean; runIds: string[] };
          };

          expect(
            options.resolveSessionActiveRunState?.({
              requestedKey: "global",
              canonicalKey: "global",
              storePath: source.input.target?.storeScope,
              sessionId: "session-ops",
              agentId: "ops",
            }),
          ).toEqual({ active: true, runIds: ["run-ops"] });
          await unsubs.agentUnsub();
          expect(handler.dispose).toHaveBeenCalledOnce();
        } finally {
          release();
          projection.dispose();
        }
      });
    },
  );

  registerSubscriptionRegistrationTests(
    (params) => {
      unsubs = startGatewayEventSubscriptions(params);
      return unsubs;
    },
    (terminal) => {
      agentEventHandlerMocks.persistLifecycle.mockReturnValue(terminal);
      agentEventHandlerMocks.create.mockReturnValue(
        Object.assign(async () => {}, { dispose() {} }),
      );
    },
  );

  it("drives a registered chat run through the terminal persistence transition table", async () => {
    const runId = "run-lifecycle-table";
    const sessionKey = "agent:main:main";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const params = createParams();
    const registration = registerSubscriptionChatRun(params, {
      runId,
      sessionId: "session-lifecycle-table",
      sessionKey,
      lifecycleGeneration,
    });
    const entry = registration.entry;
    const emit = (data: AgentEventPayload["data"]) =>
      emitAgentEvent({ runId, lifecycleGeneration, stream: "lifecycle", data });
    const transitions: LifecycleTransition[] = [
      { state: "Registered", lifecycle: readLifecycleState(entry) },
    ];
    agentEventHandlerMocks.create.mockReturnValue(Object.assign(vi.fn(), { dispose: vi.fn() }));
    unsubs = startGatewayEventSubscriptions(params);

    emit({ phase: "start", startedAt: 1_000 });
    transitions.push({ state: "Start-normalized", lifecycle: readLifecycleState(entry) });
    await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());

    emit({ phase: "error", error: "retryable provider failure", endedAt: 2_000 });
    emit({ phase: "start", startedAt: 2_500 });
    expect(agentEventHandlerMocks.persistLifecycle).not.toHaveBeenCalled();

    const terminalPersistence = createDeferred();
    agentEventHandlerMocks.persistLifecycle.mockReturnValue(terminalPersistence.promise);

    emit({ phase: "end", endedAt: 3_000 });
    const ownedPersistence = entry.adapter.projectSessionTerminalPersistence;
    transitions.push({ state: "Persisting", lifecycle: readLifecycleState(entry) });

    try {
      expect(ownedPersistence).toBeInstanceOf(Promise);
      terminalPersistence.resolve();
      await waitForChatAbortTerminalPersistence(entry);
      expect(entry.adapter.projectSessionTerminalPersisted).toBe(true);
    } finally {
      terminalPersistence.resolve();
      await waitForChatAbortTerminalPersistence(entry);
    }
    transitions.push({ state: "Persisted", lifecycle: readLifecycleState(entry) });

    registration.cleanup();
    transitions.push({ state: "Removed" });
    expect(rpcSourceTesting.has(runId)).toBe(false);
    expect(transitions).toEqual([
      { state: "Registered", lifecycle: lifecycleState(undefined) },
      { state: "Start-normalized", lifecycle: lifecycleState(undefined, false) },
      {
        state: "Persisting",
        lifecycle: lifecycleState(false, true, 3_000, ownedPersistence, false),
      },
      { state: "Persisted", lifecycle: lifecycleState(false, false, 3_000, undefined, true) },
      { state: "Removed" },
    ]);
  });

  it.each(
    ["removed", "replacement", "retired replacement", "newer write"].flatMap((change) =>
      [true, false].map((persisted) => ({ change, persisted })),
    ),
  )(
    "settles captured terminal ownership after $change (persisted=$persisted)",
    async ({ change, persisted }) => {
      const params = createParams();
      const runId = `captured-terminal-${change.replaceAll(" ", "-")}-${persisted}`;
      const sessionKey = "agent:main:captured-terminal";
      const target = captureSessionTarget({
        storeScope: `/synthetic/subscription/${runId}/sessions`,
        sessionKey,
        incarnation: "captured-session",
      });
      const register = () =>
        registerSubscriptionChatRun(params, {
          runId,
          sessionId: "captured-session",
          sessionKey,
          target,
        }).entry;
      const entry = register();
      const terminal = createDeferred();
      const successor = createDeferred();
      const firstDispatchEntered = createDeferred();
      const firstDispatch = createDeferred();
      const successorDispatchEntered = createDeferred();
      const failure = new Error("captured terminal write failed");
      const successorDispatchFailure = new Error("successor terminal dispatch failed");
      agentEventHandlerMocks.persistLifecycle
        .mockReturnValueOnce(terminal.promise)
        .mockReturnValueOnce(successor.promise);
      agentEventHandlerMocks.create.mockReturnValue(
        Object.assign(
          async (event: AgentEventPayload) => {
            if (event.data.endedAt === 2_000) {
              firstDispatchEntered.resolve();
              await firstDispatch.promise;
            } else {
              successorDispatchEntered.resolve();
              throw successorDispatchFailure;
            }
          },
          { dispose: vi.fn() },
        ),
      );
      unsubs = startGatewayEventSubscriptions(params);
      const emitTerminal = (endedAt: number) =>
        emitAgentEvent({
          runId,
          sessionKey,
          sessionId: getRpcSourceIdentity(entry).sessionId,
          stream: "lifecycle",
          data: { phase: "end", endedAt },
        });
      let firstSettled = false;
      let firstDrain: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      try {
        emitTerminal(2_000);
        expect(entry.adapter.projectSessionTerminalPending).toBe(true);
        expect(entry.adapter.projectSessionTerminalPersisted).toBe(false);
        expect(entry.adapter.projectSessionTerminalPersistence).toBeInstanceOf(Promise);
        firstDrain = waitForChatAbortTerminalPersistence(entry).then(
          () => {
            firstSettled = true;
            return { ok: true as const };
          },
          (error: unknown) => {
            firstSettled = true;
            return { ok: false as const, error };
          },
        );
        await awaitGateBeforeSettlement(
          firstDispatchEntered.promise,
          firstDrain,
          "Terminal ownership settled before its held dispatch was released",
        );
        expect(firstSettled).toBe(false);
        const recovery = {
          storePath: expectDefined(entry.input.target, "Expected captured fixture target")
            .storeScope,
          agentId: getRpcSourceIdentity(entry).agentId,
          runId,
          sessionKey,
          sessionId: getRpcSourceIdentity(entry).sessionId,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          observedAt: 2_000,
        };
        params.restartRecoveryCandidates.set(runId, recovery);
        let current = entry;
        if (change !== "newer write") {
          expect(rpcSourceTesting.deleteExpected(runId, entry)).toBe(true);
        }
        if (change.includes("replacement")) {
          current = register();
        }
        if (change !== "removed") {
          emitTerminal(3_000);
          params.restartRecoveryCandidates.set(runId, { ...recovery, observedAt: 3_000 });
        }
        if (change === "retired replacement") {
          expect(rpcSourceTesting.deleteExpected(runId, current)).toBe(true);
        }
        const currentState = readLifecycleState(current);
        if (change !== "removed") {
          await successorDispatchEntered.promise;
        }
        if (persisted) {
          terminal.resolve();
        } else {
          terminal.reject(failure);
        }
        await terminal.promise.catch(() => {});
        firstDispatch.resolve();
        expect(await firstDrain).toEqual(persisted ? { ok: true } : { ok: false, error: failure });
        if (change === "newer write") {
          expect(readLifecycleState(entry)).toEqual(currentState);
        } else {
          expect(entry.adapter.projectSessionTerminalPending).toBe(false);
          expect(entry.adapter.projectSessionTerminalPersistence).toBeUndefined();
          expect(entry.adapter.projectSessionTerminalPersisted).toBe(persisted);
          expect(
            await waitForChatAbortControllerRemoval({
              targets: [{ runId, entry }],
              timeoutMs: 1_000,
            }),
          ).toBe(persisted);
          if (!persisted) {
            await expect(waitForChatAbortTerminalPersistence(entry)).rejects.toBe(failure);
          }
        }
        if (change === "removed") {
          expect(params.restartRecoveryCandidates.get(runId)).toEqual(recovery);
        } else {
          expect(rpcSourceTesting.get(runId)).toBe(
            change === "retired replacement" ? undefined : current,
          );
          expect(readLifecycleState(current)).toEqual(currentState);
          expect(params.restartRecoveryCandidates.get(runId)?.observedAt).toBe(3_000);
        }
        if (change === "newer write") {
          successor.resolve();
          await successor.promise;
          // Finishing the earlier receipt must not erase its accepted successor.
          await expect(waitForChatAbortTerminalPersistence(entry)).rejects.toBe(
            successorDispatchFailure,
          );
        }
      } finally {
        firstDispatch.resolve();
        terminal.resolve();
        successor.resolve();
        await Promise.allSettled([firstDrain, terminal.promise, successor.promise]);
      }
    },
  );

  it.each(["start", "end"] as const)(
    "generation-fences a current lifecycle %s event from a retired registration",
    async (phase) => {
      const runId = `run-retired-${phase}`;
      const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
      const params = createParams();
      const registration = registerSubscriptionChatRun(params, {
        runId,
        sessionId: `session-retired-${phase}`,
        sessionKey: "agent:main:main",
        lifecycleGeneration: `${currentLifecycleGeneration}-retired`,
      });
      const registered = readLifecycleState(registration.entry);
      agentEventHandlerMocks.create.mockReturnValue(
        Object.assign(
          () => {
            throw new Error("different generation dispatch failed");
          },
          { dispose: vi.fn() },
        ),
      );
      unsubs = startGatewayEventSubscriptions(params);

      emitAgentEvent({
        runId,
        lifecycleGeneration: currentLifecycleGeneration,
        stream: "lifecycle",
        data: phase === "start" ? { phase, startedAt: 1_000 } : { phase, endedAt: 1_000 },
      });

      expect(readLifecycleState(registration.entry)).toEqual(registered);
      await unsubs.agentUnsub();
      expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce();
      await expect(
        waitForChatAbortTerminalPersistence(registration.entry),
      ).resolves.toBeUndefined();
    },
  );

  it.each([
    { result: "visible persistence" },
    { result: "hidden no-write", hidden: true },
    { result: "hidden dispatch failure", hidden: true, dispatchFails: true },
    {
      result: "visible no-write dispatch failure",
      projectSessionLifecycle: false,
      dispatchFails: true,
    },
    { result: "dispatch failure with an accepted write", dispatchFails: true },
    {
      result: "dispatch and persistence failures",
      dispatchFails: true,
      persistenceFails: true,
    },
  ])(
    "joins accepted terminal dispatch before settling $result",
    async ({
      hidden = false,
      projectSessionLifecycle,
      dispatchFails = false,
      persistenceFails = false,
    }) => {
      const actual = await vi.importActual<typeof import("./server-chat.js")>("./server-chat.js");
      const runId = "run-abort-persistence-bridge";
      const sessionKey = "agent:main:main";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const params = createParams();
      const inspectors = createGatewayServerActiveWorkInspectors({
        resolveGatewayContext: undefined,
        cron: {},
      });
      const registration = registerSubscriptionChatRun(params, {
        runId,
        sessionId: "session-abort-persistence-bridge",
        sessionKey,
        lifecycleGeneration,
        ...(hidden ? { controlUiVisible: false, projectSessionActive: false } : {}),
      });
      const entry = registration.entry;
      const releaseEntry = await claimRpcSourceForTest(entry);
      const identity = getRpcSourceIdentity(entry);
      claimAgentRunContext(runId, {
        lifecycleGeneration,
        sessionId: identity.sessionId,
        sessionKey,
        ...(projectSessionLifecycle === false ? { projectSessionLifecycle: false } : {}),
        ...(hidden
          ? progressCardRefreshRunProjection({
              kind: "internal_system",
              sourceTool: PROGRESS_CARD_REFRESH_SOURCE_TOOL,
            })
          : {}),
      });
      const dispatchEntered = createDeferred();
      const releaseDispatch = createDeferred();
      const dispatchFinished = createDeferred();
      const terminalPersistence = createDeferred();
      const dispatchFailure = new Error("accepted terminal dispatch failed");
      const persistenceFailure = new Error("accepted terminal write failed");
      agentEventHandlerMocks.persistLifecycle.mockReturnValue(terminalPersistence.promise);
      agentEventHandlerMocks.create.mockImplementation((options: AgentEventHandlerOptions) => {
        const handler = actual.createAgentEventHandler(options);
        return Object.assign(
          async (event: AgentEventPayload) => {
            dispatchEntered.resolve();
            try {
              await releaseDispatch.promise;
              if (dispatchFails) {
                throw dispatchFailure;
              }
              await handler(event);
            } finally {
              dispatchFinished.resolve();
            }
          },
          { dispose: () => handler.dispose() },
        );
      });
      unsubs = startGatewayEventSubscriptions(params);
      expect(
        abortChatRunById(
          {
            ...params,
            removeChatRun: (sessionId, clientRunId, key) =>
              params.chatRunState.registry.remove(sessionId, clientRunId, key),
          },
          { runId, sessionKey, stopReason: "user" },
        ),
      ).toEqual({ aborted: true });
      let settled = false;
      const waiter = waitForChatAbortTerminalPersistence(entry).then(
        () => {
          settled = true;
          return { ok: true as const };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false as const, error };
        },
      );
      try {
        await dispatchEntered.promise;
        releaseEntry();
        expect(settled).toBe(false);
        expect(entry.input.phase).not.toBe("consumed");
        expect(rpcSourceTesting.get(runId)).toBe(entry);
        expect(entry.adapter.projectSessionTerminalPending).toBe(true);
        expect(createGatewayActiveWorkSnapshot(inspectors).counts.terminalPersistence).toBe(
          hidden ? 0 : 1,
        );
        if (hidden || projectSessionLifecycle === false) {
          expect(entry.adapter.projectSessionTerminalPersistence).toBeUndefined();
        } else {
          expect(entry.adapter.projectSessionTerminalPersistence).toBeInstanceOf(Promise);
        }
        releaseDispatch.resolve();
        await dispatchFinished.promise;
        if (!hidden && projectSessionLifecycle !== false) {
          expect(settled).toBe(false);
          expect(rpcSourceTesting.get(runId)).toBe(entry);
          if (persistenceFails) {
            terminalPersistence.reject(persistenceFailure);
          } else {
            terminalPersistence.resolve();
          }
        }
        const outcome = await waiter;
        const failure = persistenceFails
          ? persistenceFailure
          : dispatchFails
            ? dispatchFailure
            : undefined;
        expect(outcome).toEqual(failure ? { ok: false, error: failure } : { ok: true });
        if (hidden) {
          expect(agentEventHandlerMocks.persistLifecycle).not.toHaveBeenCalled();
          expect(params.broadcast).not.toHaveBeenCalled();
          expect(params.broadcastToConnIds).not.toHaveBeenCalled();
          expect(params.nodeSendToSession).not.toHaveBeenCalled();
        }
        if (dispatchFails) {
          expect(warn).toHaveBeenCalledWith(
            "Agent event dispatch failed",
            expect.objectContaining({ error: dispatchFailure }),
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
        expect(entry.adapter.projectSessionTerminalPending).toBe(false);
        releaseEntry();
        expect(await Promise.allSettled([entry.input.settlement.promise])).toEqual([
          persistenceFails
            ? { status: "rejected", reason: persistenceFailure }
            : { status: "fulfilled", value: undefined },
        ]);
        expect(rpcSourceTesting.has(runId)).toBe(false);
        expect(createGatewayActiveWorkSnapshot(inspectors).blockers).toEqual([]);
      } finally {
        releaseDispatch.resolve();
        terminalPersistence.resolve();
        await waiter;
        releaseEntry();
        rpcSourceTesting.deleteExpected(runId, entry);
      }
    },
  );

  const publicationFixture: Parameters<typeof registerSessionPublicationTests>[0] & {
    runtimeConfigState: typeof runtimeConfigState;
  } = {
    createParams,
    installHandlerFactory: (factory) => agentEventHandlerMocks.create.mockImplementation(factory),
    start: (params) => {
      unsubs = startGatewayEventSubscriptions(params);
      return unsubs;
    },
    transcriptBroadcastMocks,
    runtimeConfigState,
    warn,
  };
  registerActivitySummaryRunTests(publicationFixture);
  registerSessionPublicationTests(publicationFixture);
  registerTranscriptScopePublicationTests(publicationFixture);

  registerAssistantTailSubscriptionTests({
    createParams,
    installHandlerFactory: (factory) => agentEventHandlerMocks.create.mockImplementation(factory),
    start: (params) => {
      // These cases exercise a successful no-subscriber handoff, not the injected failure handler.
      transcriptBroadcastMocks.useActualHandler = true;
      unsubs = startGatewayEventSubscriptions(params);
    },
  });

  it("broadcasts progress-card retirement without session-list subscribers", () => {
    const params = createParams();
    unsubs = startGatewayEventSubscriptions(params);
    emitSessionLifecycleEvent({
      sessionKey: "global",
      agentId: "work",
      reason: "progress-card-reset",
    });
    expect(params.broadcast).toHaveBeenCalledWith(
      "progressCard.changed",
      { sessionKey: "agent:work:global", revision: null },
      { sessionKeys: ["global"], agentId: "work" },
    );
  });
});
