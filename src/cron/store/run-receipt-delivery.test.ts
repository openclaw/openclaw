import { expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../../test/helpers/cron/runtime-mutation.js";
import { enqueueDelivery } from "../../infra/outbound/delivery-queue-storage.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { start, stop } from "../service/ops-lifecycle.js";
import { makeCronRecoveryState } from "../service/run-recovery.test-support.js";
import { runCronRuntimeMutation } from "../service/runtime-mutation.js";
import { loadCronStore } from "../store.js";
import {
  finishCronRunReceiptAsync,
  releaseLocalCronRunReceiptOwnership,
} from "./run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  makeCronReceiptJob,
  makeCronRecoveryJob,
} from "./run-receipt-store.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-delivery-commit-" });

it.each(["commit", "retired", "reply-lost", "evidence-lost"] as const)(
  "publishes delivery admission only from confirmed current commit: %s",
  async (outcome) => {
    const { storePath } = await makeStorePath();
    const job = makeCronReceiptJob("delivery-commit");
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const receipt = claimCronRunReceiptForTest(storePath, job, Date.now());
    const readPhase = () =>
      openOpenClawStateDatabase()
        .db.prepare("SELECT delivery_attempt_state FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId)?.delivery_attempt_state;
    expect(readPhase()).toBe("not-started");
    const reply =
      outcome === "reply-lost" || outcome === "evidence-lost"
        ? loseFirstCronMutationReply("cron.markDeliveryStarted")
        : undefined;
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const lostEvidence =
      outcome === "evidence-lost"
        ? vi
            .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
            .mockImplementation((...args) => {
              const admission = createAdmission(...args);
              // The transaction and native owner still settle. Only this caller loses
              // both retained observations, so persisted bytes cannot authorize it.
              vi.spyOn(admission, "committed", "get").mockReturnValue(undefined);
              vi.spyOn(admission, "settlement", "get").mockReturnValue({ kind: "unknown" });
              return admission;
            })
        : undefined;
    const published = vi.fn();
    const settled = vi.fn();
    try {
      const attempt = runCronRuntimeMutation({
        context: captureOpenClawStateWorkerContext(),
        type: "cron.markDeliveryStarted",
        input: { storeKey: receipt.storeKey, handle: receipt },
        assertCurrent: () => undefined,
        prepare: ({ deletionBlocked }) => {
          expect(deletionBlocked).toBe(false);
          return {
            value: { allowMissingJob: false },
            assertCurrent: () => {
              if (outcome === "retired") {
                throw new Error("delivery owner retired before commit");
              }
            },
          };
        },
        publish: published,
        onSettled: settled,
      });
      if (outcome === "commit") {
        await attempt;
      } else {
        await expect(attempt).rejects.toBeInstanceOf(Error);
      }
      await reply?.waitForExit();
      expect(readPhase()).toBe(outcome === "retired" ? "not-started" : "started");
      expect(published).toHaveBeenCalledTimes(
        outcome === "commit" || outcome === "reply-lost" ? 1 : 0,
      );
      expect(settled).toHaveBeenCalledWith(
        outcome === "evidence-lost"
          ? "unknown"
          : outcome === "retired"
            ? "not-committed"
            : "committed",
      );
      if (reply) {
        expect(reply.wasDropped()).toBe(true);
        expect(reply.attempts).toEqual(["cron.markDeliveryStarted"]);
      }
    } finally {
      await reply?.close();
      lostEvidence?.mockRestore();
      await finishCronRunReceiptAsync({
        handle: receipt,
        status: "interrupted",
        finishedAtMs: Date.now(),
      });
    }
  },
);

it.each([
  { when: "nothing else holds the occurrence", released: true },
  { when: "a later run is in progress", released: false },
  { when: "a later run finished", released: false },
  { when: "another intent is admitted", released: false },
  { when: "the queue still holds the send", released: false },
] as const)(
  "settles a retired run's dropped-send admission when $when",
  async ({ when, released }) => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.now();
    const job = makeCronReceiptJob("dropped-send");
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const receipt = claimCronRunReceiptForTest(storePath, job, startedAtMs);
    const intentId =
      when === "the queue still holds the send"
        ? await enqueueDelivery({
            channel: "matrix",
            to: "!room:example",
            payloads: [{ text: "x" }],
          })
        : "cron-direct-delivery:v1:dropped";
    const admission = {
      occurrenceAtMs: startedAtMs,
      intentId: when === "another intent is admitted" ? "cron-direct-delivery:v1:other" : intentId,
    };
    // The run that queued the send already finalized; only a later run may own the job now.
    job.state = {
      deliveryAdmission: admission,
      lastRunAtMs: when === "a later run finished" ? startedAtMs + 60_000 : startedAtMs,
      ...(when === "a later run is in progress"
        ? { runningAtMs: startedAtMs + 60_000, runningReceiptId: "later-run" }
        : {}),
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    try {
      await runCronRuntimeMutation({
        context: captureOpenClawStateWorkerContext(),
        type: "cron.releaseDeliveryAdmission",
        input: {
          storeKey: receipt.storeKey,
          handle: receipt,
          admission: { occurrenceAtMs: startedAtMs, intentId },
        },
        assertCurrent: () => undefined,
        prepare: () => ({ value: {}, assertCurrent: () => undefined }),
        publish: () => undefined,
      });
      expect((await loadCronStore(storePath)).jobs[0]?.state.deliveryAdmission).toEqual(
        released ? undefined : admission,
      );
    } finally {
      await finishCronRunReceiptAsync({
        handle: receipt,
        status: "interrupted",
        finishedAtMs: Date.now(),
      });
    }
  },
);

it.each(["legacy-running", "legacy-terminal", "started-terminal", "receiptless"] as const)(
  "holds an interrupted ambiguous one-shot disabled across repeated startup: %s",
  async (kind) => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.now();
    const job = makeCronRecoveryJob("ambiguous-one-shot", startedAtMs);
    job.schedule = { kind: "at", at: new Date(startedAtMs).toISOString() };
    job.deleteAfterRun = true;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    if (kind !== "receiptless") {
      const receipt = claimCronRunReceiptForTest(storePath, job, startedAtMs);
      job.state.runningReceiptId = receipt.receiptId;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      openOpenClawStateDatabase()
        .db.prepare("UPDATE cron_run_receipts SET delivery_attempt_state = ? WHERE receipt_id = ?")
        .run(kind === "started-terminal" ? "started" : "unknown", receipt.receiptId);
      if (kind !== "legacy-running") {
        await finishCronRunReceiptAsync({
          handle: receipt,
          status: "interrupted",
          finishedAtMs: startedAtMs + 1,
        });
      }
      releaseLocalCronRunReceiptOwnership(receipt);
    }
    for (let restart = 0; restart < 2; restart += 1) {
      const state = makeCronRecoveryState(logger, storePath, startedAtMs + 2);
      state.deps.runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
      try {
        await start(state);
        const recovered = (await loadCronStore(storePath)).jobs[0];
        expect(recovered).toMatchObject({
          enabled: false,
          state: { lastRunStatus: "error", lastDeliveryStatus: "unknown", consecutiveErrors: 1 },
        });
        expect(recovered?.state.runningAtMs).toBeUndefined();
        expect(recovered?.state.nextRunAtMs).toBeUndefined();
        expect(recovered?.state.startupCatchupAtMs).toBeUndefined();
        expect(state.deps.runCommandJob).not.toHaveBeenCalled();
      } finally {
        stop(state);
      }
    }
  },
);
