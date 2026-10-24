import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { saveCronStore } from "../cron/store.js";
import {
  claimCronRunReceiptForTest,
  makeCronReceiptJob,
} from "../cron/store/run-receipt-store.test-support.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { createTestGate, readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("joins cron writes and receipt finalization before close", async ({ signal }) => {
  const gate = createTestGate(signal);
  const fixture = await createGatewayMetadataCloseFixture("gateway-cron-close");
  const saveCommitted = createDeferred();
  const finishCommitted = createDeferred();
  const releaseReplies = createDeferred();
  const receivedWorkCancelled = createDeferred();
  let saving: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let restore: (() => void) | undefined;
  try {
    const { server, kernel } = await fixture.startServer();
    const storePath = fixture.state.statePath("cron", "close.json");
    const job = makeCronReceiptJob("accepted-before-close", "main");
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const handle = claimCronRunReceiptForTest(storePath, job, 1);
    const notRequested: { status: "not-requested" } = { status: "not-requested" };
    const observation = probe.command(stateWorker, async (command, options, scope) => {
      const result = await scope.execute(command, options);
      if (command.type === "cron.save" || command.type === "cron.finalizeRuns") {
        (command.type === "cron.save" ? saveCommitted : finishCommitted).resolve();
        await releaseReplies.promise;
      }
      return result;
    });
    restore = () => observation.mockRestore();
    saving = kernel.connectionWork.track(() =>
      saveCronStore(storePath, { version: 1, jobs: [{ ...job, enabled: false }] }),
    );
    await gate(saveCommitted.promise, saving, "Cron save did not commit");
    finishing = kernel.connectionWork.track(async () => {
      await stateWorker.runOpenClawStateWorkerOperation(
        captureOpenClawStateWorkerContext(),
        (scope) =>
          scope.execute({
            type: "cron.finalizeRuns",
            input: {
              storeKey: handle.storeKey,
              snapshot: {
                nowMs: 3,
                defaultAgentId: "main",
                outcomes: [
                  {
                    jobId: job.id,
                    job,
                    runReceipt: handle,
                    status: "ok",
                    completionStatus: "succeeded",
                    deliveryState: { ...notRequested, failureNotification: notRequested },
                    startedAt: 1,
                    endedAt: 3,
                  },
                ],
              },
            },
          }),
      );
    });
    await gate(finishCommitted.promise, finishing, "Cron finalization did not commit");
    kernel.connectionWork.signal.addEventListener("abort", () => receivedWorkCancelled.resolve(), {
      once: true,
    });
    const closed = vi.fn<() => void>();
    closing = server.close({ reason: "cron close regression" }).then(closed);
    await gate(receivedWorkCancelled.promise, closing, "Gateway did not cancel received work");
    expect(kernel.connectionWork.signal.aborted).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    releaseReplies.resolve();
    await withinTest(Promise.all([saving, finishing, closing]), signal);
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
    releaseReplies.resolve();
    await Promise.allSettled([saving, finishing, closing]);
    restore?.();
    await fixture.cleanup();
  }
});
