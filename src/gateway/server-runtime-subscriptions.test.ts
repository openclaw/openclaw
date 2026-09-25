// Tests for gateway runtime subscription wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { configureExecutionIdentityAdmissionSink } from "../audit/execution-identity-admission.js";
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
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  PROGRESS_CARD_REFRESH_SOURCE_TOOL,
  progressCardRefreshRunProjection,
} from "../sessions/input-provenance.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  emitSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { installInMemoryTaskRegistryRuntime } from "../test-utils/task-registry-runtime.js";
import {
  waitForChatAbortControllerRemoval,
  waitForChatAbortTerminalPersistence,
} from "./chat-abort-lifecycle-internal.js";
import { abortChatRunById, removeChatAbortControllerEntry } from "./chat-abort.js";
import type { AgentEventHandlerOptions } from "./server-chat.js";
import { registerActivitySummaryPublicationTests } from "./server-runtime-subscriptions.activity-summary.test-support.js";
import { registerTaskEventSubscriptionTests } from "./server-runtime-subscriptions.task-events.test-support.js";
import { registerTaskSubscriptionOwnershipTests } from "./server-runtime-subscriptions.task-ownership.test-support.js";
import {
  createSubscriptionTestFixture,
  lifecycleState,
  readLifecycleState,
  registerSubscriptionChatRun,
  registerAuditSubscriptionTests,
} from "./server-runtime-subscriptions.test-support.js";
import type { SessionRowProjection } from "./session-row-projection.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const { log: mockLog, warn, createParams } = createSubscriptionTestFixture();

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
  persistLifecycle: vi.fn(async () => {}),
  resolveSessionKey: vi.fn(() => "agent:main:main"),
}));
const transcriptBroadcastMocks = vi.hoisted(() => ({
  useActualHandler: false,
  readMessageById: vi.fn(),
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

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => runtimeConfigState.value,
}));

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
            if (event.kind === "message") {
              auditTestState.messages += 1;
            } else {
              auditTestState.recorded += 1;
            }
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

vi.mock("./session-lifecycle-state.js", () => ({
  persistGatewaySessionLifecycleEvent: agentEventHandlerMocks.persistLifecycle,
}));

