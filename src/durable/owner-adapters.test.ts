import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSubagentRegistryToSqlite } from "../agents/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { updateSessionStore } from "../config/sessions/store.js";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue.js";
import {
  consumeSelectedSystemEventEntries,
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  acknowledgeConsumedSessionAttentionDeliveries,
  requestSessionAttentionDelivery,
} from "../sessions/session-attention.js";
import {
  createTaskRecord,
  getTaskById,
  markTaskTerminalById,
  maybeDeliverTaskTerminalUpdate,
  resetTaskRegistryForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "../tasks/runtime-internal.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-runtime-internal.js";
import {
  flowRunsOwnerAdapter,
  reconcileDurableOwnerAttentionFact,
  sessionStoreOwnerAdapter,
  subagentRunsOwnerAdapter,
  taskRunsOwnerAdapter,
} from "./owner-adapters.js";
import {
  acknowledgeDurableSessionWakeConsumption,
  recoverDurableSessionAttentionDeliveries,
  supersedeDurableSessionWakeForGenerationChange,
} from "./session-owner-adapter.js";
import { openDurableRuntimeStore } from "./store-factory.js";

describe("durable canonical owner adapters", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;
  let previousDurableEnabled: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-owner-adapter-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    previousDurableEnabled = process.env.OPENCLAW_DURABLE_RUNTIME;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_DURABLE_RUNTIME = "1";
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    resetSystemEventsForTest();
  });

  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    resetSystemEventsForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousDurableEnabled === undefined) {
      delete process.env.OPENCLAW_DURABLE_RUNTIME;
    } else {
      process.env.OPENCLAW_DURABLE_RUNTIME = previousDurableEnabled;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("projects an overdue official task without mirroring its lifecycle", () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:test:main",
      ownerKey: "agent:test:main",
      task: "long command",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      startedAt: 100,
      lastEventAt: 100,
      progressSummary: "Still processing",
    });
    expect(task).not.toBeNull();
    const fact = taskRunsOwnerAdapter.listAttentionFacts({ now: 1_000_000, limit: 10 })[0];
    expect(fact).toMatchObject({
      sourceOwner: "task_runs",
      sourceRef: task!.taskId,
      reason: "child_overdue",
      targetRef: "agent:test:main",
    });

    const store = openDurableRuntimeStore();
    try {
      reconcileDurableOwnerAttentionFact({ store, fact: fact!, now: 1_000_000 });
      expect(store.listRuns()).toHaveLength(0);
      expect(store.listWakeObligations({ sourceOwner: "task_runs" })).toEqual([
        expect.objectContaining({ sourceRef: task!.taskId, status: "pending" }),
      ]);
      const revisedFact = {
        ...fact!,
        sourceRevision: "task-revision-2",
        metadata: { ...fact!.metadata, sourceRevision: "task-revision-2" },
      };
      store.suspendWakeObligation({
        wakeId: store.listWakeObligations({ sourceOwner: "task_runs" })[0]!.wakeId,
        failedReason: "interrupted_dispatch",
        now: 1_000_050,
      });
      const revised = reconcileDurableOwnerAttentionFact({
        store,
        fact: revisedFact,
        now: 1_000_100,
      }).wake;
      expect(revised.status).toBe("pending");
      expect(revised.metadata).toMatchObject({ sourceRevision: "task-revision-2" });
      expect(
        store.acknowledgeWakeObligation({
          wakeId: revised.wakeId,
          actorKind: "operator",
          actorRef: "test",
          expectedSourceRevision: fact!.sourceRevision,
        }),
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("applies the owner fact limit after filtering non-actionable task history", () => {
    const actionable = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:test:main",
      ownerKey: "agent:test:main",
      task: "older task still requiring attention",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      startedAt: 100,
      lastEventAt: 100,
    });
    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:test:main",
      ownerKey: "agent:test:main",
      task: "newer silent task",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      startedAt: 200,
      lastEventAt: 200,
    });

    expect(taskRunsOwnerAdapter.listAttentionFacts({ now: 1_000_000, limit: 1 })).toEqual([
      expect.objectContaining({ sourceRef: actionable!.taskId, reason: "child_overdue" }),
    ]);
  });

  it("uses one persistent fallback for overdue task progress", async () => {
    const sessionKey = "agent:test:task-progress";
    const storePath = resolveStorePath(undefined, { agentId: "test", env: process.env });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "session-task-progress",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
      };
    });
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      task: "long command",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      startedAt: 100,
      lastEventAt: 100,
      progressSummary: "Still processing",
    });
    const fact = taskRunsOwnerAdapter.listAttentionFacts({ now: 1_000_000, limit: 10 })[0];
    const durableStore = openDurableRuntimeStore();
    const wake = reconcileDurableOwnerAttentionFact({
      store: durableStore,
      fact: fact!,
      now: 1_000_000,
    }).wake;
    durableStore.close();

    const result = await taskRunsOwnerAdapter.dispatchAttention({
      wake,
      claimToken: "task-progress-claim",
    });

    expect(result).toMatchObject({
      kind: "handoff_accepted",
      evidence: {
        canonicalOwner: "task_runs",
        ownerResult: "durable_progress_fallback",
        proofBoundary: "persistent_session_queue_acceptance",
      },
    });
    expect(peekSystemEvents(sessionKey)).toHaveLength(1);
    expect(await loadPendingSessionDeliveries()).toEqual([
      expect.objectContaining({
        kind: "systemEvent",
        sessionKey,
        source: { owner: "durable_wake", ref: wake.wakeId },
      }),
    ]);
    expect(getTaskById(task!.taskId)?.lastEventAt).toBe(100);
  });

  it("uses one persistent fallback for overdue subagent progress", async () => {
    const sessionKey = "agent:test:subagent-progress";
    const storePath = resolveStorePath(undefined, { agentId: "test", env: process.env });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "session-subagent-progress",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
      };
    });
    const entry: SubagentRunRecord = {
      runId: "subagent-progress-run",
      taskRunId: "subagent-progress-run",
      childSessionKey: "agent:test:subagent:progress-child",
      requesterSessionKey: sessionKey,
      requesterDisplayKey: "test",
      task: "long delegated task",
      cleanup: "keep",
      expectsCompletionMessage: true,
      generation: 1,
      createdAt: 100,
      startedAt: 100,
      execution: { status: "running", startedAt: 100 },
    };
    saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
    const fact = subagentRunsOwnerAdapter.listAttentionFacts({ now: 1_000_000, limit: 10 })[0];
    const durableStore = openDurableRuntimeStore();
    const wake = reconcileDurableOwnerAttentionFact({
      store: durableStore,
      fact: fact!,
      now: 1_000_000,
    }).wake;
    durableStore.close();

    const result = await subagentRunsOwnerAdapter.dispatchAttention({
      wake,
      claimToken: "subagent-progress-claim",
    });

    expect(result).toMatchObject({
      kind: "handoff_accepted",
      evidence: {
        canonicalOwner: "subagent_runs",
        ownerResult: "durable_progress_fallback",
        proofBoundary: "persistent_session_queue_acceptance",
      },
    });
    expect(peekSystemEvents(sessionKey)).toHaveLength(1);
    expect(await loadPendingSessionDeliveries()).toEqual([
      expect.objectContaining({
        kind: "systemEvent",
        sessionKey,
        source: { owner: "durable_wake", ref: wake.wakeId },
      }),
    ]);
  });

  it("projects a discarded canonical subagent delivery as an inspectable suspension", () => {
    const entry: SubagentRunRecord = {
      runId: "subagent-discarded-run",
      taskRunId: "subagent-discarded-run",
      childSessionKey: "agent:test:subagent:discarded-child",
      requesterSessionKey: "agent:test:main",
      requesterDisplayKey: "test",
      task: "result discarded under canonical owner pressure",
      cleanup: "keep",
      expectsCompletionMessage: true,
      generation: 1,
      createdAt: 100,
      startedAt: 100,
      endedAt: 200,
      outcome: { status: "ok" },
      execution: { status: "terminal", startedAt: 100, endedAt: 200, outcome: { status: "ok" } },
      completion: { required: true, resultText: "completed result", capturedAt: 200 },
      delivery: {
        status: "discarded",
        discardedAt: 300,
        discardReason: "pressure-pruned",
        discardedPayloadSummary: { childRunId: "subagent-discarded-run", status: "ok" },
      },
    };
    saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));

    const fact = subagentRunsOwnerAdapter.listAttentionFacts({ now: 400 })[0];
    expect(fact).toMatchObject({
      sourceRef: entry.runId,
      reason: "child_terminal",
      suspendedReason: "owner_delivery_discarded:pressure-pruned",
      metadata: { deliveryDiscardedAt: 300, deliveryDiscardReason: "pressure-pruned" },
    });

    const store = openDurableRuntimeStore();
    const reconciled = reconcileDurableOwnerAttentionFact({ store, fact: fact!, now: 400 });
    expect(reconciled).toMatchObject({ suspended: true, wake: { status: "suspended" } });
    store.close();
  });

  it("retries terminal delivery through the official task owner", async () => {
    const sendMessage = vi.fn(async () => ({ messageId: "message-1" }));
    setTaskRegistryDeliveryRuntimeForTests({ sendMessage } as never);
    const created = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:test:main",
      ownerKey: "agent:test:main",
      requesterOrigin: { channel: "telegram", to: "user-1" },
      task: "long command",
      status: "running",
      deliveryStatus: "failed",
      notifyPolicy: "done_only",
      startedAt: 100,
      lastEventAt: 200,
    });
    const task = markTaskTerminalById({
      taskId: created!.taskId,
      status: "failed",
      endedAt: 200,
      terminalSummary: "command failed",
    });
    expect(task).not.toBeNull();
    const fact = taskRunsOwnerAdapter.inspect(task!.taskId);
    expect(fact).toMatchObject({ sourceOwner: "task_runs", reason: "child_terminal" });

    const result = await taskRunsOwnerAdapter.dispatchAttention({
      wake: {
        wakeId: "wake-task",
        sourceOwner: "task_runs",
        sourceRef: task!.taskId,
        reason: "child_terminal",
      } as never,
      claimToken: "claim-task",
    });

    expect(result).toMatchObject({ kind: "acknowledged" });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(getTaskById(task!.taskId)?.deliveryStatus).toBe("delivered");
  });

  it("promotes canonical task session delivery into one persistent handoff", async () => {
    const sessionKey = "agent:test:task-terminal-session";
    const storePath = resolveStorePath(undefined, { agentId: "test", env: process.env });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "session-task-terminal",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
      };
    });
    const created = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      task: "produce a durable terminal result",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      startedAt: 100,
      lastEventAt: 100,
    });
    const task = markTaskTerminalById({
      taskId: created!.taskId,
      status: "failed",
      endedAt: 200,
      terminalSummary: "durable terminal result",
    });
    await maybeDeliverTaskTerminalUpdate(task!.taskId);
    const originalEvents = peekSystemEventEntries(sessionKey);
    expect(originalEvents).toHaveLength(1);
    expect(originalEvents[0]?.deliveryQueueIds).toBeUndefined();
    expect(getTaskById(task!.taskId)?.deliveryStatus).toBe("session_queued");

    const fact = taskRunsOwnerAdapter.inspect(task!.taskId);
    expect(fact).toMatchObject({ reason: "child_terminal" });
    const durableStore = openDurableRuntimeStore();
    const wake = reconcileDurableOwnerAttentionFact({
      store: durableStore,
      fact: fact!,
      now: 300,
    }).wake;
    durableStore.close();
    const result = await taskRunsOwnerAdapter.dispatchAttention({
      wake,
      claimToken: "task-terminal-session-claim",
    });

    expect(result).toMatchObject({
      kind: "handoff_accepted",
      evidence: {
        canonicalOwner: "task_runs",
        mode: "terminal",
        deliveryStatus: "session_queued",
        proofBoundary: "persistent_session_queue_acceptance",
        immediateAdmission: "coalesced",
      },
    });
    expect(peekSystemEventEntries(sessionKey)).toEqual([
      expect.objectContaining({
        text: originalEvents[0]!.text,
        deliveryQueueIds: [expect.any(String)],
      }),
    ]);
    expect(await loadPendingSessionDeliveries()).toEqual([
      expect.objectContaining({
        kind: "systemEvent",
        sessionKey,
        text: originalEvents[0]!.text,
        source: { owner: "durable_wake", ref: wake.wakeId },
      }),
    ]);
  });

  it("accepts durable parent-review handoff when the requester origin is directly deliverable", async () => {
    const sessionKey = "agent:test:acp-parent-review";
    const storePath = resolveStorePath(undefined, { agentId: "test", env: process.env });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "session-acp-parent-review",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
      };
    });
    const created = createTaskRecord({
      runtime: "acp",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      requesterOrigin: { channel: "telegram", to: "user-1" },
      childSessionKey: "agent:test:acp:child",
      task: "produce a parent-review result",
      status: "running",
      deliveryStatus: "failed",
      notifyPolicy: "done_only",
      startedAt: 100,
      lastEventAt: 100,
    });
    const task = markTaskTerminalById({
      taskId: created!.taskId,
      status: "succeeded",
      endedAt: 200,
      terminalSummary: "parent-review result",
    });
    const fact = taskRunsOwnerAdapter.inspect(task!.taskId);
    const durableStore = openDurableRuntimeStore();
    const wake = reconcileDurableOwnerAttentionFact({
      store: durableStore,
      fact: fact!,
      now: 300,
    }).wake;
    durableStore.close();

    const result = await taskRunsOwnerAdapter.dispatchAttention({
      wake,
      claimToken: "acp-parent-review-claim",
    });

    expect(result).toMatchObject({
      kind: "handoff_accepted",
      evidence: {
        canonicalOwner: "task_runs",
        deliveryStatus: "session_queued",
        proofBoundary: "persistent_session_queue_acceptance",
      },
    });
    expect(getTaskById(task!.taskId)?.deliveryStatus).toBe("session_queued");
    expect(await loadPendingSessionDeliveries()).toEqual([
      expect.objectContaining({
        kind: "systemEvent",
        sessionKey,
        source: { owner: "durable_wake", ref: wake.wakeId },
      }),
    ]);
  });

  it("defers a stale task revision without terminally losing the same obligation", async () => {
    const sessionKey = "agent:test:task-revision";
    const storePath = resolveStorePath(undefined, { agentId: "test", env: process.env });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "session-task-revision",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
      };
    });
    const created = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      task: "survive a source revision race",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      startedAt: 100,
      lastEventAt: 100,
    });
    const task = markTaskTerminalById({
      taskId: created!.taskId,
      status: "failed",
      endedAt: 200,
      lastEventAt: 200,
      terminalSummary: "first terminal revision",
    });
    const durableStore = openDurableRuntimeStore();
    const firstFact = taskRunsOwnerAdapter.inspect(task!.taskId)!;
    const firstWake = reconcileDurableOwnerAttentionFact({
      store: durableStore,
      fact: firstFact,
      now: 300,
    }).wake;
    markTaskTerminalById({
      taskId: task!.taskId,
      status: "failed",
      endedAt: 200,
      lastEventAt: 250,
      terminalSummary: "updated terminal revision",
    });

    await expect(
      taskRunsOwnerAdapter.dispatchAttention({
        wake: firstWake,
        claimToken: "stale-task-revision-claim",
      }),
    ).resolves.toMatchObject({
      kind: "deferred",
      reason: "canonical_source_revision_advanced",
    });
    expect(durableStore.getWakeObligation(firstWake.wakeId)?.status).toBe("pending");

    const revisedFact = taskRunsOwnerAdapter.inspect(task!.taskId)!;
    expect(revisedFact.dedupeKey).toBe(firstFact.dedupeKey);
    const revisedWake = reconcileDurableOwnerAttentionFact({
      store: durableStore,
      fact: revisedFact,
      now: 400,
    }).wake;
    durableStore.close();
    expect(revisedWake.wakeId).toBe(firstWake.wakeId);
    await expect(
      taskRunsOwnerAdapter.dispatchAttention({
        wake: revisedWake,
        claimToken: "current-task-revision-claim",
      }),
    ).resolves.toMatchObject({ kind: "handoff_accepted" });
  });

  it("projects a stalled managed flow and hands attention to its owner session", async () => {
    const sessionKey = "agent:test:flow-owner";
    const storePath = resolveStorePath(undefined, { agentId: "test", env: process.env });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "session-flow-owner",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
      };
    });
    const flow = createManagedTaskFlow({
      ownerKey: sessionKey,
      controllerId: "controller-test",
      status: "blocked",
      notifyPolicy: "state_changes",
      goal: "coordinate several child agents",
      currentStep: "fan-in",
      blockedSummary: "waiting for one child result",
      createdAt: 100,
      updatedAt: 100,
    });
    expect(flow).not.toBeNull();
    const fact = flowRunsOwnerAdapter.listAttentionFacts({ now: 10_000, limit: 10 })[0];
    expect(fact).toMatchObject({
      sourceOwner: "flow_runs",
      sourceRef: flow!.flowId,
      reason: "fan_in_incomplete",
      targetRef: sessionKey,
    });

    const durableStore = openDurableRuntimeStore();
    const wake = reconcileDurableOwnerAttentionFact({
      store: durableStore,
      fact: fact!,
      now: 10_000,
    }).wake;
    durableStore.close();
    const result = await flowRunsOwnerAdapter.dispatchAttention({
      wake,
      claimToken: "flow-attention-claim",
    });

    expect(result).toMatchObject({
      kind: "handoff_accepted",
      evidence: {
        proofBoundary: "persistent_session_queue_acceptance",
        sessionKey,
        sessionId: "session-flow-owner",
      },
    });
    expect(await loadPendingSessionDeliveries()).toEqual([
      expect.objectContaining({
        kind: "systemEvent",
        sessionKey,
        expectedSessionId: "session-flow-owner",
        source: { owner: "durable_wake", ref: wake.wakeId },
      }),
    ]);
  });

  it("hands restart uncertainty to the canonical session owner without replaying work", async () => {
    const sessionKey = "agent:test:durable-restart";
    const storePath = resolveStorePath(undefined, { agentId: "test", env: process.env });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "session-restart",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
      };
    });

    const durableStore = openDurableRuntimeStore();
    const wake = durableStore.createWakeObligation({
      wakeId: "wake-restart",
      sourceOwner: "session_store",
      sourceRef: sessionKey,
      sourceRunId: "run-restart",
      targetKind: "agent_session",
      targetRef: sessionKey,
      targetResolutionStatus: "resolved",
      reason: "restart_interrupted",
      dedupeKey: "session-restart-attention",
      now: 100,
    });
    const claim = durableStore.claimNextWakeObligation({
      workerId: "test-worker",
      claimTtlMs: 1_000,
      retryBaseMs: 1_000,
      retryMaxMs: 10_000,
      now: 110,
    });
    durableStore.close();

    const result = await sessionStoreOwnerAdapter.dispatchAttention({
      wake,
      claimToken: claim!.claimToken,
    });

    expect(result).toMatchObject({
      kind: "handoff_accepted",
      evidence: {
        proofBoundary: "persistent_session_queue_acceptance",
        ownerResult: "session_delivery_enqueued",
        sessionKey,
        sessionId: "session-restart",
        deliveryQueueId: expect.any(String),
        generationFenced: true,
        attachedSessionConsumptionProven: false,
        userDeliveryProven: false,
      },
    });
    if (result.kind !== "handoff_accepted") {
      throw new Error(`expected handoff_accepted, received ${result.kind}`);
    }
    const acceptedStore = openDurableRuntimeStore();
    acceptedStore.completeWakeObligationClaim({
      wakeId: wake.wakeId,
      deliveryAttemptId: claim!.deliveryAttempt.deliveryAttemptId,
      claimToken: claim!.claimToken,
      attemptStatus: "handoff_accepted",
      wakeStatus: "handoff_accepted",
      now: 120,
    });
    acceptedStore.close();
    expect(peekSystemEvents(sessionKey)).toEqual([
      expect.stringContaining("Do not repeat tools or external side effects automatically"),
    ]);
    resetSystemEventsForTest();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await recoverDurableSessionAttentionDeliveries({ log });
    await recoverDurableSessionAttentionDeliveries({ log });
    expect(peekSystemEvents(sessionKey)).toEqual([
      expect.stringContaining("Do not repeat tools or external side effects automatically"),
    ]);
    expect(await loadPendingSessionDeliveries()).toEqual([
      expect.objectContaining({
        id: result.evidence.deliveryQueueId,
        expectedSessionId: "session-restart",
      }),
    ]);

    consumeSelectedSystemEventEntries(sessionKey, peekSystemEventEntries(sessionKey));
    await expect(acknowledgeConsumedSessionAttentionDeliveries(sessionKey)).resolves.toEqual({
      acknowledgedIds: [result.evidence.deliveryQueueId],
      failed: [],
    });
    expect(await loadPendingSessionDeliveries()).toEqual([]);
    const acknowledgedStore = openDurableRuntimeStore();
    try {
      expect(acknowledgedStore.getWakeObligation(wake.wakeId)).toMatchObject({
        status: "acked",
        metadata: {
          durableWakeControl: {
            actorKind: "system_worker",
            actorRef: "session_attention_consumer",
            evidence: {
              sessionKey,
              expectedSessionId: "session-restart",
            },
          },
        },
      });
    } finally {
      acknowledgedStore.close();
    }
  });

  it("converges when the wake is acked before its queue row is deleted", async () => {
    const sessionKey = "agent:test:durable-finalize-crash";
    const storePath = resolveStorePath(undefined, { agentId: "test", env: process.env });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "session-finalize-crash",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
      };
    });

    const store = openDurableRuntimeStore();
    const wake = store.createWakeObligation({
      wakeId: "wake-finalize-crash",
      sourceOwner: "session_store",
      sourceRef: sessionKey,
      targetKind: "agent_session",
      targetRef: sessionKey,
      targetResolutionStatus: "resolved",
      reason: "restart_interrupted",
      dedupeKey: "session-finalize-crash",
      now: 100,
    });
    const claim = store.claimNextWakeObligation({
      workerId: "test-worker",
      claimTtlMs: 1_000,
      retryBaseMs: 1_000,
      retryMaxMs: 10_000,
      now: 110,
    });
    store.close();

    const dispatch = await sessionStoreOwnerAdapter.dispatchAttention({
      wake,
      claimToken: claim!.claimToken,
    });
    if (dispatch.kind !== "handoff_accepted") {
      throw new Error(`expected handoff_accepted, received ${dispatch.kind}`);
    }
    const deliveryQueueId = dispatch.evidence.deliveryQueueId;
    if (typeof deliveryQueueId !== "string") {
      throw new Error("expected a persisted session delivery queue id");
    }
    const acceptedStore = openDurableRuntimeStore();
    acceptedStore.completeWakeObligationClaim({
      wakeId: wake.wakeId,
      deliveryAttemptId: claim!.deliveryAttempt.deliveryAttemptId,
      claimToken: claim!.claimToken,
      attemptStatus: "handoff_accepted",
      wakeStatus: "handoff_accepted",
      now: 120,
    });
    acceptedStore.close();

    acknowledgeDurableSessionWakeConsumption({
      wakeId: wake.wakeId,
      deliveryQueueId,
      sessionKey,
      expectedSessionId: "session-finalize-crash",
    });
    resetSystemEventsForTest();

    await recoverDurableSessionAttentionDeliveries({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(await loadPendingSessionDeliveries()).toEqual([]);
    expect(peekSystemEvents(sessionKey)).toEqual([]);
  });

  it("suspends session attention when the canonical session no longer exists", async () => {
    const result = await sessionStoreOwnerAdapter.dispatchAttention({
      wake: {
        wakeId: "wake-missing",
        sourceOwner: "session_store",
        sourceRef: "agent:test:missing",
        targetKind: "agent_session",
        targetRef: "agent:test:missing",
        reason: "restart_interrupted",
      } as never,
      claimToken: "claim-missing",
    });

    expect(result).toEqual({ kind: "suspended", reason: "canonical_session_missing" });
  });

  it("supersedes an accepted wake when its target session generation changes", () => {
    const store = openDurableRuntimeStore();
    const wake = store.createWakeObligation({
      sourceOwner: "session_store",
      sourceRef: "agent:test:old-generation",
      targetKind: "agent_session",
      targetRef: "agent:test:old-generation",
      targetResolutionStatus: "resolved",
      reason: "restart_interrupted",
      dedupeKey: "session-generation-change",
      now: 100,
    });
    const claim = store.claimNextWakeObligation({
      workerId: "test-worker",
      claimTtlMs: 1_000,
      retryBaseMs: 1_000,
      retryMaxMs: 10_000,
      now: 110,
    });
    expect(claim).toBeDefined();
    store.completeWakeObligationClaim({
      wakeId: wake.wakeId,
      deliveryAttemptId: claim!.deliveryAttempt.deliveryAttemptId,
      claimToken: claim!.claimToken,
      attemptStatus: "handoff_accepted",
      wakeStatus: "handoff_accepted",
      now: 120,
    });
    store.close();

    supersedeDurableSessionWakeForGenerationChange({
      wakeId: wake.wakeId,
      deliveryQueueId: "queue-generation-change",
      expectedSessionId: "session-old",
      actualSessionId: "session-new",
    });

    const verify = openDurableRuntimeStore();
    try {
      expect(verify.getWakeObligation(wake.wakeId)).toMatchObject({
        status: "superseded",
        metadata: {
          durableWakeControl: {
            actorKind: "system_worker",
            actorRef: "session_delivery_recovery",
            evidence: {
              expectedSessionId: "session-old",
              actualSessionId: "session-new",
              deliveryQueueId: "queue-generation-change",
            },
          },
        },
      });
    } finally {
      verify.close();
    }
  });

  it("rechecks the session generation after prompt consumption before acknowledging", async () => {
    const sessionKey = "agent:test:generation-race";
    const storePath = resolveStorePath(undefined, { agentId: "test", env: process.env });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "session-old",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
      };
    });
    const store = openDurableRuntimeStore();
    const wake = store.createWakeObligation({
      sourceOwner: "session_store",
      sourceRef: sessionKey,
      targetKind: "agent_session",
      targetRef: sessionKey,
      targetResolutionStatus: "resolved",
      reason: "restart_interrupted",
      dedupeKey: "session-generation-race",
      now: 100,
    });
    store.close();
    const handoff = await requestSessionAttentionDelivery({
      sessionKey,
      text: "inspect interrupted durable work",
      idempotencyKey: "durable-wake:generation-race",
      wakeId: wake.wakeId,
    });
    if (handoff.status !== "handoff_accepted") {
      throw new Error(`expected handoff_accepted, received ${handoff.status}`);
    }
    consumeSelectedSystemEventEntries(sessionKey, peekSystemEventEntries(sessionKey));
    await updateSessionStore(storePath, (sessions) => {
      sessions[sessionKey] = {
        sessionId: "session-new",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
      };
    });

    await expect(acknowledgeConsumedSessionAttentionDeliveries(sessionKey)).resolves.toEqual({
      acknowledgedIds: [handoff.deliveryQueueId],
      failed: [],
    });
    expect(await loadPendingSessionDeliveries()).toEqual([]);
    const verify = openDurableRuntimeStore();
    try {
      expect(verify.getWakeObligation(wake.wakeId)).toMatchObject({
        status: "superseded",
        metadata: {
          durableWakeControl: {
            evidence: {
              expectedSessionId: "session-old",
              actualSessionId: "session-new",
              deliveryQueueId: handoff.deliveryQueueId,
            },
          },
        },
      });
    } finally {
      verify.close();
    }
  });
});
