import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { expect, it } from "vitest";
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

it("joins accepted cron writes and receipt finalization before closing shared state", async ({
  signal,
}) => {
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
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const storePath = fixture.state.statePath("cron", "close.json");
    const job = makeCronReceiptJob("accepted-before-close", "main");
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const handle = claimCronRunReceiptForTest(storePath, job, 1);
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
                    deliveryState: {
                      status: "not-requested",
                      failureNotification: { status: "not-requested" },
                    },
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
    let closed = false;
    closing = server.close({ reason: "cron close regression" }).then(() => {
      closed = true;
    });
    await gate(receivedWorkCancelled.promise, closing, "Gateway did not cancel received work");
    expect(kernel.connectionWork.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    releaseReplies.resolve();
    await withinTest(Promise.all([saving, finishing, closing]), signal);
    readClosedDatabase(resolveOpenClawStateSqlitePath(fixture.state.env), (database) => {
      expect(
        database
          .prepare("SELECT status, finished_at_ms FROM cron_run_receipts WHERE receipt_id = ?")
          .get(handle.receiptId),
      ).toEqual({ status: "ok", finished_at_ms: 3 });
      expect(
        database
          .prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
          .get(handle.storeKey, job.id),
      ).toEqual({ enabled: 0 });
    });
  } finally {
    releaseReplies.resolve();
    await Promise.allSettled([saving, finishing, closing]);
    restore?.();
    await fixture.cleanup();
  }
});
