import path from "node:path";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../../state/agent-deletion-journal.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { clearCronJobActive } from "../active-jobs.js";
import { loadCronStore, saveCronStore } from "../store.js";
import {
  claimCronRunReceiptInDatabase,
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptAsync,
  isCronRunReceiptOwnerStale,
  prepareCronRunReceiptClaim,
  trackCronRunReceiptSettlement,
} from "../store/run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "../store/run-receipt-write-admission.js";
import { listForeignReceipts } from "./foreign-receipt-monitor.js";
import { stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import {
  activateQueuedCronRun,
  cleanupQueuedCronRunReservations,
  executeQueuedCronRun,
  persistQueuedCronRunReservations,
  reserveQueuedCronRun,
  supersedeActivatedCronRun,
} from "./run-admission.js";

async function withReservation(
  run: (fixture: {
    state: ReturnType<typeof createCronRegressionState>;
    job: ReturnType<typeof createDueIsolatedJob>;
    identity: object;
    readReceipt: () => Record<string, unknown> | undefined;
    readJob: () => Promise<ReturnType<typeof createDueIsolatedJob> | undefined>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cron-worker-admission" }, async (fixture) => {
    const now = 1_800_000_000_000;
    const storePath = fixture.statePath("cron", "jobs.json");
    const job = createDueIsolatedJob({ id: "owned-run", nowMs: now, nextRunAtMs: now });
    job.state.lastError = "previous occurrence error";
    const state = createCronRegressionState({
      storePath,
      defaultAgentId: "main",
      nowMs: () => now + 1_000,
      isAgentAvailable: () => true,
      runIsolatedAgentJob: async () => {
        throw new Error("Unexpected payload execution in reservation fixture");
      },
    });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await list(state);
    const [reserved] = await persistQueuedCronRunReservations({
      state,
      candidates: [job],
      reservedAtMs: now,
    });
    if (!reserved) {
      throw new Error("Fixture failed to reserve run");
    }
    const identity = reserveQueuedCronRun(state, job.id, now, { runReceipt: reserved.runReceipt });
    const db = openOpenClawStateDatabase();
    expect(db.path.startsWith(fixture.stateDir)).toBe(true);
    try {
      await run({
        state,
        job,
        identity,
        readJob: async () => (await loadCronStore(storePath)).jobs.find((row) => row.id === job.id),
        readReceipt: () =>
          db.db
            .prepare(
              "SELECT status, started_at_ms, error_text FROM cron_run_receipts WHERE receipt_id = ?",
            )
            .get(reserved.runReceipt.receiptId),
      });
    } finally {
      await cleanupQueuedCronRunReservations({
        state,
        reservations: [...state.queuedRunReservationsByJobId].map(([jobId, reservation]) => ({
          jobId,
          reservationIdentity: reservation.identity,
        })),
      });
      stop(state);
      await state.op;
    }
  });
}

function duringPreparation(
  matches: (value: Record<string, unknown>) => boolean,
  mutate: () => void,
) {
  // oxlint-disable-next-line typescript/unbound-method -- Retain the intercepted port as receiver.
  const original = MessagePort.prototype.postMessage;
  let observed = false;
  const spy = vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
    this: MessagePort,
    value,
    transferList,
  ) {
    if (!observed && isRecord(value) && matches(value)) {
      observed = true;
      mutate();
    }
    return original.call(this, value, transferList);
  });
  return { restore: () => spy.mockRestore(), observed: () => observed };
}

