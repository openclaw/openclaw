import { afterEach, expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../../test/helpers/cron/runtime-mutation.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import * as sqliteQuery from "../../infra/kysely-sync.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  bindCronJobAdmittedRun,
  captureCronJobMessageActionAuthority,
  captureCronJobMessageSourceAuthority,
  resetCronActiveJobs,
} from "../active-jobs.js";
import { CronService } from "../service.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { start, stop } from "../service/ops-lifecycle.js";
import { update } from "../service/ops-mutations.js";
import { markServiceCronJobActive } from "../service/run-receipts.js";
import { makeCronRecoveryState } from "../service/run-recovery.test-support.js";
import { runCronRuntimeMutation } from "../service/runtime-mutation.js";
import { createCronServiceState } from "../service/state.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob, CronJobPatch, CronStoredJob, CronToolsAllowProvenance } from "../types.js";
import { cronStoreKey } from "./key.js";
import {
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
  listActiveCronRunReceiptJobIdsInDatabase,
} from "./run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  claimCronRunReceiptInDatabaseForTest,
  prepareCronRunReceiptClaim,
  makeCronReceiptJob,
  finishCronRunReceiptAsync,
  makeCronRecoveryJob,
  inspectActiveCronRunReceipt,
} from "./run-receipt-store.test-support.js";
import {
  isCronRunTriggerStateRetiredInDatabase,
  retireCronRunTriggerStateInDatabase,
} from "./run-receipt-trigger-state.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-run-receipt-" });

afterEach(() => vi.restoreAllMocks());

async function storeJob(job: CronJob) {
  const { storePath } = await makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  return { storePath, job };
}

function makeState(storePath: string) {
  return createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
  });
}

function receipts(storePath: string, jobId: string) {
  return openOpenClawStateDatabase()
    .db.prepare(
      `SELECT receipt_id AS receiptId, status, agent_id AS agentId,
              started_at_ms AS startedAtMs, error_text AS error
         FROM cron_run_receipts
        WHERE store_key = ? AND job_id = ?
        ORDER BY started_at_ms DESC, receipt_id DESC`,
    )
    .all(cronStoreKey(storePath), jobId) as Array<{
    receiptId: string;
    status: string;
    agentId: string;
    startedAtMs: number;
    error: string | null;
  }>;
}

function finishOk(handle: CronRunReceiptHandle, finishedAtMs = Date.now()) {
  return finishCronRunReceiptAsync({ handle, status: "ok", finishedAtMs });
}

function requesterGrant(senderId: string): CronToolsAllowProvenance {
  return {
    version: 1,
    source: "authenticated-requester",
    channelRequester: { version: 1, channel: "discord", accountId: "work", senderId },
  };
}
function originGrant(channel: string): CronToolsAllowProvenance {
  return {
    version: 1,
    source: "final-executable-surface",
    callerOrigin: { kind: "external", channel },
  };
}
const toolPatch = (toolsAllow: string[]): CronJobPatch => ({
  payload: { kind: "agentTurn", toolsAllow },
});

