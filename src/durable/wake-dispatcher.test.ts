import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSubagentRegistryToSqlite } from "../agents/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import { subagentRunsOwnerAdapter } from "./owner-adapters.js";
import { openDurableRuntimeStore } from "./store-factory.js";
import { runDurableWakeDispatcherOnce } from "./wake-dispatcher.js";

const sessionAttentionMocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("../sessions/session-attention.js", () => ({
  requestSessionAttentionDelivery: sessionAttentionMocks.request,
}));

describe("durable wake dispatcher", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wake-dispatcher-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    sessionAttentionMocks.request.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("renews a wake claim while an owner adapter is still running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let markStarted!: () => void;
    let releaseDispatch!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    sessionAttentionMocks.request.mockImplementationOnce(async () => {
      markStarted();
      await released;
      return {
        status: "handoff_accepted",
        sessionKey: "agent:test:main",
        sessionId: "session-main",
        deliveryQueueId: "queue-slow-owner",
        duplicate: false,
        immediateAdmission: "queued",
      };
    });
    const store = openDurableRuntimeStore();
    const competingStore = openDurableRuntimeStore();
    const wake = store.createWakeObligation({
      sourceOwner: "session_store",
      sourceRef: "agent:test:main",
      targetKind: "agent_session",
      targetRef: "agent:test:main",
      targetResolutionStatus: "resolved",
      reason: "operator_requested",
      dedupeKey: "slow-owner-dispatch",
      now: 1_000,
    });
    try {
      const dispatch = runDurableWakeDispatcherOnce({
        store,
        workerId: "slow-owner-worker",
        claimTtlMs: 120,
        retryBaseMs: 1,
        retryMaxMs: 1,
      });
      await started;
      await vi.advanceTimersByTimeAsync(121);

      expect(
        competingStore.claimNextWakeObligation({
          workerId: "competing-worker",
          claimTtlMs: 120,
          retryBaseMs: 1,
          retryMaxMs: 1,
          now: Date.now(),
        }),
      ).toBeUndefined();
      expect(store.listDeliveryAttemptEvidence({ wakeId: wake.wakeId })).toEqual([
        expect.objectContaining({
          status: "attempted",
          deliveryClaimedBy: expect.any(String),
          deliveryClaimExpiresAt: 1_240,
        }),
      ]);

      releaseDispatch();
      await expect(dispatch).resolves.toMatchObject({ claimed: 1, handoffAccepted: 1 });
      expect(store.getWakeObligation(wake.wakeId)).toMatchObject({
        status: "handoff_accepted",
      });
    } finally {
      competingStore.close();
      store.close();
    }
  });

  it("suspends a resolved obligation when its canonical owner adapter is unavailable", async () => {
    const store = openDurableRuntimeStore();
    const wake = store.createWakeObligation({
      sourceOwner: "plugin_jobs",
      sourceRef: "job-1",
      targetKind: "agent_session",
      targetRef: "agent:test:main",
      targetResolutionStatus: "resolved",
      reason: "operator_requested",
      dedupeKey: "plugin-job-1",
      now: 100,
    });

    const result = await runDurableWakeDispatcherOnce({
      store,
      workerId: "worker-1",
      now: 100,
      claimTtlMs: 50,
    });

    expect(result).toMatchObject({ claimed: 1, suspended: 1 });
    expect(store.getWakeObligation(wake.wakeId)).toMatchObject({
      status: "suspended",
      failedReason: "owner_adapter_not_registered",
    });
    expect(store.listDeliveryAttemptEvidence({ wakeId: wake.wakeId })).toEqual([
      expect.objectContaining({ status: "failed", error: "owner_adapter_not_registered" }),
    ]);
    store.close();
  });

  it("quarantines an expired in-flight side effect as unknown instead of replaying it", async () => {
    const store = openDurableRuntimeStore();
    const wake = store.createWakeObligation({
      sourceOwner: "plugin_jobs",
      sourceRef: "job-unknown",
      targetKind: "agent_session",
      targetRef: "agent:test:main",
      targetResolutionStatus: "resolved",
      reason: "operator_requested",
      dedupeKey: "plugin-job-unknown",
      now: 100,
    });
    const firstClaim = store.claimNextWakeObligation({
      workerId: "worker-before-crash",
      claimTtlMs: 50,
      retryBaseMs: 1,
      retryMaxMs: 1,
      now: 100,
    });
    expect(firstClaim).toBeDefined();

    const result = await runDurableWakeDispatcherOnce({
      store,
      workerId: "worker-after-restart",
      now: 151,
      claimTtlMs: 50,
      retryBaseMs: 1,
      retryMaxMs: 1,
    });

    expect(result.claimed).toBe(0);
    expect(store.getWakeObligation(wake.wakeId)).toMatchObject({ status: "suspended" });
    expect(store.listDeliveryAttemptEvidence({ wakeId: wake.wakeId })).toEqual([
      expect.objectContaining({ status: "unknown", unknownAt: 151 }),
    ]);
    expect(store.listUnresolvedUncertaintyFacts()).toEqual([
      expect.objectContaining({ kind: "delivery_unknown", sourceRef: "job-unknown" }),
    ]);
    store.close();
  });

  it("projects a canonical owner suspension without creating a mirrored runtime", async () => {
    const entry: SubagentRunRecord = {
      runId: "child-suspended",
      taskRunId: "child-suspended",
      childSessionKey: "agent:test:subagent:child",
      requesterSessionKey: "agent:test:main",
      requesterDisplayKey: "test",
      task: "delegated task",
      cleanup: "keep",
      expectsCompletionMessage: true,
      generation: 1,
      createdAt: 100,
      startedAt: 100,
      endedAt: 200,
      outcome: { status: "ok" },
      execution: { status: "terminal", startedAt: 100, endedAt: 200, outcome: { status: "ok" } },
      completion: { required: true, resultText: "done", capturedAt: 200 },
      delivery: { status: "suspended", suspendedAt: 250, suspendedReason: "retry-limit" },
    };
    saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
    const store = openDurableRuntimeStore();

    const result = await runDurableWakeDispatcherOnce({ store, workerId: "worker-1", now: 300 });

    expect(result).toMatchObject({ ownerFactsScanned: 1, obligationsCreated: 1, suspended: 1 });
    expect(store.listRuns()).toHaveLength(0);
    expect(store.listWakeObligations()).toEqual([
      expect.objectContaining({
        sourceOwner: "subagent_runs",
        sourceRef: "child-suspended",
        status: "suspended",
      }),
    ]);
    store.close();
  });

  it("atomically acknowledges a wake when the canonical owner proves delivery", async () => {
    const entry: SubagentRunRecord = {
      runId: "child-delivered",
      taskRunId: "child-delivered",
      childSessionKey: "agent:test:subagent:delivered",
      requesterSessionKey: "agent:test:main",
      requesterDisplayKey: "test",
      task: "delegated task",
      cleanup: "keep",
      expectsCompletionMessage: true,
      generation: 1,
      createdAt: 100,
      startedAt: 100,
      endedAt: 200,
      outcome: { status: "ok" },
      execution: { status: "terminal", startedAt: 100, endedAt: 200, outcome: { status: "ok" } },
      completion: { required: true, resultText: "done", capturedAt: 200 },
      delivery: { status: "delivered", deliveredAt: 250 },
    };
    saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
    const store = openDurableRuntimeStore();
    const wake = store.createWakeObligation({
      sourceOwner: "subagent_runs",
      sourceRef: entry.runId,
      targetKind: "agent_session",
      targetRef: entry.requesterSessionKey,
      targetResolutionStatus: "resolved",
      reason: "child_terminal",
      dedupeKey: "child-delivered-proof",
      now: 260,
    });

    const result = await runDurableWakeDispatcherOnce({ store, workerId: "worker-1", now: 300 });

    expect(result).toMatchObject({ claimed: 1, acknowledged: 1, handoffAccepted: 0 });
    expect(store.getWakeObligation(wake.wakeId)).toMatchObject({ status: "acked", ackedAt: 300 });
    expect(store.listDeliveryAttemptEvidence({ wakeId: wake.wakeId })).toEqual([
      expect.objectContaining({ status: "handoff_accepted", handoffAcceptedAt: 300 }),
    ]);
    store.close();
  });

  it("accepts attached-session acknowledgement that races owner dispatch completion", async () => {
    const store = openDurableRuntimeStore();
    const wake = store.createWakeObligation({
      sourceOwner: "session_store",
      sourceRef: "agent:test:ack-race",
      targetKind: "agent_session",
      targetRef: "agent:test:ack-race",
      targetResolutionStatus: "resolved",
      reason: "operator_requested",
      dedupeKey: "session-owner-ack-race",
      now: 100,
    });
    sessionAttentionMocks.request.mockImplementationOnce(async () => {
      const consumerStore = openDurableRuntimeStore();
      try {
        consumerStore.acknowledgeWakeObligation({
          wakeId: wake.wakeId,
          actorKind: "system_worker",
          actorRef: "session_attention_consumer",
          now: 110,
        });
      } finally {
        consumerStore.close();
      }
      return {
        status: "handoff_accepted",
        sessionKey: "agent:test:ack-race",
        sessionId: "session-ack-race",
        deliveryQueueId: "queue-ack-race",
        duplicate: false,
        immediateAdmission: "queued",
      };
    });

    const result = await runDurableWakeDispatcherOnce({
      store,
      workerId: "worker-ack-race",
      now: 110,
      reconcileOwnerFacts: false,
    });

    expect(result).toMatchObject({
      claimed: 1,
      acknowledged: 1,
      handoffAccepted: 0,
      failed: 0,
      suspended: 0,
    });
    expect(store.getWakeObligation(wake.wakeId)).toMatchObject({ status: "acked" });
    const [attempt] = store.listDeliveryAttemptEvidence({ wakeId: wake.wakeId });
    expect(attempt).toMatchObject({ status: "handoff_accepted" });
    expect(attempt).not.toHaveProperty("deliveryClaimedBy");
    store.close();
  });

  it("marks each unresolved wake overdue once without older diagnostics hiding newer wakes", async () => {
    const store = openDurableRuntimeStore();
    const first = store.createWakeObligation({
      sourceOwner: "session_store",
      sourceRef: "agent:test:first",
      targetKind: "agent_session",
      targetRef: "agent:test:first",
      targetResolutionStatus: "resolved",
      reason: "operator_requested",
      dedupeKey: "sla-first",
      now: 0,
    });
    store.suspendWakeObligation({ wakeId: first.wakeId, failedReason: "test", now: 1 });

    const firstPass = await runDurableWakeDispatcherOnce({
      store,
      workerId: "sla-worker",
      now: 200,
      limit: 1,
      noSilenceSlaMs: 100,
      reconcileOwnerFacts: false,
    });
    expect(firstPass.overdue).toBe(1);

    const second = store.createWakeObligation({
      sourceOwner: "session_store",
      sourceRef: "agent:test:second",
      targetKind: "agent_session",
      targetRef: "agent:test:second",
      targetResolutionStatus: "resolved",
      reason: "operator_requested",
      dedupeKey: "sla-second",
      now: 50,
    });
    store.suspendWakeObligation({ wakeId: second.wakeId, failedReason: "test", now: 51 });

    const secondPass = await runDurableWakeDispatcherOnce({
      store,
      workerId: "sla-worker",
      now: 200,
      limit: 1,
      noSilenceSlaMs: 100,
      reconcileOwnerFacts: false,
    });
    const settledPass = await runDurableWakeDispatcherOnce({
      store,
      workerId: "sla-worker",
      now: 200,
      limit: 1,
      noSilenceSlaMs: 100,
      reconcileOwnerFacts: false,
    });

    expect(secondPass.overdue).toBe(1);
    expect(settledPass.overdue).toBe(0);
    expect(store.getWakeObligation(second.wakeId)?.metadata).toMatchObject({
      diagnostics: { noSilenceSla: { overdue: true, slaMs: 100 } },
    });
    store.close();
  });

  it("suspends on the configured final dispatch attempt without creating a phantom attempt", async () => {
    const entry: SubagentRunRecord = {
      runId: "child-not-ready",
      taskRunId: "child-not-ready",
      childSessionKey: "agent:test:subagent:not-ready",
      requesterSessionKey: "agent:test:main",
      requesterDisplayKey: "test",
      task: "still running",
      cleanup: "keep",
      expectsCompletionMessage: true,
      generation: 1,
      createdAt: 100,
      startedAt: 100,
      execution: { status: "running", startedAt: 100 },
      completion: { required: true },
    };
    saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
    const now = 1_000_000;
    const fact = subagentRunsOwnerAdapter.listAttentionFacts({ now })[0]!;
    const store = openDurableRuntimeStore();
    const wake = store.createWakeObligation({
      sourceOwner: "subagent_runs",
      sourceRef: entry.runId,
      targetKind: fact.targetKind,
      targetRef: fact.targetRef,
      targetResolutionStatus: fact.targetResolutionStatus,
      reason: fact.reason,
      dedupeKey: fact.dedupeKey,
      metadata: { ...fact.metadata, sourceRevision: "stale-revision" },
      now,
    });

    const firstPass = await runDurableWakeDispatcherOnce({
      store,
      workerId: "retry-worker",
      now,
      limit: 1,
      maxAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 1,
      reconcileOwnerFacts: false,
    });
    expect(firstPass).toMatchObject({ claimed: 1, failed: 1, suspended: 0 });
    expect(store.getWakeObligation(wake.wakeId)).toMatchObject({
      status: "failed",
      attemptCount: 1,
    });
    const finalPass = await runDurableWakeDispatcherOnce({
      store,
      workerId: "retry-worker",
      now: now + 10_000,
      limit: 1,
      maxAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 1,
      reconcileOwnerFacts: false,
    });

    expect(finalPass).toMatchObject({ claimed: 1, failed: 0, suspended: 1 });
    expect(store.getWakeObligation(wake.wakeId)).toMatchObject({
      status: "suspended",
      attemptCount: 2,
      failedReason: "wake_retry_limit",
    });
    expect(store.listDeliveryAttemptEvidence({ wakeId: wake.wakeId })).toHaveLength(2);
    store.close();
  });
});