it("fences an activation whose durable receipt was replaced after reservation", async () => {
  await withReservation(async ({ state, job, identity, readJob, readReceipt }) => {
    const original = state.queuedRunReservationsByJobId.get(job.id)!.runReceipt;
    await finishCronRunReceiptAsync({
      handle: original,
      status: "interrupted",
      finishedAtMs: state.deps.nowMs(),
    });
    const prepared = prepareCronRunReceiptClaim({
      storePath: state.deps.storePath,
      job,
      agentId: original.agentId,
      startedAtMs: original.startedAtMs,
    });
    const replacement = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabase({
        database: db,
        receiptSchema: prepareCronRunReceiptWriteSchema(db),
        prepared,
        resolveAgentId: () => original.agentId,
      }),
    );
    try {
      const before = await readJob();
      const receiptBefore = readReceipt();
      await expect(
        activateQueuedCronRun({ state, job, reservationIdentity: identity }),
      ).resolves.toEqual({ kind: "fenced" });
      expect(await readJob()).toEqual(before);
      expect(readReceipt()).toEqual(receiptBefore);
      expect(
        findActiveCronRunReceiptInDatabase({
          database: openOpenClawStateDatabase().db,
          storePath: state.deps.storePath,
          jobId: job.id,
        }),
      ).toEqual(replacement);
      expect(listForeignReceipts(state)).toEqual([]);
    } finally {
      await finishCronRunReceiptAsync({
        handle: replacement,
        status: "skipped",
        finishedAtMs: state.deps.nowMs(),
      });
    }
  });
});

it("rejects payload execution when its agent becomes unavailable during worker activation", async () => {
  await withReservation(async ({ state, job, identity }) => {
    let available = true;
    state.deps.isAgentAvailable = () => available;
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    state.deps.runIsolatedAgentJob = runner;
    const interception = duringPreparation(
      (value) => "markerAtMs" in value,
      () => {
        available = false;
      },
    );
    let activeMarker: Parameters<typeof clearCronJobActive>[1];
    try {
      const result = await executeQueuedCronRun({
        state,
        jobId: job.id,
        reservedAtMs: state.queuedRunReservationsByJobId.get(job.id)!.markerAtMs,
        reservationIdentity: identity,
        onNotRunnable: async () => {},
        onCompleted: async (outcome) => {
          activeMarker = outcome.activeJobMarker;
          return false;
        },
      });
      expect(interception.observed()).toBe(true);
      expect(result).toMatchObject({
        kind: "completed",
        outcome: {
          status: "error",
          error: "cron job agent is unavailable: main",
          receiptSettlementDisposition: "owner-unavailable",
        },
      });
      expect(runner).not.toHaveBeenCalled();
    } finally {
      interception.restore();
      if (activeMarker) {
        clearCronJobActive(job.id, activeMarker);
      }
    }
  });
});

it("fences a replacement local owner between worker preparation and activation commit", async () => {
  await withReservation(async ({ state, job, identity, readJob, readReceipt }) => {
    const before = await readJob();
    const receiptBefore = readReceipt();
    const owner = state.queuedRunReservationsByJobId.get(job.id)!;
    let replacement: object | undefined;
    const interception = duringPreparation(
      (value) => "markerAtMs" in value,
      () => {
        replacement = reserveQueuedCronRun(state, job.id, owner.markerAtMs, {
          runReceipt: owner.runReceipt,
        });
      },
    );
    try {
      await expect(
        activateQueuedCronRun({ state, job, reservationIdentity: identity }),
      ).resolves.toEqual({ kind: "fenced" });
      expect(interception.observed()).toBe(true);
      expect(state.queuedRunReservationsByJobId.get(job.id)?.identity).toBe(replacement);
      expect(await readJob()).toEqual(before);
      expect(readReceipt()).toEqual(receiptBefore);
    } finally {
      interception.restore();
    }
  });
});

it("restores the exact activated marker when the service stops during worker admission", async () => {
  await withReservation(async ({ state, job, identity, readJob, readReceipt }) => {
    const interception = duringPreparation(
      (value) => "markerAtMs" in value,
      () => stop(state),
    );
    try {
      await expect(
        activateQueuedCronRun({ state, job, reservationIdentity: identity }),
      ).resolves.toEqual({ kind: "unavailable", reason: "stopped" });
      expect(interception.observed()).toBe(true);
      const persisted = await readJob();
      expect(persisted?.state.lastError).toBe("previous occurrence error");
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(persisted?.state.queuedAtMs).toBeUndefined();
      expect(readReceipt()).toMatchObject({
        status: "skipped",
        error_text: "cron service stopped",
      });
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
    } finally {
      interception.restore();
    }
  });
});