vi.mock("./server-session-key.js", () => ({
  resolveSessionKeyForRun: agentEventHandlerMocks.resolveSessionKey,
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
    createLifecycleEventBroadcastHandler: () => () => {
      throw new Error("lifecycle handler failure");
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
    agentEventHandlerMocks.resolveSessionKey.mockClear();
    agentEventHandlerMocks.create.mockReset().mockImplementation(() => {
      throw new Error("server-chat lazy load failure");
    });
    installInMemoryTaskRegistryRuntime();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await unsubs?.agentUnsub();
    unsubs?.heartbeatUnsub();
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    await unsubs?.taskUnsub();
    resetAgentEventsForTest();
    resetTaskRegistryForTests({ persist: false });
    configureExecutionIdentityAdmissionSink(() => false)();
  });

  registerTaskSubscriptionOwnershipTests(
    (broadcast, terminalSessions = { closeTaskSessions: vi.fn(() => 1) }) => {
      unsubs = startGatewayEventSubscriptions({ ...createParams(), broadcast, terminalSessions });
      return { taskUnsub: unsubs.taskUnsub, closeTaskSessions: terminalSessions.closeTaskSessions };
    },
  );

  it.each([
    "same-id reset",
    "replacement",
    "missing row",
    "missing row without ID",
    "missing projection",
  ])("does not attach a successor row after a queued %s", async (change) => {
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
        return { kind: "complete" as const, value: consume(undefined) };
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
    current = { sessionId: change === "replacement" ? "successor" : "original" };
    admitted = true;
    prepared.resolve();
    await waitForFast(() => expect(delivered).toHaveBeenCalledWith(null));
  });

  registerActivitySummaryPublicationTests(
    (projection) => {
      const params = createParams();
      unsubs = startGatewayEventSubscriptions({
        ...params,
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
      expect.objectContaining({ assertCommitAllowed: expect.any(Function) }),
    );
    expect(agentEventHandlerMocks.resolveSessionKey).toHaveBeenCalledWith(runId, undefined);
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

  it("disposes a loaded agent event handler on unsubscribe", async () => {
    const dispose = vi.fn();
    const handler = Object.assign(vi.fn(), { dispose });
    agentEventHandlerMocks.create.mockReturnValue(handler);
    unsubs = startGatewayEventSubscriptions(createParams());

    emitAgentEvent({ runId: "run-dispose", stream: "lifecycle", data: { phase: "error" } });
    await waitForFast(() => expect(handler).toHaveBeenCalledOnce());

    await unsubs.agentUnsub();
    expect(dispose).toHaveBeenCalledOnce();
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
    const handler = Object.assign(vi.fn(), { dispose: vi.fn() });
    agentEventHandlerMocks.create.mockReturnValue(handler);
    const params = createParams();
    params.chatAbortControllers.set("run-ops", {
      sessionKey: "global",
      sessionId: "session-ops",
    } as never);
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({ runId: "load-handler", stream: "lifecycle", data: { phase: "error" } });
    await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());
    const options = agentEventHandlerMocks.create.mock.calls[0]?.[0] as {
      resolveSessionActiveRunState?: (session: {
        requestedKey: string;
        canonicalKey: string;
        sessionId?: string;
        agentId?: string;
      }) => { active: boolean; runIds: string[] };
    };

    expect(
      options.resolveSessionActiveRunState?.({
        requestedKey: "global",
        canonicalKey: "global",
        sessionId: "session-ops",
        agentId: "ops",
      }),
    ).toEqual({ active: true, runIds: ["run-ops"] });
  });

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
    const transitions: LifecycleTransition[] = [
      { state: "Registered", lifecycle: readLifecycleState(entry) },
    ];
    agentEventHandlerMocks.create.mockReturnValue(Object.assign(vi.fn(), { dispose: vi.fn() }));
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    transitions.push({ state: "Start-normalized", lifecycle: readLifecycleState(entry) });
    await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());

    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "error", error: "retryable provider failure", endedAt: 2_000 },
    });
    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 2_500 },
    });
    expect(agentEventHandlerMocks.persistLifecycle).not.toHaveBeenCalled();

    const terminalPersistence = createDeferred();
    agentEventHandlerMocks.persistLifecycle.mockReturnValue(terminalPersistence.promise);

    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 3_000 },
    });
    transitions.push({ state: "Persisting", lifecycle: readLifecycleState(entry) });

    terminalPersistence.resolve();
    await waitForFast(() => expect(entry.projectSessionTerminalPersisted).toBe(true));
    transitions.push({ state: "Persisted", lifecycle: readLifecycleState(entry) });

    registration.cleanup();
    transitions.push({ state: "Removed" });
    expect(params.chatAbortControllers.has(runId)).toBe(false);
    expect(transitions).toEqual([
      { state: "Registered", lifecycle: lifecycleState(true) },
      { state: "Start-normalized", lifecycle: lifecycleState(true, false) },
      {
        state: "Persisting",
        lifecycle: lifecycleState(false, true, 3_000, terminalPersistence.promise, false),
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
      const runId = "captured-terminal";
      const sessionKey = "agent:main:captured-terminal";
      const register = () =>
        registerSubscriptionChatRun(params, {
          runId,
          sessionId: "captured-session",
          sessionKey,
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
          sessionId: entry.sessionId,
          stream: "lifecycle",
          data: { phase: "end", endedAt },
        });
      emitTerminal(2_000);
      expect(entry.projectSessionTerminalPersistence).toBe(terminal.promise);
      const firstDrain = waitForChatAbortTerminalPersistence(entry).then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      const recovery = {
        runId,
        sessionKey,
        sessionId: entry.sessionId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        observedAt: 2_000,
      };
      params.restartRecoveryCandidates.set(runId, recovery);
      let current = entry;
      if (change !== "newer write") {
        expect(removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry)).toBe(
          true,
        );
      }
      if (change.includes("replacement")) {
        current = register();
      }
      if (change !== "removed") {
        emitTerminal(3_000);
        params.restartRecoveryCandidates.set(runId, { ...recovery, observedAt: 3_000 });
      }
      if (change === "retired replacement") {
        expect(removeChatAbortControllerEntry(params.chatAbortControllers, runId, current)).toBe(
          true,
        );
      }
      const currentState = readLifecycleState(current);
      try {
        await firstDispatchEntered.promise;
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
          expect(entry.projectSessionTerminalPending).toBe(false);
          expect(entry.projectSessionTerminalPersistence).toBeUndefined();
          expect(entry.projectSessionTerminalPersisted).toBe(persisted);
          expect(
            await waitForChatAbortControllerRemoval({
              entries: params.chatAbortControllers,
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
          expect(params.chatAbortControllers.get(runId)).toBe(
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
    { result: "visible persistence", hidden: false, dispatchFails: false, persistenceFails: false },
    { result: "hidden no-write", hidden: true, dispatchFails: false, persistenceFails: false },
    {
      result: "hidden dispatch failure",
      hidden: true,
      dispatchFails: true,
      persistenceFails: false,
    },
    {
      result: "dispatch failure with an accepted write",
      hidden: false,
      dispatchFails: true,
      persistenceFails: false,
    },
    {
      result: "dispatch and persistence failures",
      hidden: false,
      dispatchFails: true,
      persistenceFails: true,
    },
  ])(
    "joins accepted terminal dispatch before settling $result",
    async ({ hidden, dispatchFails, persistenceFails }) => {
      const actual = await vi.importActual<typeof import("./server-chat.js")>("./server-chat.js");
      const runId = "run-abort-persistence-bridge";
      const sessionKey = "agent:main:main";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const params = createParams();
      const registration = registerSubscriptionChatRun(params, {
        runId,
        sessionId: "session-abort-persistence-bridge",
        sessionKey,
        lifecycleGeneration,
        ...(hidden ? { controlUiVisible: false, projectSessionActive: false } : {}),
      });
      const entry = registration.entry;
      claimAgentRunContext(runId, {
        lifecycleGeneration,
        sessionId: entry.sessionId,
        sessionKey,
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
              handler(event);
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
        expect(settled).toBe(false);
        expect(params.chatAbortControllers.get(runId)).toBe(entry);
        expect(entry.projectSessionTerminalPending).toBe(true);
        expect(entry.projectSessionTerminalPersistence).toBe(
          hidden ? undefined : terminalPersistence.promise,
        );
        releaseDispatch.resolve();
        await dispatchFinished.promise;
        if (!hidden) {
          expect(settled).toBe(false);
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
          expect(entry.projectSessionTerminalPending).toBe(false);
          expect(params.chatAbortControllers.has(runId)).toBe(false);
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        releaseDispatch.resolve();
        terminalPersistence.resolve();
        await waiter;
        removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
      }
    },
  );

  it("logs transcript handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/sess.jsonl",
      sessionKey: "agent:main:main",
    } as InternalSessionTranscriptUpdate);

    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Transcript update dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("logs real asynchronous transcript failures and recovers the broadcast queue", async () => {
    transcriptBroadcastMocks.useActualHandler = true;
    const failedRead = createDeferred();
    const persistenceFailure = new Error("session transcript read failed");
    const transcriptPosition = { source: "recovered-generation", rawSeq: 7 };
    const storedMessage = {
      role: "assistant",
      content: [{ type: "text", text: "visible answer" }],
      __openclaw: { transcriptPosition },
    };
    transcriptBroadcastMocks.readMessageById
      .mockImplementationOnce(async () => {
        await failedRead.promise;
        throw persistenceFailure;
      })
      .mockResolvedValueOnce({ found: true, oversized: false, seq: 2, message: storedMessage });

    const params = createParams();
    params.sessionEventSubscribers.subscribe("conn-transcript");
    unsubs = startGatewayEventSubscriptions(params);

    const emitMessage = (messageId: string) =>
      emitSessionTranscriptUpdate({
        sessionFile: "/tmp/openclaw-transcript-dispatch.sqlite",
        sessionKey: "agent:main:main",
        message: { role: "assistant", content: [{ type: "text", text: "stale queued answer" }] },
        messageId,
        target: {
          agentId: "main",
          sessionId: "sess-transcript",
          sessionKey: "agent:main:main",
          storePath: "/tmp/openclaw-transcript-dispatch-sessions.json",
        },
      });

    const admission = tryBeginGatewayRootWorkAdmission("test:transcript-publisher");
    if (!admission) {
      throw new Error("Transcript publisher admission was closed");
    }
    await admission.run(async () => emitMessage("failed-message"));
    admission.release();
    await waitForFast(() =>
      expect(transcriptBroadcastMocks.readMessageById).toHaveBeenCalledOnce(),
    );
    try {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      failedRead.resolve();
    }
    await waitForFast(() =>
      expect(warn).toHaveBeenCalledWith("Transcript update dispatch failed", {
        sessionKey: "agent:main:main",
        error: persistenceFailure,
      }),
    );
    expect(params.broadcastToConnIds).not.toHaveBeenCalled();

    emitMessage("recovered-message");
    await waitForFast(() => expect(params.broadcastToConnIds).toHaveBeenCalledOnce());
    expect(params.broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        messageId: "recovered-message",
        messageSeq: 2,
        message: expect.objectContaining({
          content: storedMessage.content,
          __openclaw: expect.objectContaining({ transcriptPosition }),
        }),
      }),
      new Set(["conn-transcript"]),
    );
    expect(transcriptBroadcastMocks.readMessageById).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
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

  it("logs lifecycle handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitSessionLifecycleEvent({ sessionKey: "agent:main:main", reason: "created" });

    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Lifecycle event dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  registerTaskEventSubscriptionTests((overrides) => {
    unsubs = startGatewayEventSubscriptions({ ...createParams(), ...overrides });
    return unsubs;
  }, mockLog);
});
