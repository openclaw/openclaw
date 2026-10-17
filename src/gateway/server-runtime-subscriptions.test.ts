import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { configureExecutionIdentityAdmissionSink } from "../audit/execution-identity-admission.js";
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
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  PROGRESS_CARD_REFRESH_SOURCE_TOOL,
  progressCardRefreshRunProjection,
} from "../sessions/input-provenance.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  waitForChatAbortControllerRemoval,
  waitForChatAbortTerminalPersistence,
} from "./chat-abort-lifecycle-internal.js";
import { abortChatRunById, removeChatAbortControllerEntry } from "./chat-abort.js";
import { createGatewayServerActiveWorkInspectors } from "./server-active-work.js";
import type { AgentEventHandlerOptions } from "./server-chat.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { registerActivitySummaryPublicationTests } from "./server-runtime-subscriptions.activity-summary.test-support.js";
import { registerSessionPublicationTests } from "./server-runtime-subscriptions.publication.test-support.js";
import {
  createSubscriptionTestFixture,
  lifecycleState,
  readLifecycleState,
  registerSubscriptionChatRun,
  registerSubscriptionRegistrationTests,
  registerAuditSubscriptionTests,
  registerAssistantTailSubscriptionTests,
} from "./server-runtime-subscriptions.test-support.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

function waitForFast<T>(callback: () => T | Promise<T>) {
  return vi.waitFor(callback, { interval: 1 });
}

const { warn, createParams } = createSubscriptionTestFixture();

type PersistLifecycle =
  typeof import("./session-lifecycle-state.js").persistGatewaySessionLifecycleEvent;
type ActivitySummaryOptions = Parameters<
  typeof import("./session-activity-summaries.js").createSessionActivitySummaries
>[0];
type TerminalScenario = {
  hidden: boolean;
  projectSessionLifecycle?: boolean;
  dispatchFails: boolean;
  persistenceFails: boolean;
};

function terminalScenario(result: string, overrides: Partial<TerminalScenario> = {}) {
  return {
    result,
    hidden: false,
    dispatchFails: false,
    persistenceFails: false,
    projectSessionLifecycle: undefined,
    ...overrides,
  };
}

function disposableHandler(handler: (event: AgentEventPayload) => void = vi.fn()) {
  return Object.assign(handler, { dispose: vi.fn() });
}

function lifecycleEmitter(identity: Omit<AgentEventPayload, "stream" | "data" | "seq" | "ts">) {
  return (data: AgentEventPayload["data"]) =>
    emitAgentEvent({ ...identity, stream: "lifecycle", data });
}

type RunInput = Parameters<typeof registerSubscriptionChatRun>[1];
function registeredRun(runId: string, overrides: Partial<Omit<RunInput, "runId">> = {}) {
  const params = createParams();
  const identity = {
    runId,
    sessionId: `session-${runId}`,
    sessionKey: "agent:main:main",
    ...overrides,
  };
  const register = () => registerSubscriptionChatRun(params, identity);
  const registration = register();
  const { entry } = registration;
  return { params, ...identity, register, registration, entry };
}

function installHandler(handler?: (event: AgentEventPayload) => void) {
  const disposable = disposableHandler(handler);
  agentEventHandlerMocks.create.mockReturnValue(disposable);
  return disposable;
}

function observeSettlement(promise: Promise<void>) {
  const result = { settled: false };
  const outcome = promise.then(
    () => {
      result.settled = true;
      return { ok: true as const };
    },
    (error: unknown) => {
      result.settled = true;
      return { ok: false as const, error };
    },
  );
  return { result, outcome };
}

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
  persistLifecycle: vi.fn<PersistLifecycle>(async () => {}),
  resolveSession: vi.fn(() => ({ sessionKey: "agent:main:main", agentId: "main" })),
}));
const transcriptBroadcastMocks = vi.hoisted(() => ({
  useActualHandler: false,
  readMessageById:
    vi.fn<typeof import("./session-transcript-readers.js").readSessionMessageByIdAsync>(),
}));
const runtimeConfigState = vi.hoisted(() => ({ value: {} as OpenClawConfig }));
const observeActivitySummary = vi.hoisted(() => vi.fn<(options: ActivitySummaryOptions) => void>());