it.each(["before commit", "after publication"] as const)(
  "retains the runner fence when settlement completes %s",
  async (timing) => {
    await withReservation(async ({ state, job, identity, readJob, readReceipt }) => {
      const activated = await activateQueuedCronRun({ state, job, reservationIdentity: identity });
      if (activated.kind !== "activated") {
        throw new Error("Fixture activation failed");
      }
      const runner = createDeferred();
      const finishErrors: unknown[] = [];
      trackCronRunReceiptSettlement({
        handle: activated.runReceipt,
        settlement: runner.promise,
        onFinishError: (error) => finishErrors.push(error),
      });
      const interception = duringPreparation(
        (value) => Array.isArray(value.reservations),
        () => {
          if (timing === "before commit") {
            runner.resolve();
          }
        },
      );
      try {
        await supersedeActivatedCronRun({
          state,
          jobId: job.id,
          reservationIdentity: identity,
          runReceipt: activated.runReceipt,
          reason: "retired occurrence",
        });
        expect(interception.observed()).toBe(true);
        if (timing === "after publication") {
          expect(readReceipt()).toMatchObject({ status: "running" });
          runner.resolve();
        }
        await runner.promise;
        const persisted = await readJob();
        expect(persisted?.state.runningAtMs).toBeUndefined();
        expect(readReceipt()).toMatchObject({
          status: "superseded",
          error_text: "retired occurrence",
        });
        expect(finishErrors).toEqual([]);
      } finally {
        interception.restore();
        runner.resolve();
        await runner.promise;
        await readJob();
      }
    });
  },
);

it("publishes cleanup once without replay after a committed reply is lost", async () => {
  await withReservation(async ({ state, job, identity, readJob, readReceipt }) => {
    const reply = loseFirstCronMutationReply("cron.releaseReservations");
    try {
      await expect(
        cleanupQueuedCronRunReservations({
          state,
          reservations: [{ jobId: job.id, reservationIdentity: identity }],
        }),
      ).rejects.toBeInstanceOf(Error);
      await reply.waitForExit();
      expect(reply.wasDropped()).toBe(true);
      expect(reply.attempts).toEqual(["cron.releaseReservations"]);
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect((await readJob())?.state.queuedAtMs).toBeUndefined();
      expect(readReceipt()).toMatchObject({ status: "skipped" });
    } finally {
      await reply.close();
    }
  });
});

it("preserves durable deletion authority during stopped activation rollback", async () => {
  await withReservation(async ({ state, job, identity, readJob, readReceipt }) => {
    const privateRoot = path.dirname(path.dirname(state.deps.storePath));
    beginAgentDeletionJournal({
      agentId: "main",
      operationId: "private-delete-main",
      deleteFiles: false,
      agentDir: path.join(privateRoot, "agents", "main", "agent"),
      workspaceDir: path.join(privateRoot, "workspace"),
      sessionsDir: path.join(privateRoot, "agents", "main", "sessions"),
    });
    const interception = duringPreparation(
      (value) => "markerAtMs" in value,
      () => stop(state),
    );
    try {
      await expect(
        activateQueuedCronRun({ state, job, reservationIdentity: identity }),
      ).rejects.toThrow("cron job agent is unavailable: main");
      expect(interception.observed()).toBe(true);
      expect((await readJob())?.state.runningAtMs).toBe(1_800_000_001_000);
      expect(readReceipt()).toMatchObject({ status: "running" });
    } finally {
      interception.restore();
      removeAgentDeletionJournal("main", "private-delete-main");
    }
  });
});

it("releases a settled receipt for recovery when its captured database admission retires", async () => {
  await withReservation(async ({ state, job }) => {
    const handle = state.queuedRunReservationsByJobId.get(job.id)!.runReceipt;
    const context = captureOpenClawStateWorkerContext();
    expect(isCronRunReceiptOwnerStale(handle)).toBe(false);
    await closeOpenClawStateDatabaseAsync();
    await expect(
      finishCronRunReceiptAsync(
        { handle, status: "skipped", finishedAtMs: 1_800_000_001_000 },
        context,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(isCronRunReceiptOwnerStale(handle)).toBe(true);
  });
});
