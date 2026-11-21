import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { saveCronStore } from "../cron/store.js";
import {
  claimCronRunReceiptForTest,
  makeCronReceiptJob,
} from "../cron/store/run-receipt-store.test-support.js";
import type { CronRunFinalizationOutcome } from "../cron/store/runtime-worker.types.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { createTestGate, readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";

it("joins cron writes and receipt finalization before close", async ({ signal }) => {
  const gate = createTestGate(signal);
  const race = await createGatewayCloseRace("gateway-cron-close", signal);
  const { fixture, kernel } = race;
  const finishCommitted = createDeferred();
  try {
    const storePath = fixture.state.statePath("cron", "close.json");
    const job = makeCronReceiptJob("accepted-before-close", "main");
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const handle = claimCronRunReceiptForTest(storePath, job, 1);
    const notRequested: { status: "not-requested" } = { status: "not-requested" };
    const observation = probe.command(stateWorker, async (command, options, scope) => {
      const result = await scope.execute(command, options);
      if (command.type === "cron.save" || command.type === "cron.finalizeRuns") {
        if (command.type === "cron.finalizeRuns") {
          finishCommitted.resolve();
        }
        await race.block();
      }
      return result;
    });
    race.onCleanup(() => observation.mockRestore());
    const saving = kernel.connectionWork.track(() =>
      saveCronStore(storePath, { version: 1, jobs: [{ ...job, enabled: false }] }),
    );
    await race.waitForEntry(saving, "Cron save did not commit");
    const outcome: CronRunFinalizationOutcome = {
      jobId: job.id,
      job,
      runReceipt: handle,
      status: "ok",
      errorReason: undefined,
      completionStatus: "succeeded",
      deliveryState: { ...notRequested, failureNotification: notRequested },
      startedAt: 1,
      endedAt: 3,
    };
    const snapshot = { nowMs: 3, defaultAgentId: "main", outcomes: [outcome] };
    const finishing = kernel.connectionWork.track(() =>
      stateWorker.runOpenClawStateWorkerOperation(captureOpenClawStateWorkerContext(), (scope) =>
        scope.execute({
          type: "cron.finalizeRuns",
          input: { storeKey: handle.storeKey, snapshot },
        }),
      ),
    );
    await race.waitForEntry(Promise.all([saving, finishing]));
    await gate(finishCommitted.promise, finishing, "Cron finalization did not commit");
    await race.close(kernel.connectionWork.signal, undefined, { reason: "cron close regression" });
    expect(race.closed).toBe(false);
    await race.finish(Promise.all([saving, finishing]));
    const rows = readClosedDatabase(
      resolveOpenClawStateSqlitePath(fixture.state.env),
      `SELECT status, finished_at_ms, enabled FROM cron_run_receipts, cron_jobs
       WHERE receipt_id = ? AND cron_jobs.store_key = ? AND cron_jobs.job_id = ?`,
      handle.receiptId,
      handle.storeKey,
      job.id,
    );
    expect(rows).toEqual([{ status: "ok", finished_at_ms: 3, enabled: 0 }]);
  } finally {
    await race.dispose();
  }
});