vi.mock("./session-activity-summaries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-activity-summaries.js")>();
  return {
    ...actual,
    createSessionActivitySummaries: (options: ActivitySummaryOptions) => {
      observeActivitySummary(options);
      return actual.createSessionActivitySummaries(options);
    },
  };
});

vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => runtimeConfigState.value }));

vi.mock("../audit/audit-recorder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/audit-recorder.js")>();
  return {
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
  prepareGatewaySessionLifecycleEvent: (params: Parameters<PersistLifecycle>[0]) => () =>
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

describe("startGatewayEventSubscriptions", () => {
  let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
  const start = (params = createParams()) => (unsubs = startGatewayEventSubscriptions(params));

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
    agentEventHandlerMocks.create.mockReset().mockImplementation(() => {
      throw new Error("server-chat lazy load failure");
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await unsubs?.agentUnsub();
    unsubs?.heartbeatUnsub();
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    resetAgentEventsForTest();
    configureExecutionIdentityAdmissionSink(() => false)();
  });

  it.each(["before startup", "during close"] as const)(
    "stops observer events %s while chat events continue draining",
    async (phase) => {
      const connectionWork = new GatewayConnectionWork();
      const handler = installHandler();
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
        disposableHandler((event) => {
          delivered(
            options.loadGatewaySessionLifecycleSnapshotForEvent?.("agent:main:queued", {
              agentId: "main",
              ownerEvent: event,
            }).row,
          );
        }),
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
        unsubs.heartbeatUnsub();
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
    start,
    runtimeConfigState,
    auditTestState,
    warn,
  });

  it("logs lazy agent event handler failures", async () => {
    const runId = "run-claimed-terminal";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const claimId = claimAgentRunContext(
      runId,
      { lifecycleGeneration, sessionId: "session-1" },
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

  it("uses the persisted bare-key owner for ownerless active-run projections", async () => {
    runtimeConfigState.value = {
      session: { scope: "global", store: "/tmp/openclaw-owned-sessions.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };
    const handler = installHandler();
    const params = createParams();
    params.chatAbortControllers.set("run-ops", {
      sessionKey: "global",
      sessionId: "session-ops",
    } as never);
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({ runId: "load-handler", stream: "lifecycle", data: { phase: "error" } });
    await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());
    const options: AgentEventHandlerOptions = agentEventHandlerMocks.create.mock.calls[0]?.[0];

    expect(
      options.resolveSessionActiveRunState?.({
        requestedKey: "global",
        canonicalKey: "global",
        sessionId: "session-ops",
        agentId: "ops",
      }),
    ).toEqual({ active: true, runIds: ["run-ops"] });
    await unsubs.agentUnsub();
    expect(handler.dispose).toHaveBeenCalledOnce();
  });

  registerSubscriptionRegistrationTests(start);

  it("normalizes retryable lifecycle failures before persisting the final terminal", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const { params, runId, registration, entry } = registeredRun("run-lifecycle-table", {
      lifecycleGeneration,
    });
    const emit = lifecycleEmitter({ runId, lifecycleGeneration });
    expect(readLifecycleState(entry)).toEqual(lifecycleState(true));
    installHandler();
    unsubs = startGatewayEventSubscriptions(params);

    emit({ phase: "start", startedAt: 1_000 });
    expect(readLifecycleState(entry)).toEqual(lifecycleState(true, false));
    await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());

    emit({ phase: "error", error: "retryable provider failure", endedAt: 2_000 });
    emit({ phase: "start", startedAt: 2_500 });
    expect(agentEventHandlerMocks.persistLifecycle).not.toHaveBeenCalled();
    emit({ phase: "end", endedAt: 3_000 });
    expect(readLifecycleState(entry)).toEqual(
      lifecycleState(false, true, 3_000, expect.any(Promise), false),
    );
    await waitForChatAbortTerminalPersistence(entry);
    expect(readLifecycleState(entry)).toEqual(lifecycleState(false, false, 3_000, undefined, true));
    registration.cleanup();
    expect(params.chatAbortControllers.has(runId)).toBe(false);
  });

  it.each(
    ["removed", "replacement", "retired replacement", "newer write"].flatMap((change) =>
      [true, false].map((persisted) => ({ change, persisted })),
    ),
  )(
    "settles captured terminal ownership after $change (persisted=$persisted)",
    async ({ change, persisted }) => {
      const { params, runId, sessionKey, register, entry } = registeredRun("captured-terminal", {
        sessionKey: "agent:main:captured-terminal",
      });
      const { chatAbortControllers: entries, restartRecoveryCandidates: candidates } = params;
      const remove = (target = entry) => {
        expect(removeChatAbortControllerEntry(entries, runId, target)).toBe(true);
      };
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
      installHandler(async (event) => {
        if (event.data.endedAt === 2_000) {
          firstDispatchEntered.resolve();
          await firstDispatch.promise;
        } else {
          successorDispatchEntered.resolve();
          throw successorDispatchFailure;
        }
      });
      unsubs = startGatewayEventSubscriptions(params);
      const emit = lifecycleEmitter({ runId, sessionKey, sessionId: entry.sessionId });
      let firstDrain: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      try {
        emit({ phase: "end", endedAt: 2_000 });
        expect(readLifecycleState(entry)).toEqual(
          lifecycleState(false, true, 2_000, expect.any(Promise), false),
        );
        const first = observeSettlement(waitForChatAbortTerminalPersistence(entry));
        firstDrain = first.outcome;
        await awaitGateBeforeSettlement(
          firstDispatchEntered.promise,
          firstDrain,
          "Terminal ownership settled before its held dispatch was released",
        );
        expect(first.result.settled).toBe(false);
        const recovery = {
          runId,
          sessionKey,
          sessionId: entry.sessionId,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          observedAt: 2_000,
        };
        candidates.set(runId, recovery);
        let current = entry;
        if (change !== "newer write") {
          remove();
        }
        if (change.includes("replacement")) {
          current = register().entry;
        }
        if (change !== "removed") {
          emit({ phase: "end", endedAt: 3_000 });
          candidates.set(runId, { ...recovery, observedAt: 3_000 });
        }
        if (change === "retired replacement") {
          remove(current);
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
          expect(readLifecycleState(entry)).toEqual(
            lifecycleState(false, false, 2_000, undefined, persisted),
          );
          expect(
            await waitForChatAbortControllerRemoval({
              entries,
              targets: [{ runId, entry }],
              timeoutMs: 1_000,
            }),
          ).toBe(persisted);
          if (!persisted) {
            await expect(waitForChatAbortTerminalPersistence(entry)).rejects.toBe(failure);
          }
        }
        if (change === "removed") {
          expect(candidates.get(runId)).toEqual(recovery);
        } else {
          expect(entries.get(runId)).toBe(change === "retired replacement" ? undefined : current);
          expect(readLifecycleState(current)).toEqual(currentState);
          expect(candidates.get(runId)?.observedAt).toBe(3_000);
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
      const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
      const { params, runId, entry } = registeredRun(`run-retired-${phase}`, {
        lifecycleGeneration: `${currentLifecycleGeneration}-retired`,
      });
      const registered = readLifecycleState(entry);
      installHandler(() => {
        throw new Error("different generation dispatch failed");
      });
      unsubs = startGatewayEventSubscriptions(params);

      emitAgentEvent({
        runId,
        lifecycleGeneration: currentLifecycleGeneration,
        stream: "lifecycle",
        data: phase === "start" ? { phase, startedAt: 1_000 } : { phase, endedAt: 1_000 },
      });

      expect(readLifecycleState(entry)).toEqual(registered);
      await unsubs.agentUnsub();
      expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce();
      await expect(waitForChatAbortTerminalPersistence(entry)).resolves.toBeUndefined();
    },
  );

  it.each([
    terminalScenario("visible persistence"),
    terminalScenario("hidden no-write", { hidden: true }),
    terminalScenario("hidden dispatch failure", { hidden: true, dispatchFails: true }),
    terminalScenario("visible no-write dispatch failure", {
      projectSessionLifecycle: false,
      dispatchFails: true,
    }),
    terminalScenario("dispatch failure with an accepted write", { dispatchFails: true }),
    terminalScenario("dispatch and persistence failures", {
      dispatchFails: true,
      persistenceFails: true,
    }),
  ])(
    "joins accepted terminal dispatch before settling $result",
    async ({ hidden, projectSessionLifecycle, dispatchFails, persistenceFails }) => {
      const actual = await vi.importActual<typeof import("./server-chat.js")>("./server-chat.js");
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const { params, runId, sessionKey, entry } = registeredRun("run-abort-persistence-bridge", {
        lifecycleGeneration,
        ...(hidden ? { controlUiVisible: false, projectSessionActive: false } : {}),
      });
      const inspectors = createGatewayServerActiveWorkInspectors({
        chatAbortControllers: params.chatAbortControllers,
        chatQueuedTurns: new Map(),
        cron: {},
      });
      claimAgentRunContext(runId, {
        lifecycleGeneration,
        sessionId: entry.sessionId,
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
      const { result, outcome: waiter } = observeSettlement(
        waitForChatAbortTerminalPersistence(entry),
      );
      try {
        await dispatchEntered.promise;
        expect(result.settled).toBe(false);
        expect(params.chatAbortControllers.get(runId)).toBe(entry);
        expect(entry.projectSessionTerminalPending).toBe(true);
        expect(createGatewayActiveWorkSnapshot(inspectors).counts.terminalPersistence).toBe(
          hidden ? 0 : 1,
        );
        expect(entry.projectSessionTerminalPersistence).toEqual(
          hidden || projectSessionLifecycle === false ? undefined : expect.any(Promise),
        );
        releaseDispatch.resolve();
        await dispatchFinished.promise;
        if (!hidden && projectSessionLifecycle !== false) {
          expect(result.settled).toBe(false);
          expect(params.chatAbortControllers.get(runId)).toBe(entry);
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
        expect(entry.projectSessionTerminalPending).toBe(false);
        expect(params.chatAbortControllers.has(runId)).toBe(false);
        expect(createGatewayActiveWorkSnapshot(inspectors).blockers).toEqual([]);
      } finally {
        releaseDispatch.resolve();
        terminalPersistence.resolve();
        await waiter;
        removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
      }
    },
  );

  it("keeps a newer terminal reservation when an older no-write dispatch fails", async () => {
    const { params, runId, registration, entry } = registeredRun("replaced-terminal-dispatch");
    claimAgentRunContext(runId, {
      sessionId: entry.sessionId,
      sessionKey: entry.sessionKey,
      projectSessionLifecycle: false,
    });
    const olderDispatch = { entered: createDeferred(), release: createDeferred() };
    const newerDispatch = { entered: createDeferred(), release: createDeferred() };
    const dispatches = [olderDispatch, newerDispatch];
    const failure = new Error("terminal dispatch failed");
    installHandler(async () => {
      const dispatch = dispatches.shift();
      if (!dispatch) {
        throw new Error("Unexpected terminal dispatch");
      }
      dispatch.entered.resolve();
      await dispatch.release.promise;
      throw failure;
    });
    unsubs = startGatewayEventSubscriptions(params);
    const emitTerminal = () =>
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", endedAt: 2_000 } });
    let older: Promise<void> | undefined;
    let newer: Promise<void> | undefined;
    try {
      emitTerminal();
      older = waitForChatAbortTerminalPersistence(entry);
      const olderRejected = expect(older).rejects.toBe(failure);
      await olderDispatch.entered.promise;
      emitTerminal();
      newer = waitForChatAbortTerminalPersistence(entry);
      const newerRejected = expect(newer).rejects.toBe(failure);
      await newerDispatch.entered.promise;
      registration.cleanup();
      olderDispatch.release.resolve();
      await olderRejected;
      expect(entry.projectSessionTerminalPending).toBe(true);
      expect(params.chatAbortControllers.get(runId)).toBe(entry);
      newerDispatch.release.resolve();
      await newerRejected;
      expect(entry.projectSessionTerminalPending).toBe(false);
      expect(params.chatAbortControllers.size).toBe(0);
    } finally {
      olderDispatch.release.resolve();
      newerDispatch.release.resolve();
      await Promise.allSettled([older, newer]);
      removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
    }
  });

  registerSessionPublicationTests({
    createParams,
    installHandlerFactory: (factory) => agentEventHandlerMocks.create.mockImplementation(factory),
    start,
    transcriptBroadcastMocks,
    warn,
  });

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
