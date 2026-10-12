import { setImmediate as nextTurn } from "node:timers/promises";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../../test-utils/state-database-contention.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { createCronScheduledRunId } from "../store/run-request-id.js";
import { stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";
import * as runtimeMutation from "./runtime-mutation.js";

async function whileContended<T>(
  databasePath: string,
  type: string,
  action: () => Promise<T>,
): Promise<T> {
  const holder = holdStateDatabaseWriteTransaction(databasePath);
  const posted = createDeferred();
  let pending: Promise<T> | undefined;
  let settled = false;
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the real Worker receiver.
  const nativePost = Worker.prototype.postMessage;
  const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    const command: unknown = request.type === "execute" ? deserialize(request.input) : undefined;
    nativePost.call(this, request, transferList);
    if (isRecord(command) && command.type === type) {
      posted.resolve();
    }
  });
  try {
    await holder.ready;
    pending = action();
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.race([
      posted.promise,
      pending.then(() => {
        throw new Error(`${type} completed without dispatch`);
      }),
    ]);
    await nextTurn();
    expect(
      Atomics.load(holder.released, 0),
      "gateway event loop runs after dispatch while the database remains held",
    ).toBe(0);
    expect(settled).toBe(false);
    holder.release();
    return await pending;
  } finally {
    holder.release();
    await holder.joined;
    await pending?.catch(() => undefined);
    post.mockRestore();
  }
}

it("keeps Gateway events responsive through request, activation and cancellation writes", async () => {
  await withOpenClawTestState({ label: "cron-queue-contention" }, async (fixture) => {
    const now = 1_800_000_000_000;
    const storeKey = fixture.statePath("cron", "jobs.json");
    const job = createDueIsolatedJob({ id: "contended-request", nowMs: now, nextRunAtMs: now });
    job.agentId = "main";
    job.payload = { kind: "command", argv: ["echo", "synthetic"] };
    await saveCronStore(storeKey, { version: 1, jobs: [job] });
    const context = captureOpenClawStateWorkerContext();
    await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
    const receiptId = createCronScheduledRunId(storeKey, job.id, now);
    const request = await whileContended(context.admission.databasePath, "cron.requestRuns", () =>
      executeOpenClawStateWorker(context, {
        type: "cron.requestRuns",
        input: {
          storeKey,
          nowMs: now,
          defaultAgentId: "main",
          requests: [
            {
              jobId: job.id,
              receiptId,
              configRevision: resolveCronJobConfigRevision(job),
              scheduledSlotMs: now,
              mode: "scheduled",
            },
          ],
        },
      }),
    );
    expect(request.accepted).toHaveLength(1);
    const active = await whileContended(context.admission.databasePath, "cron.drainQueue", () =>
      executeOpenClawStateWorker(context, {
        type: "cron.drainQueue",
        input: { storeKey, nowMs: now + 1, maxConcurrentRuns: 1, requests: [] },
      }),
    );
    expect(active.launches).toHaveLength(1);
    const cancelled = await whileContended(
      context.admission.databasePath,
      "cron.cancelRequests",
      () =>
        executeOpenClawStateWorker(context, {
          type: "cron.cancelRequests",
          input: {
            storeKey,
            nowMs: now + 2,
            receiptIds: [receiptId],
            reason: "synthetic cancellation",
          },
        }),
    );
    expect(cancelled.skipped).toHaveLength(1);
  });
});

it("services Gateway events while manual finalization waits for a writer", async () => {
  await withOpenClawTestState({ label: "cron-finalization-contention" }, async (fixture) => {
    const now = Date.now();
    const storePath = fixture.statePath("cron", "jobs.json");
    const job = createDueIsolatedJob({
      id: "contended-finalization",
      nowMs: now - 2000,
      nextRunAtMs: now - 1000,
    });
    job.payload = { kind: "command", argv: ["echo", "synthetic"] };
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      storePath,
      nowMs: () => now,
      defaultAgentId: "main",
      isAgentAvailable: () => true,
      runCommandJob: runner,
      runIsolatedAgentJob: runner,
    });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await list(state);
    const execute = runtimeMutation.runCronRuntimeMutation;
    let observed = 0;
    const mutation = vi
      .spyOn(runtimeMutation, "runCronRuntimeMutation")
      .mockImplementation((params) => {
        if (params.type !== "cron.finalizeRuns") {
          return execute(params);
        }
        observed += 1;
        return whileContended(params.context.admission.databasePath, "cron.finalizeRuns", () =>
          execute(params),
        );
      });
    try {
      expect(await run(state, job.id, "force")).toMatchObject({ ok: true, ran: true });
      expect(observed).toBe(1);
      expect(runner).toHaveBeenCalledOnce();
      const persisted = (await loadCronStore(storePath)).jobs[0];
      expect(persisted?.state.lastRunStatus).toBe("ok");
      expect(persisted?.state.runningAtMs).toBeUndefined();
    } finally {
      mutation.mockRestore();
      stop(state);
      await state.op;
    }
  });
});
