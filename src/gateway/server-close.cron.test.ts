import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { saveCronStore } from "../cron/store.js";
import {
  finishCronRunReceiptAsync,
  releaseLocalCronRunReceiptOwnership,
} from "../cron/store/run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  makeCronReceiptJob,
} from "../cron/store/run-receipt-store.test-support.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("joins accepted cron writes and receipt finalization before closing shared state", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-cron-close");
  const saveCommitted = createDeferred();
  const finishCommitted = createDeferred();
  const releaseReplies = createDeferred();
  const preludeEntered = createDeferred();
  let saving: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let releaseReceipt: (() => void) | undefined;
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
    releaseReceipt = () => releaseLocalCronRunReceiptOwnership(handle);
    const observation = probe.command(stateWorker, async (command, options, scope) => {
      const result = await scope.execute(command, options);
      if (command.type === "cron.save" || command.type === "cron.finishReceipt") {
        (command.type === "cron.save" ? saveCommitted : finishCommitted).resolve();
        await releaseReplies.promise;
      }
      return result;
    });
    restore = () => observation.mockRestore();
    saving = kernel.connectionWork.track(() =>
      saveCronStore(storePath, { version: 1, jobs: [{ ...job, enabled: false }] }),
    );
    await withinTest(
      awaitGateBeforeSettlement(saveCommitted.promise, saving, "Cron save did not commit"),
      signal,
    );
    finishing = kernel.connectionWork.track(() =>
      finishCronRunReceiptAsync({ handle, status: "ok", finishedAtMs: 3 }),
    );
    await withinTest(
      awaitGateBeforeSettlement(
        finishCommitted.promise,
        finishing,
        "Cron finalization did not commit",
      ),
      signal,
    );
    kernel.requestEntryLifetime.signal.addEventListener("abort", () => preludeEntered.resolve(), {
      once: true,
    });
    let closed = false;
    closing = server.close({ reason: "cron close regression" }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(
        preludeEntered.promise,
        closing,
        "Gateway missed its close prelude",
      ),
      signal,
    );
    expect(kernel.connectionWork.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    releaseReplies.resolve();
    await withinTest(Promise.all([saving, finishing, closing]), signal);
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(fixture.state.env), {
      readOnly: true,
    });
    try {
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
    } finally {
      database.close();
    }
  } finally {
    releaseReplies.resolve();
    await Promise.allSettled([saving, finishing, closing]);
    restore?.();
    releaseReceipt?.();
    await fixture.cleanup();
  }
});
