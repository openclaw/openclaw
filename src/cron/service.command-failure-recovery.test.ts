import { describe, expect, it, vi } from "vitest";
import {
  loseFirstCronMutationReply,
  observeCronStoreCommits,
  terminateFirstCronMutationBeforeCommit,
} from "../../test/helpers/cron/runtime-mutation.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  cronCreateMatchesCallerScope,
  cronJobMatchesCallerScope,
} from "../gateway/server-methods/cron-caller-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { toPublicCronJob } from "./public-job.js";
import { readCronRunRecordsForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { applyJobPatch } from "./service/jobs.js";
import {
  makeCronRecoveryState,
  claimCronRecoveryReceipt,
  observeCronRecoveryForTest,
  recoverCronRunForTest,
} from "./service/run-recovery.test-support.js";
import * as runtimeMutation from "./service/runtime-mutation.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { recordCronRun } from "./store/run-history.js";
import {
  finishCronRunReceiptAsync,
  releaseLocalCronRunReceiptOwnership,
} from "./store/run-receipt-store.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-command-recovery-",
  baseTimeIso: "2026-10-08T00:00:00.000Z",
});

function input(): CronJobCreate {
  return {
    name: "private command label",
    enabled: true,
    agentId: "main",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "command", argv: ["PRIVATE_ARGV"], env: { PRIVATE_ENV: "secret" } },
    delivery: { mode: "none" },
    failureAlert: false,
    failureRecovery: {
      agentId: "main",
      message: "Repair the authorized fixture only.",
      toolsAllow: ["read", "write"],
      timeoutSeconds: 30,
    },
  };
}

async function fixture(automatic = false) {
  const { storePath } = await makeStorePath();
  const command = vi.fn<NonNullable<ConstructorParameters<typeof CronService>[0]["runCommandJob"]>>(
    async () => ({
      status: "error" as const,
      error: "PRIVATE_ERROR",
      failureNotificationDetail: { kind: "command-exit" as const, exitCode: 23 },
    }),
  );
  const agent = vi.fn<
    NonNullable<ConstructorParameters<typeof CronService>[0]["runIsolatedAgentJob"]>
  >(async () => ({ status: "ok" as const, summary: "NO_REPLY" }));
  const alert = vi.fn();
  const create = () =>
    new CronService({
      storePath,
      scheduler: createTestGatewayScheduler(automatic ? "fake-timers" : undefined),
      nowMs: () => Date.now(),
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runCommandJob: command,
      runIsolatedAgentJob: agent,
      sendCronFailureAlert: alert,
    });
  const cron = create();
  const job = await cron.add(input());
  return { cron, create, job, storePath, command, agent, alert };
}