async function messageRun(job: CronJob, runId: string) {
  const { storePath } = await storeJob(job);
  const receipt = claimCronRunReceiptForTest(storePath, job, Date.now());
  const state = makeState(storePath);
  const marker = markServiceCronJobActive(state, job, receipt);
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: job.agentId!,
      ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
    },
  });
  const controller = new AbortController();
  const close = async () => {
    admission.close();
    await finishOk(receipt);
    resetCronActiveJobs();
  };
  try {
    const admitted = await admission.admit("embedded");
    bindCronJobAdmittedRun(marker, admitted, controller.signal);
    const input = { jobId: job.id, operationalRunInstance: admitted.operationalRunInstance };
    const message = captureCronJobMessageActionAuthority(input);
    const source = captureCronJobMessageSourceAuthority(input);
    return {
      storePath,
      receipt,
      state,
      controller,
      admission,
      message,
      source,
      [Symbol.asyncDispose]: close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

it("allocates portable cursors inside the claim and reuses a deleted maximum", async () => {
  await withOpenClawTestState({ label: "cron-receipt-cursors" }, async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const jobs = ["first", "second", "third"].map((id) => makeCronReceiptJob(id));
    await saveCronStore(storePath, { version: 1, jobs });
    const first = claimCronRunReceiptForTest(storePath, jobs[0]!, 100);
    const second = claimCronRunReceiptForTest(storePath, jobs[1]!, 100);
    const db = openOpenClawStateDatabase().db;
    db.prepare("UPDATE cron_run_receipts SET rowid = 100 WHERE receipt_id = ?").run(
      first.receiptId,
    );
    db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = ?").run(second.receiptId);
    const third = claimCronRunReceiptForTest(storePath, jobs[2]!, 100);
    expect(
      db.prepare("SELECT receipt_id, cursor_id FROM cron_run_receipts ORDER BY cursor_id").all(),
    ).toEqual([
      { receipt_id: first.receiptId, cursor_id: 1 },
      { receipt_id: third.receiptId, cursor_id: 2 },
    ]);
  });
});

it("checks force-disabled message access without host SQL until its admission closes", async () => {
  const job: CronJob = {
    ...makeCronReceiptJob("force-disabled-message"),
    enabled: false,
    payload: { kind: "agentTurn", message: "synthetic", toolsAllow: ["message"] },
    scheduledToolPolicy: { version: 1, mode: "trusted" },
  };
  await using run = await messageRun(job, "message-use-run");
  const { admission, message, source } = run;
  expect(message).toBeTypeOf("function");
  expect(source).toBeTypeOf("function");
  const sql = observeMainThreadSql();
  try {
    sql.calibrate();
    expect(message).not.toThrow();
    expect(source).not.toThrow();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
  admission.close();
  expect(message).toThrow("no longer active");
  expect(source).toThrow("no longer active");
});

it.each([
  { enabled: true, mutation: "tool policy" },
  { enabled: false, mutation: "tool policy" },
  { enabled: true, mutation: "origin" },
  { enabled: true, mutation: "native name" },
  { enabled: true, mutation: "native delivery" },
  { enabled: true, mutation: "native requester" },
  { enabled: true, mutation: "native trigger state" },
] as const)(
  "retires message access after a service $mutation change from enabled=$enabled without retiring its receipt",
  async ({ enabled, mutation }) => {
    const native = mutation !== "tool policy" && mutation !== "origin";
    const grant = requesterGrant("requester-a");
    const replacementGrant = requesterGrant("requester-b");
    const origin = mutation === "origin";
    const owner = {
      agentId: "alpha",
      sessionKey: origin ? "agent:alpha:discord:channel:creator" : "agent:alpha:discord:group:ops",
      accountId: origin ? "creator" : "work",
    };
    const job: CronStoredJob = {
      ...makeCronReceiptJob("message-permission-change"),
      enabled,
      payload: { kind: "agentTurn", message: "read updates", toolsAllow: ["message", "exec"] },
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    };
    if (native || origin) {
      Object.assign(job, { owner, toolsAllowProvenance: origin ? originGrant("discord") : grant });
      job.schedule = { kind: "every", everyMs: 60_000, anchorMs: job.createdAtMs };
      job.scheduledToolPolicy = {
        version: 1,
        mode: "account",
        ownerSessionKey: owner.sessionKey,
        ownerAccountId: owner.accountId,
      };
    }
    if (native) {
      job.delivery = { mode: "none", channel: "discord", to: "channel:original" };
    }
    if (mutation === "native trigger state") {
      job.trigger = { script: "return { fire: true }" };
      job.state = { triggerState: { phase: "original" } };
    }
    await using run = await messageRun(job, "message-permission-run");
    const { storePath, receipt, state, controller, message, source } = run;
    const edit = (patch: CronJobPatch, authorization?: CronToolsAllowProvenance) =>
      update(
        state,
        job.id,
        patch,
        authorization ? { toolsAllowProvenance: authorization } : undefined,
      );
    expect(message).not.toThrow();
    expect(source).not.toThrow();
    const harmless: CronJobPatch = native
      ? { description: "Operator notes", displayName: "Readable label" }
      : origin
        ? { description: "descriptive origin notes" }
        : { name: "renamed", delivery: { mode: "none" }, ...toolPatch(["message"]) };
    await edit(harmless, native ? replacementGrant : undefined);
    expect(message).not.toThrow();
    expect(source).not.toThrow();

    type Edit = [CronJobPatch, CronToolsAllowProvenance?];
    const nativePatches: Record<
      "native name" | "native delivery" | "native trigger state",
      [CronJobPatch, CronJobPatch]
    > = {
      "native name": [{ name: "Different executable instructions" }, { name: job.name }],
      "native delivery": [{ delivery: { to: "channel:replacement" } }, { delivery: job.delivery }],
      "native trigger state": [
        { state: { triggerState: { phase: "replacement" } } },
        { state: { triggerState: job.state.triggerState } },
      ],
    };
    const edits: Edit[] =
      mutation === "native requester"
        ? [
            [toolPatch(["message", "exec"]), replacementGrant],
            [toolPatch(["message", "exec"]), grant],
          ]
        : native
          ? nativePatches[mutation].map((patch): Edit => [patch, grant])
          : origin
            ? ["slack", "discord"].map((channel): Edit => [
                toolPatch(["message", "exec"]),
                originGrant(channel),
              ])
            : [[toolPatch(["read"])], [toolPatch(["message"])]];
    for (const [patch, authorization] of edits) {
      await edit(patch, authorization);
    }
    if (native) {
      // No access check between edits: the committed mutation must latch revocation.
      const restored = (await loadCronStore(storePath)).jobs[0]!;
      expect(restored.toolsAllowProvenance).toEqual(grant);
      expect(restored.name).toBe(job.name);
      expect(restored.delivery).toEqual(job.delivery);
      expect(restored.state.triggerState).toEqual(job.state.triggerState);
    }
    expect(source).toThrow();
    if (mutation === "tool policy") {
      expect(message).toThrow();
    } else {
      expect(message).not.toThrow();
    }
    expect(controller.signal.aborted).toBe(false);
    expect(receipts(storePath, job.id)[0]?.status).toBe("running");
    if (native) {
      await finishOk(receipt);
      expect(receipts(storePath, job.id)[0]).toMatchObject({
        receiptId: receipt.receiptId,
        status: "ok",
        error: null,
      });
    }
  },
);

it.each(["single", "batch"] as const)(
  "lazily creates receipt storage for a direct $case lookup",
  async (testCase) => {
    const { storePath, job } = await storeJob(makeCronReceiptJob("lazy-lookup"));
    openOpenClawStateDatabase().db.exec("DROP TABLE cron_run_receipts");

    const result = runOpenClawStateWriteTransaction(({ db }) =>
      testCase === "single"
        ? findActiveCronRunReceiptInDatabase({ database: db, storePath, jobId: job.id })
        : listActiveCronRunReceiptJobIdsInDatabase(db, storePath),
    );
    expect(result).toEqual(testCase === "single" ? undefined : new Set());
    expect(
      openOpenClawStateDatabase()
        .db.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'cron_run_receipts'",
        )
        .get(),
    ).toEqual({ name: "cron_run_receipts" });
  },
);

it.each(["present", "absent"] as const)(
  "keeps trigger-state retirement atomic with %s storage",
  async (storage) => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.now();
    const editedJob = makeCronReceiptJob(`retirement-${storage}`);
    const untouchedJob = makeCronReceiptJob(`untouched-${storage}`);
    for (const job of [editedJob, untouchedJob]) {
      job.trigger = { script: "return true", once: true };
      job.state.runningAtMs = startedAtMs;
    }
    await saveCronStore(storePath, { version: 1, jobs: [editedJob, untouchedJob] });
    let editedReceipt = claimCronRunReceiptForTest(storePath, editedJob, startedAtMs);
    const untouchedReceipt = claimCronRunReceiptForTest(storePath, untouchedJob, startedAtMs);
    let database = openOpenClawStateDatabase();
    const schemaVersion = database.db.prepare("PRAGMA user_version").get();
    const readTable = () =>
      database.db
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name = 'cron_run_trigger_state_retirements'`,
        )
        .get();
    const readRetirements = () =>
      runOpenClawStateWriteTransaction(({ db }) => ({
        edited: isCronRunTriggerStateRetiredInDatabase({ database: db, handle: editedReceipt }),
        untouched: isCronRunTriggerStateRetiredInDatabase({
          database: db,
          handle: untouchedReceipt,
        }),
      }));
    const retire = () =>
      runOpenClawStateWriteTransaction(({ db }) => {
        retireCronRunTriggerStateInDatabase({ database: db, handle: editedReceipt });
      });
    const reopen = async () => {
      await closeOpenClawStateDatabaseByPathAsync(database.path);
      database = openOpenClawStateDatabase();
    };

    try {
      if (storage === "present") {
        retire();
        await finishOk(editedReceipt, startedAtMs + 1);
        // An earlier retirement must not transfer to a same-timestamp successor.
        editedReceipt = claimCronRunReceiptForTest(storePath, editedJob, startedAtMs);
      } else {
        // Preserve the receipt rows while restoring the pre-feature database shape.
        database.db.exec("DROP TABLE IF EXISTS cron_run_trigger_state_retirements");
      }
      await reopen();
      const previousTable =
        storage === "present" ? { name: "cron_run_trigger_state_retirements" } : undefined;
      expect(readTable()).toEqual(previousTable);
      expect(readRetirements()).toEqual({ edited: false, untouched: false });
      expect(readTable()).toEqual(previousTable);

      expect(() =>
        runOpenClawStateWriteTransaction(({ db }) => {
          retireCronRunTriggerStateInDatabase({
            database: db,
            handle: editedReceipt,
          });
          expect(
            isCronRunTriggerStateRetiredInDatabase({ database: db, handle: editedReceipt }),
          ).toBe(true);
          expect(readTable()).toEqual({ name: "cron_run_trigger_state_retirements" });
          throw new Error("cron edit did not commit");
        }),
      ).toThrow("cron edit did not commit");

      expect(readTable()).toEqual(previousTable);
      expect(readRetirements()).toEqual({ edited: false, untouched: false });
      retire();
      expect(readTable()).toEqual({ name: "cron_run_trigger_state_retirements" });
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual(schemaVersion);
      expect(
        database.db
          .prepare("SELECT receipt_id FROM cron_run_trigger_state_retirements WHERE receipt_id = ?")
          .get(untouchedReceipt.receiptId),
      ).toBeUndefined();

      await reopen();
      expect(readRetirements()).toEqual({ edited: true, untouched: false });
      expect(
        receipts(storePath, editedJob.id).filter((receipt) => receipt.status === "running"),
      ).toEqual([
        {
          receiptId: editedReceipt.receiptId,
          status: "running",
          agentId: editedJob.agentId,
          startedAtMs,
          error: null,
        },
      ]);
    } finally {
      for (const handle of [editedReceipt, untouchedReceipt]) {
        await finishOk(handle, startedAtMs + 1);
      }
    }
  },
);

it("records completion by run ID after an owner edit and ignores duplicate outcomes", async () => {
  const { storePath, job } = await storeJob(makeCronReceiptJob("idempotent-completion"));
  const prepared = prepareCronRunReceiptClaim({
    storePath,
    job,
    agentId: job.agentId!,
    startedAtMs: 300,
  });
  prepared.handle.ownerStartTime = null;
  const receipt = runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabaseForTest({
      database: db,
      prepared,
    }),
  );
  await saveCronStore(storePath, {
    version: 1,
    jobs: [{ ...job, agentId: "beta", updatedAtMs: 2 }],
  });
  const completed = { ...receipt, ownerPid: receipt.ownerPid + 1, configRevision: "old" };
  await finishOk(completed, 310);
  await finishCronRunReceiptAsync({
    handle: completed,
    status: "error",
    finishedAtMs: 320,
    error: "duplicate result",
  });
  expect(receipts(storePath, job.id)).toEqual([
    {
      receiptId: receipt.receiptId,
      status: "ok",
      agentId: "alpha",
      startedAtMs: 300,
      error: null,
    },
  ]);
});

it.each([
  ["commit", "started", 1, "committed"],
  ["retired", "not-started", 0, "not-committed"],
  ["reply-lost", "started", 0, "unknown"],
] as const)(
  "publishes delivery admission only after a successful worker reply: %s",
  async (outcome, phase, publications, settlement) => {
    const { storePath, job } = await storeJob(makeCronReceiptJob("delivery-commit"));
    const receipt = claimCronRunReceiptForTest(storePath, job, Date.now());
    const readPhase = () =>
      openOpenClawStateDatabase()
        .db.prepare("SELECT delivery_attempt_state FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId)?.delivery_attempt_state;
    expect(readPhase()).toBe("not-started");
    const reply =
      outcome === "reply-lost" ? loseFirstCronMutationReply("cron.markDeliveryStarted") : undefined;
    const published = vi.fn();
    const settled = vi.fn();
    try {
      const attempt = runCronRuntimeMutation({
        context: captureOpenClawStateWorkerContext(),
        type: "cron.markDeliveryStarted",
        input: { storeKey: receipt.storeKey, handle: receipt },
        assertCurrent: () => {
          if (outcome === "retired") {
            throw new Error("delivery owner retired before dispatch");
          }
        },
        snapshot: {},
        publish: published,
        onSettled: settled,
      });
      if (outcome === "commit") {
        await attempt;
      } else {
        await expect(attempt).rejects.toBeInstanceOf(Error);
      }
      await reply?.waitForExit();
      expect(readPhase()).toBe(phase);
      expect(published).toHaveBeenCalledTimes(publications);
      expect(settled).toHaveBeenCalledWith(settlement);
      if (reply) {
        expect(reply.wasDropped()).toBe(true);
        expect(reply.attempts).toEqual(["cron.markDeliveryStarted"]);
      }
    } finally {
      await reply?.close();
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
    const now = Date.now();
    const job = makeCronRecoveryJob("ambiguous-one-shot", now);
    job.schedule = { kind: "at", at: new Date(now).toISOString() };
    job.deleteAfterRun = true;
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    if (kind !== "receiptless") {
      const receipt = claimCronRunReceiptForTest(storePath, job, now);
      job.state.runningReceiptId = receipt.receiptId;
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      openOpenClawStateDatabase()
        .db.prepare("UPDATE cron_run_receipts SET delivery_attempt_state = ? WHERE receipt_id = ?")
        .run(kind === "started-terminal" ? "started" : "unknown", receipt.receiptId);
      if (kind !== "legacy-running") {
        await finishCronRunReceiptAsync({
          handle: receipt,
          status: "interrupted",
          finishedAtMs: now + 1,
        });
      }
    }
    for (let restart = 0; restart < 2; restart += 1) {
      const state = makeCronRecoveryState(logger, storePath, now + 2);
      state.deps.runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
      try {
        await start(state);
        const recovered = (await loadCronStore(storePath)).jobs[0];
        expect(recovered).toMatchObject({
          enabled: false,
          state: { lastRunStatus: "error", lastDeliveryStatus: "unknown" },
        });
        expect(recovered?.state.consecutiveErrors).toBeUndefined();
        expect(recovered?.state.autoDisabled).toBeUndefined();
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

it("keeps the pending terminal receipt within 64 rows until reconciliation releases it", async () => {
  const { storePath } = await makeStorePath();
  const now = Date.now();
  const started = createDeferred();
  const completion = createDeferred<{ status: "ok" }>();
  const runCommandJob = vi.fn(async () => {
    started.resolve();
    return completion.promise;
  });
  const makeService = (cronEnabled = true) =>
    new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      cronEnabled,
      log: logger,
      enqueueSystemEvent() {},
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob,
    });
  const owner = makeService();
  const editor = makeService(false);
  const reconciler = makeService();
  const job = await editor.add({
    name: "pending receipt retention",
    agentId: "alpha",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now + 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["true"] },
  });
  const history: string[] = [];
  // Clock-skewed history must not evict the pending receipt.
  for (let index = 0; index < 64; index += 1) {
    const receipt = claimCronRunReceiptForTest(storePath, job, now + 100 + index * 2);
    history.push(receipt.receiptId);
    await finishCronRunReceiptAsync({
      handle: receipt,
      status: "ok",
      finishedAtMs: now + 101 + index * 2,
    });
  }
  const database = openOpenClawStateDatabase().db;
  const terminalIds = () =>
    database
      .prepare(
        `SELECT receipt_id AS receiptId FROM cron_run_receipts
           WHERE store_key = ? AND job_id = ? AND status != 'running'
           ORDER BY finished_at_ms DESC, started_at_ms DESC, receipt_id DESC`,
      )
      .all(cronStoreKey(storePath), job.id)
      .map((row) => row.receiptId);
  const running = owner.run(job.id, "force");
  try {
    await started.promise;
    const pending = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
    expect(pending).toBeDefined();
    await editor.update(job.id, { state: { triggerState: { owner: "saved edit" } } });
    const retirement = () =>
      database
        .prepare("SELECT receipt_id FROM cron_run_trigger_state_retirements WHERE receipt_id = ?")
        .get(pending!.receiptId);
    expect(retirement()).toEqual({ receipt_id: pending!.receiptId });

    database.exec(`
        CREATE TRIGGER reject_pending_receipt_completion BEFORE UPDATE ON cron_jobs
        WHEN NEW.job_id = '${job.id}' AND json_extract(NEW.state_json, '$.runningAtMs') IS NULL
        BEGIN SELECT RAISE(ABORT, 'pending receipt completion unavailable'); END;
      `);
    completion.resolve({ status: "ok" });
    await expect(running).rejects.toThrow("pending receipt completion unavailable");
    database.exec("DROP TRIGGER reject_pending_receipt_completion");
    owner.stop();
    await editor.update(job.id, { agentId: "beta" });

    expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toMatchObject({
      receiptId: pending!.receiptId,
    });
    // A late result prunes while preserving the unreconciled run marker after an owner edit.
    const queries = vi.spyOn(sqliteQuery, "executeSqliteQuerySync");
    runOpenClawStateWriteTransaction(({ db }) =>
      finishCronRunReceiptInDatabase({
        database: db,
        receiptSchema: prepareCronRunReceiptWriteSchema(db),
        handle: pending!,
        pendingReceiptId: pending!.receiptId,
        status: "ok",
        finishedAtMs: now,
      }),
    );
    const fetchedRows = queries.mock.results.flatMap((result) =>
      result.type === "return" ? result.value.rows : [],
    ).length;
    queries.mockRestore();
    expect(terminalIds()).toEqual([...history.slice(1).toReversed(), pending!.receiptId]);
    expect(retirement()).toEqual({ receipt_id: pending!.receiptId });
    expect((await loadCronStore(storePath)).jobs[0]?.state.runningReceiptId).toBe(
      pending!.receiptId,
    );
    expect(fetchedRows).toBeLessThanOrEqual(8);

    await reconciler.start();
    expect(runCommandJob).toHaveBeenCalledOnce();
    const recovered = (await loadCronStore(storePath)).jobs[0]!;
    expect(recovered.state.runningAtMs).toBeUndefined();
    expect(recovered.state.runningReceiptId).toBeUndefined();
    expect(recovered.state.triggerState).toEqual({ owner: "saved edit" });
    expect(retirement()).toEqual({ receipt_id: pending!.receiptId });

    vi.setSystemTime(now + 1_000);
    await expect(reconciler.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    expect(runCommandJob).toHaveBeenCalledTimes(2);
    expect(terminalIds()).toHaveLength(64);
    expect(terminalIds()).not.toContain(pending!.receiptId);
    // Query directly: a receipt join would hide a dangling retirement after pruning.
    expect(retirement()).toBeUndefined();
  } finally {
    database.exec("DROP TRIGGER IF EXISTS reject_pending_receipt_completion");
    completion.resolve({ status: "ok" });
    await running.catch(() => undefined);
    owner.stop();
    editor.stop();
    reconciler.stop();
  }
});
