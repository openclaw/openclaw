import { setImmediate as nextTurn } from "node:timers/promises";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../../test-utils/state-database-contention.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";

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
    const markSettled = () => {
      settled = true;
    };
    void pending.then(markSettled, markSettled);
    await awaitGateBeforeSettlement(posted.promise, pending, `${type} completed without dispatch`);
    await nextTurn();
    expect(Atomics.load(holder.released, 0)).toBe(0);
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
    const execute = workerStore.executeOpenClawStateWorker;
    let observed = 0;
    const mutation = vi
      .spyOn(workerStore, "executeOpenClawStateWorker")
      .mockImplementation((context, command) => {
        if (command.type !== "cron.finalizeRuns") {
          return execute(context, command);
        }
        observed += 1;
        return whileContended(context.admission.databasePath, "cron.finalizeRuns", () =>
          execute(context, command),
        );
      });
    try {
      expect(await run(state, job.id, "force")).toMatchObject({ ok: true, ran: true });
      expect(observed).toBe(1);
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