describe("native command failure recovery", () => {
  it("does not rearm while the prior child's exact receipt is still running", async () => {
    const box = await fixture();
    await box.cron.update(box.job.id, {
      failureRecovery: { ...input().failureRecovery!, timeoutSeconds: 1 },
    });
    await box.cron.run(box.job.id, "force");
    const childId = box.cron.getJob(box.job.id)!.state.failureRecovery!.jobId;
    const entered = createDeferred();
    const child = createDeferred<{ status: "ok" }>();
    box.agent.mockImplementationOnce(({ onExecutionStarted }) => {
      onExecutionStarted?.();
      entered.resolve();
      return child.promise;
    });
    const finishes: Promise<void>[] = [];
    const finishStarted = createDeferred();
    const execute = runtimeMutation.runCronRuntimeMutation;
    const mutation = vi
      .spyOn(runtimeMutation, "runCronRuntimeMutation")
      .mockImplementation((params) => {
        const finished = execute(params);
        if (params.type === "cron.finishReceipt") {
          finishes.push(finished);
          finishStarted.resolve();
        }
        return finished;
      });
    const run = box.cron.run(childId, "force");
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(20_000);
      await run;
      expect(
        inspectActiveCronRunReceipt({ storePath: box.storePath, jobId: childId }),
      ).toBeDefined();
      expect(box.cron.getJob(childId)!.state.runningAtMs).toBeUndefined();
      expect(box.cron.getJob(childId)!.enabled).toBe(false);
      box.command.mockResolvedValueOnce({ status: "ok" });
      await box.cron.run(box.job.id, "force");
      expect(box.cron.getJob(box.job.id)!.state.failureRecovery!.recoveredAtMs).toBeDefined();
      await box.cron.run(box.job.id, "force");
      expect((await loadCronStore(box.storePath)).jobs).toHaveLength(2);
      child.resolve({ status: "ok" });
      await finishStarted.promise;
      await Promise.allSettled(finishes);
      expect(
        inspectActiveCronRunReceipt({ storePath: box.storePath, jobId: childId }),
      ).toBeUndefined();
      await box.cron.run(box.job.id, "force");
      expect((await loadCronStore(box.storePath)).jobs).toHaveLength(3);
    } finally {
      child.resolve({ status: "ok" });
      await run;
      await finishStarted.promise;
      await Promise.allSettled(finishes);
      mutation.mockRestore();
      box.cron.stop();
    }
  });

  it.each(["error", "lost-ack", "rollback", "stale-policy", "disabled"] as const)(
    "waits for command settlement before recovery admission: %s",
    async (transition) => {
      const box = await fixture(true);
      await box.cron.update(box.job.id, {
        payload: { kind: "command", argv: ["fixture"], timeoutSeconds: 1 },
      });
      const admitsRecovery =
        transition === "error" || transition === "lost-ack" || transition === "rollback";
      if (admitsRecovery) {
        await box.cron.start();
      }
      const entered = createDeferred();
      const command = createDeferred<{ status: "error"; error: string } | { status: "ok" }>();
      box.command.mockImplementationOnce(() => {
        entered.resolve();
        return command.promise;
      });
      const finishes: Promise<void>[] = [];
      const finishStarted = createDeferred();
      const retryStarted = createDeferred();
      let lost: ReturnType<typeof loseFirstCronMutationReply> | undefined;
      let publications = 0;
      let stopObserving: (() => void) | undefined;
      const execute = runtimeMutation.runCronRuntimeMutation;
      const mutation = vi
        .spyOn(runtimeMutation, "runCronRuntimeMutation")
        .mockImplementation((params) => {
          const finished = execute(params);
          if (params.type === "cron.finishReceipt") {
            finishes.push(finished);
            finishStarted.resolve();
            if (finishes.length === 2) {
              retryStarted.resolve();
            }
          }
          return finished;
        });
      const run = box.cron.run(box.job.id, "force");
      try {
        await entered.promise;
        const receipt = inspectActiveCronRunReceipt({
          storePath: box.storePath,
          jobId: box.job.id,
        })!;
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(20_000);
        await run;
        expect(
          inspectActiveCronRunReceipt({ storePath: box.storePath, jobId: box.job.id })?.receiptId,
        ).toBe(receipt.receiptId);
        expect((await loadCronStore(box.storePath)).jobs).toHaveLength(1);
        expect(box.cron.getJob(box.job.id)!.state.failureRecovery).toBeUndefined();
        expect(box.agent).not.toHaveBeenCalled();
        expect(readCronRunRecordsForTests(box.job.id)[0]?.detail).toMatchObject({
          completionStatus: "failed",
        });
        if (transition === "stale-policy") {
          await box.cron.update(box.job.id, {
            failureRecovery: { ...input().failureRecovery!, message: "New policy" },
          });
        }
        if (transition === "disabled") {
          await box.cron.update(
            box.job.id,
            { enabled: false },
            {
              preserveRunning: true,
              expectedConfigRevision: resolveCronJobConfigRevision(box.cron.getJob(box.job.id)!),
            },
          );
        }
        stopObserving = observeCronStoreCommits(box.storePath, () => {
          publications += 1;
        });
        if (transition === "lost-ack") {
          lost = loseFirstCronMutationReply("cron.finishReceipt");
        }
        if (transition === "rollback") {
          openOpenClawStateDatabase().db.exec(`
          CREATE TRIGGER reject_recovery_child AFTER INSERT ON cron_jobs
          WHEN NEW.job_id != '${box.job.id}'
          BEGIN SELECT RAISE(ABORT, 'recovery child temporarily unavailable'); END;
        `);
        }
        command.resolve(
          transition === "error"
            ? { status: "ok" }
            : { status: "error", error: "late underlying failure" },
        );
        await finishStarted.promise;
        if (transition === "rollback") {
          expect((await Promise.allSettled(finishes))[0]?.status).toBe("rejected");
          expect(
            inspectActiveCronRunReceipt({ storePath: box.storePath, jobId: box.job.id })?.receiptId,
          ).toBe(receipt.receiptId);
          expect((await loadCronStore(box.storePath)).jobs).toHaveLength(1);
          expect(publications).toBe(0);
          openOpenClawStateDatabase().db.exec("DROP TRIGGER reject_recovery_child");
          await vi.advanceTimersByTimeAsync(1_000);
          await retryStarted.promise;
        }
        const settled = await Promise.allSettled(finishes);
        expect(settled.at(-1)?.status === "fulfilled" || lost !== undefined).toBe(true);
        expect(
          inspectActiveCronRunReceipt({ storePath: box.storePath, jobId: box.job.id }),
        ).toBeUndefined();
        const store = await loadCronStore(box.storePath);
        expect(store.jobs).toHaveLength(admitsRecovery ? 2 : 1);
        const parent = store.jobs.find((job) => job.id === box.job.id)!;
        expect(parent.state.lastRunStatus).toBe("error");
        expect(parent.state.lastError).toBe("cron: job execution timed out");
        if (lost) {
          expect(lost.wasDropped()).toBe(true);
        }
        if (admitsRecovery) {
          expect(publications).toBeGreaterThan(0);
        }
        if (admitsRecovery) {
          const child = store.jobs.find((job) => job.state.commandRecoveryOrigin)!;
          expect(child.state.commandRecoveryOrigin?.failedReceiptId).toBe(receipt.receiptId);
          await finishCronRunReceiptAsync({
            handle: receipt,
            status: "error",
            finishedAtMs: Date.now(),
          });
          expect((await loadCronStore(box.storePath)).jobs).toHaveLength(2);
          const agentStarted = createDeferred();
          box.agent.mockImplementationOnce(async () => {
            agentStarted.resolve();
            return { status: "ok" };
          });
          // Existing native timer/revision refresh must discover the late child.
          // No force-run or added wake-up creates its first execution.
          await vi.advanceTimersByTimeAsync(60_000);
          await agentStarted.promise;
          expect(box.agent).toHaveBeenCalledOnce();
          box.cron.stop();
          const restarted = box.create();
          try {
            await restarted.run(child.id, "force");
            expect(box.agent).toHaveBeenCalledOnce();
          } finally {
            restarted.stop();
          }
        }
      } finally {
        command.resolve({ status: "error", error: "cleanup" });
        await run;
        await Promise.allSettled(finishes);
        await lost?.close();
        stopObserving?.();
        openOpenClawStateDatabase().db.exec("DROP TRIGGER IF EXISTS reject_recovery_child");
        mutation.mockRestore();
        box.cron.stop();
      }
    },
  );

  it("does not verify an incident with success from a superseded command definition", async () => {
    const box = await fixture();
    await box.cron.run(box.job.id, "force");
    await box.cron.run(box.cron.getJob(box.job.id)!.state.failureRecovery!.jobId, "force");
    const entered = createDeferred();
    const release = createDeferred<{ status: "ok" }>();
    box.command.mockImplementationOnce(async () => {
      entered.resolve();
      return await release.promise;
    });
    const run = box.cron.run(box.job.id, "force");
    await entered.promise;
    await box.cron.update(box.job.id, {
      failureRecovery: { ...input().failureRecovery!, message: "New policy" },
    });
    release.resolve({ status: "ok" });
    await run;
    expect(box.cron.getJob(box.job.id)!.state.failureRecovery!.recoveredAtMs).toBeUndefined();
    await box.cron.run(box.job.id, "force");
    expect((await loadCronStore(box.storePath)).jobs).toHaveLength(2);
    box.command.mockResolvedValueOnce({ status: "ok" });
    await box.cron.run(box.job.id, "force");
    expect(box.cron.getJob(box.job.id)!.state.failureRecovery!.recoveredAtMs).toBeDefined();
    box.cron.stop();
  });
  it("fences an old running command when only the recovery policy changes", async () => {
    const box = await fixture();
    const entered = createDeferred();
    const release = createDeferred<{ status: "error"; error: string }>();
    box.command.mockImplementationOnce(async () => {
      entered.resolve();
      return await release.promise;
    });
    const oldRevision = resolveCronJobConfigRevision(box.job);
    const run = box.cron.run(box.job.id, "force");
    await entered.promise;
    await box.cron.update(box.job.id, {
      failureRecovery: { ...input().failureRecovery!, message: "Replacement policy" },
    });
    expect(resolveCronJobConfigRevision(box.cron.getJob(box.job.id)!)).not.toBe(oldRevision);
    release.resolve({ status: "error", error: "old definition failed" });
    await run;
    expect((await loadCronStore(box.storePath)).jobs).toHaveLength(1);
    expect(box.cron.getJob(box.job.id)!.state.lastRunStatus).toBe("error");
    await box.cron.run(box.job.id, "force");
    expect((await loadCronStore(box.storePath)).jobs).toHaveLength(2);
    box.cron.stop();
  });

  it("records an unknown interrupted command without admitting corrective work", async () => {
    const box = await fixture();
    box.cron.stop();
    const store = await loadCronStore(box.storePath);
    const job = store.jobs[0]!;
    job.state.runningAtMs = Date.now() - 1000;
    await saveCronStore(box.storePath, store);
    const receipt = claimCronRecoveryReceipt(box.storePath, job, job.state.runningAtMs, "main");
    releaseLocalCronRunReceiptOwnership(receipt);
    const state = makeCronRecoveryState(logger, box.storePath, Date.now());
    const proposal = await observeCronRecoveryForTest(
      state,
      job.id,
      undefined,
      job.state.runningAtMs,
    );
    await recoverCronRunForTest(state, proposal, "startup");
    const persisted = await loadCronStore(box.storePath);
    expect(persisted.jobs).toHaveLength(1);
    expect(persisted.jobs[0]!.state.lastRunStatus).toBe("error");
    expect(persisted.jobs[0]!.state.failureRecovery).toBeUndefined();
  });

  it("retains one failed-parent child when the real finalization worker loses its committed reply", async () => {
    const box = await fixture();
    const fault = loseFirstCronMutationReply("cron.finalizeRuns");
    try {
      await box.cron.run(box.job.id, "force").catch(() => undefined);
      expect(fault.wasDropped()).toBe(true);
      await fault.waitForExit();
    } finally {
      await fault.close();
      box.cron.stop();
    }
    const store = await loadCronStore(box.storePath);
    expect(store.jobs).toHaveLength(2);
    expect(store.jobs.find((job) => job.id === box.job.id)!.state.lastError).toBe("PRIVATE_ERROR");
    const restarted = box.create();
    await restarted.run(box.job.id, "force");
    expect((await loadCronStore(box.storePath)).jobs).toHaveLength(2);
    restarted.stop();
  });

  it("does not restart a child after native start and actual finalization worker death", async () => {
    const box = await fixture();
    await box.cron.run(box.job.id, "force");
    const childId = box.cron.getJob(box.job.id)!.state.failureRecovery!.jobId;
    await closeOpenClawStateDatabaseAsync();
    const fault = terminateFirstCronMutationBeforeCommit("cron.finalizeRuns");
    try {
      await box.cron.run(childId, "force").catch(() => undefined);
    } finally {
      await fault.close();
      box.cron.stop();
    }
    expect(fault.wasHeld()).toBe(true);
    expect(box.agent).toHaveBeenCalledOnce();
    const restarted = box.create();
    await restarted.start();
    await restarted.run(childId, "force");
    expect(box.agent).toHaveBeenCalledOnce();
    expect(restarted.getJob(childId)!.state.commandRecoveryOrigin!.startedAtMs).toBeDefined();
    restarted.stop();
  });

  it("rejects an unavailable recovery agent before healthy command admission", async () => {
    const { storePath } = await makeStorePath();
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath,
      nowMs: () => Date.now(),
      log: logger,
      isAgentAvailable: (id) => id === "main",
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await expect(
      cron.add({
        ...input(),
        failureRecovery: { ...input().failureRecovery!, agentId: "missing" },
      }),
    ).rejects.toThrow("recovery agent is unavailable");
    expect((await loadCronStore(storePath)).jobs).toHaveLength(0);
    cron.stop();
  });

  it.each(["error", "ok"] as const)(
    "restores an exact finalized %s command after worker death",
    async (status) => {
      const box = await fixture();
      if (status === "ok") {
        await box.cron.run(box.job.id, "force");
        await box.cron.run(box.cron.getJob(box.job.id)!.state.failureRecovery!.jobId, "force");
        box.command.mockResolvedValueOnce({ status: "ok" });
      }
      await closeOpenClawStateDatabaseAsync();
      const fault = terminateFirstCronMutationBeforeCommit("cron.finalizeRuns");
      try {
        await box.cron.run(box.job.id, "force").catch(() => undefined);
      } finally {
        await fault.close();
        box.cron.stop();
      }
      expect(fault.wasHeld()).toBe(true);
      if (status === "ok") {
        // Restore a real finalized legacy success without additive completionStatus.
        const record = readCronRunRecordsForTests(box.job.id).find(
          (current) => current.status === "succeeded",
        )!;
        if (!record.detail || typeof record.detail !== "object" || Array.isArray(record.detail)) {
          throw new Error("missing native history detail");
        }
        const detail = { ...record.detail };
        delete detail.completionStatus;
        await recordCronRun({
          storeKey: cronStoreKey(box.storePath),
          jobId: box.job.id,
          runId: record.runId!,
          startedAt: record.startedAt!,
          endedAt: record.endedAt!,
          status: record.status,
          detail,
        });
      }
      const restarted = box.create();
      await restarted.start();
      const parent = restarted.getJob(box.job.id)!;
      expect(parent.state.lastRunStatus).toBe(status);
      expect((await loadCronStore(box.storePath)).jobs).toHaveLength(2);
      if (status === "ok") {
        expect(parent.state.failureRecovery!.recoveredAtMs).toBeDefined();
      } else {
        expect(parent.state.lastError).toBe("PRIVATE_ERROR");
      }
      restarted.stop();
    },
  );
  it("runs healthy commands without model turns and atomically retains one silent recovery for changed errors", async () => {
    const box = await fixture();
    box.command.mockResolvedValueOnce({ status: "ok" });
    await box.cron.run(box.job.id, "force");
    expect(box.agent).not.toHaveBeenCalled();
    expect((await loadCronStore(box.storePath)).jobs).toHaveLength(1);
    await box.cron.run(box.job.id, "force");
    const stored = await loadCronStore(box.storePath);
    const parent = stored.jobs.find((job) => job.id === box.job.id)!;
    const child = stored.jobs.find((job) => job.id === parent.state.failureRecovery?.jobId)!;
    expect(parent.state.lastRunStatus).toBe("error");
    expect(parent.state.lastError).toBe("PRIVATE_ERROR");
    expect(child).not.toHaveProperty("owner");
    expect(child).toMatchObject({
      deleteAfterRun: false,
      delivery: { mode: "none" },
      failureAlert: false,
    });
    expect(child.payload).toMatchObject({
      kind: "agentTurn",
      timeoutSeconds: 30,
      toolsAllow: ["read", "write"],
    });
    if (child.payload.kind !== "agentTurn") {
      throw new Error("missing agent recovery");
    }
    expect(child.payload.message).not.toMatch(
      /PRIVATE_ARGV|PRIVATE_ENV|PRIVATE_ERROR|private command label/,
    );
    expect(child.state.commandRecoveryOrigin).toMatchObject({
      jobId: parent.id,
      failedReceiptId: parent.state.failureRecovery?.failedReceiptId,
    });
    box.command.mockResolvedValueOnce({ status: "error", error: "different cause" });
    await Promise.all([box.cron.run(parent.id, "force"), box.cron.run(parent.id, "force")]);
    expect((await loadCronStore(box.storePath)).jobs).toHaveLength(2);
    expect(box.alert).not.toHaveBeenCalled();
    box.cron.stop();
  });

  it("consumes one native child start, never retries its provider failure, and preserves parent failure", async () => {
    const box = await fixture();
    await box.cron.run(box.job.id, "force");
    const childId = box.cron.getJob(box.job.id)!.state.failureRecovery!.jobId;
    box.agent.mockResolvedValueOnce({ status: "error", error: "provider temporarily unavailable" });
    await box.cron.run(childId, "force");
    const child = box.cron.getJob(childId)!;
    expect(child.state.commandRecoveryOrigin?.startedAtMs).toBeDefined();
    expect(child.enabled).toBe(false);
    expect(child.state.nextRunAtMs).toBeUndefined();
    await box.cron.run(childId, "force");
    expect(box.agent).toHaveBeenCalledOnce();
    expect(box.cron.getJob(box.job.id)!.state.lastRunStatus).toBe("error");
    expect(box.cron.getJob(box.job.id)!.state.failureRecovery?.recoveredAtMs).toBeUndefined();
    box.cron.stop();
  });

  it("retains a committed child across service restart and model callers cannot see or edit its cap", async () => {
    const box = await fixture();
    await box.cron.run(box.job.id, "force");
    const childId = box.cron.getJob(box.job.id)!.state.failureRecovery!.jobId;
    const child = box.cron.getJob(childId)!;
    const scope = {
      kind: "agentTool" as const,
      agentId: "main",
      sessionKey: "agent:main:main",
      accountId: "fixture",
    };
    expect(cronJobMatchesCallerScope({ job: child, callerScope: scope })).toBe(false);
    expect(cronCreateMatchesCallerScope({ job: input(), callerScope: scope })).toBe(false);
    const origin = structuredClone(child.state.commandRecoveryOrigin);
    const hostileState = { lastError: "fixture", commandRecoveryOrigin: undefined };
    applyJobPatch(child, { state: hostileState });
    expect(child.state.commandRecoveryOrigin).toEqual(origin);
    expect(toPublicCronJob(child).state.commandRecoveryOrigin).toEqual(origin);
    box.cron.stop();
    const restarted = box.create();
    await restarted.run(box.job.id, "force");
    expect(restarted.getJob(box.job.id)!.state.failureRecovery!.jobId).toBe(childId);
    expect((await loadCronStore(box.storePath)).jobs).toHaveLength(2);
    restarted.stop();
  });

  it("keeps one active owner after parent success, rearms only after the child settles", async () => {
    const box = await fixture();
    await box.cron.run(box.job.id, "force");
    const childId = box.cron.getJob(box.job.id)!.state.failureRecovery!.jobId;
    const started = createDeferred();
    const release = createDeferred<{ status: "ok" }>();
    box.agent.mockImplementationOnce(async () => {
      started.resolve();
      return await release.promise;
    });
    const run = box.cron.run(childId, "force");
    await started.promise;
    box.command.mockResolvedValueOnce({ status: "ok" });
    await box.cron.run(box.job.id, "force");
    expect(box.cron.getJob(box.job.id)!.state.failureRecovery!.recoveredAtMs).toBeDefined();
    await box.cron.run(box.job.id, "force");
    expect((await loadCronStore(box.storePath)).jobs).toHaveLength(2);
    release.resolve({ status: "ok" });
    await run;
    await box.cron.run(box.job.id, "force");
    expect((await loadCronStore(box.storePath)).jobs).toHaveLength(3);
    box.cron.stop();
  });

  it("refuses a pending repair when its parent definition was replaced", async () => {
    const box = await fixture();
    await box.cron.run(box.job.id, "force");
    const childId = box.cron.getJob(box.job.id)!.state.failureRecovery!.jobId;
    await box.cron.update(box.job.id, { payload: { kind: "command", argv: ["replacement"] } });
    await box.cron.run(childId, "force");
    expect(box.agent).not.toHaveBeenCalled();
    expect(
      (await loadCronStore(box.storePath)).jobs.find((job) => job.id === childId),
    ).toMatchObject({ enabled: false, state: { lastRunStatus: "skipped" } });
    box.cron.stop();
  });

  it("does not replay a consumed child after restart even when no delivery started", async () => {
    const box = await fixture();
    await box.cron.run(box.job.id, "force");
    const store = await loadCronStore(box.storePath);
    const child = store.jobs.find((job) => job.state.commandRecoveryOrigin)!;
    child.state.commandRecoveryOrigin!.startedAtMs = Date.now();
    child.state.runningAtMs = Date.now();
    box.cron.stop();
    await saveCronStore(box.storePath, store);
    const restarted = box.create();
    await restarted.start();
    expect(restarted.getJob(child.id)!.enabled).toBe(false);
    await restarted.run(child.id, "force");
    expect(box.agent).not.toHaveBeenCalled();
    restarted.stop();
  });
});
