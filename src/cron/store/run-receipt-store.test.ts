import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  bindCronJobAdmittedRun,
  captureCronJobMessageActionAuthority,
  captureCronJobMessageSourceAuthority,
  resetCronActiveJobs,
} from "../active-jobs.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { update } from "../service/ops-mutations.js";
import { markServiceCronJobActive } from "../service/run-receipts.js";
import { createCronServiceState, type CronServiceDeps } from "../service/state.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob, CronJobPatch, CronStoredJob, CronToolsAllowProvenance } from "../types.js";
import { cronStoreKey } from "./key.js";
import {
  findActiveCronRunReceiptInDatabase,
  listActiveCronRunReceiptJobIdsInDatabase,
} from "./run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  claimCronRunReceiptInDatabaseForTest,
  prepareCronRunReceiptClaim,
  makeCronReceiptJob,
  finishCronRunReceiptAsync,
} from "./run-receipt-store.test-support.js";
import {
  isCronRunTriggerStateRetiredInDatabase,
  retireCronRunTriggerStateInDatabase,
} from "./run-receipt-trigger-state.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-run-receipt-" });

afterEach(() => {
  vi.restoreAllMocks();
});

async function storeJob(job: CronJob) {
  const { storePath } = await makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  return { storePath, job };
}

function makeState(storePath: string, isAgentAvailable?: CronServiceDeps["isAgentAvailable"]) {
  return createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    isAgentAvailable,
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

describe("cron run receipt store", () => {
  it("allocates portable cursors inside the claim and reuses a deleted maximum", async () => {
    const { storePath } = await makeStorePath();
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

  it("checks force-disabled message access without host SQL until its admission closes", async () => {
    const { storePath, job } = await storeJob({
      ...makeCronReceiptJob("force-disabled-message"),
      enabled: false,
      payload: { kind: "agentTurn", message: "synthetic", toolsAllow: ["message"] },
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });
    const receipt = claimCronRunReceiptForTest(storePath, job, Date.now());
    const state = makeState(storePath);
    const marker = markServiceCronJobActive(state, job, receipt);
    const operationalRunInstance = createOperationalRunInstanceRef("message-use-run");
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance,
      facts: {
        runId: operationalRunInstance.runId,
        agentId: job.agentId!,
        ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
      },
    });
    let sql: ReturnType<typeof observeMainThreadSql> | undefined;
    try {
      const admitted = await admission.admit("embedded");
      bindCronJobAdmittedRun(marker, admitted, new AbortController().signal);
      const message = captureCronJobMessageActionAuthority({
        jobId: job.id,
        operationalRunInstance,
      });
      const source = captureCronJobMessageSourceAuthority({
        jobId: job.id,
        operationalRunInstance,
      });
      expect(message).toBeTypeOf("function");
      expect(source).toBeTypeOf("function");
      sql = observeMainThreadSql();
      sql.calibrate();
      expect(message).not.toThrow();
      expect(source).not.toThrow();
      sql.expectIdle();
      sql.restore();
      sql = undefined;
      admission.close();
      expect(message).toThrow("no longer active");
      expect(source).toThrow("no longer active");
    } finally {
      sql?.restore();
      admission.close();
      resetCronActiveJobs();
      await finishCronRunReceiptAsync({ handle: receipt, status: "ok", finishedAtMs: Date.now() });
    }
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
      const { storePath } = await makeStorePath();
      const native = mutation !== "tool policy" && mutation !== "origin";
      const channelRequester = {
        version: 1 as const,
        channel: "discord",
        accountId: "work",
        senderId: "requester-a",
      };
      const toolsAllowProvenance: CronToolsAllowProvenance = {
        version: 1,
        source: "authenticated-requester",
        channelRequester,
      };
      const owner = {
        agentId: "alpha",
        sessionKey: "agent:alpha:discord:group:ops",
        accountId: channelRequester.accountId,
      };
      const job: CronStoredJob = {
        ...makeCronReceiptJob("message-permission-change"),
        enabled,
        payload: { kind: "agentTurn", message: "read updates", toolsAllow: ["message", "exec"] },
        scheduledToolPolicy: native
          ? {
              version: 1,
              mode: "account",
              ownerSessionKey: owner.sessionKey,
              ownerAccountId: owner.accountId,
            }
          : { version: 1, mode: "trusted" },
        ...(native
          ? {
              owner,
              toolsAllowProvenance,
              schedule: { kind: "every" as const, everyMs: 60_000, anchorMs: 1 },
              delivery: { mode: "none" as const, channel: "discord", to: "channel:original" },
            }
          : {}),
        ...(mutation === "native trigger state"
          ? {
              trigger: { script: "return { fire: true }" },
              state: { triggerState: { phase: "original" } },
            }
          : {}),
      };
      const provenance: CronToolsAllowProvenance = {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "external", channel: "discord" },
      };
      if (mutation === "origin") {
        const originOwner = {
          agentId: "alpha",
          sessionKey: "agent:alpha:discord:channel:creator",
          accountId: "creator",
        };
        job.owner = originOwner;
        job.scheduledToolPolicy = {
          version: 1,
          mode: "account",
          ownerSessionKey: originOwner.sessionKey,
          ownerAccountId: originOwner.accountId,
        };
        job.schedule = { kind: "every", everyMs: 60_000, anchorMs: job.createdAtMs };
        job.toolsAllowProvenance = provenance;
      }
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const receipt = claimCronRunReceiptForTest(storePath, job, Date.now());
      const state = makeState(storePath);
      const marker = markServiceCronJobActive(state, job, receipt);
      const controller = new AbortController();
      const admission = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef("message-permission-run"),
        facts: {
          runId: "message-permission-run",
          agentId: job.agentId!,
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
        },
      });
      try {
        const admitted = await admission.admit("embedded");
        bindCronJobAdmittedRun(marker, admitted, controller.signal);
        const assertMessageCurrent = captureCronJobMessageActionAuthority({
          jobId: job.id,
          operationalRunInstance: admitted.operationalRunInstance,
        });
        const assertSourceCurrent = captureCronJobMessageSourceAuthority({
          jobId: job.id,
          operationalRunInstance: admitted.operationalRunInstance,
        });
        expect(assertMessageCurrent).not.toThrow();
        expect(assertSourceCurrent).not.toThrow();
        if (native) {
          await update(
            state,
            job.id,
            { description: "Operator notes", displayName: "Readable label" },
            {
              toolsAllowProvenance: {
                ...toolsAllowProvenance,
                channelRequester: { ...channelRequester, senderId: "requester-b" },
              },
            },
          );
          expect(assertMessageCurrent).not.toThrow();
          expect(assertSourceCurrent).not.toThrow();
          if (mutation === "native requester") {
            await update(
              state,
              job.id,
              { payload: { kind: "agentTurn", toolsAllow: job.payload.toolsAllow } },
              {
                toolsAllowProvenance: {
                  ...toolsAllowProvenance,
                  channelRequester: { ...channelRequester, senderId: "requester-b" },
                },
              },
            );
            await update(
              state,
              job.id,
              { payload: { kind: "agentTurn", toolsAllow: job.payload.toolsAllow } },
              { toolsAllowProvenance },
            );
          } else {
            const [changed, restored]: [CronJobPatch, CronJobPatch] =
              mutation === "native name"
                ? [{ name: "Different executable instructions" }, { name: job.name }]
                : mutation === "native delivery"
                  ? [{ delivery: { to: "channel:replacement" } }, { delivery: job.delivery }]
                  : [
                      { state: { triggerState: { phase: "replacement" } } },
                      { state: { triggerState: job.state.triggerState } },
                    ];
            await update(state, job.id, changed, { toolsAllowProvenance });
            await update(state, job.id, restored, { toolsAllowProvenance });
          }
          // No access check between edits: the committed mutation must latch revocation.
          const restored = (await loadCronStore(storePath)).jobs[0]!;
          expect(restored.toolsAllowProvenance).toEqual(toolsAllowProvenance);
          expect(restored.name).toBe(job.name);
          expect(restored.delivery).toEqual(job.delivery);
          expect(restored.state.triggerState).toEqual(job.state.triggerState);
        } else {
          // An admission that began disabled and unrelated tool/delivery edits keep access.
          await update(
            state,
            job.id,
            mutation === "origin"
              ? { description: "descriptive origin notes" }
              : {
                  name: "renamed",
                  delivery: { mode: "none" },
                  ...(mutation === "tool policy"
                    ? { payload: { kind: "agentTurn" as const, toolsAllow: ["message"] } }
                    : {}),
                },
          );
          expect(assertMessageCurrent).not.toThrow();
          expect(assertSourceCurrent).not.toThrow();
          if (mutation === "origin") {
            for (const channel of ["slack", "discord"]) {
              const originProvenance: CronToolsAllowProvenance = {
                ...provenance,
                callerOrigin: { kind: "external", channel },
              };
              await update(
                state,
                job.id,
                { payload: { kind: "agentTurn", toolsAllow: ["message", "exec"] } },
                { toolsAllowProvenance: originProvenance },
              );
            }
          } else {
            await update(state, job.id, { payload: { kind: "agentTurn", toolsAllow: ["read"] } });
            await update(state, job.id, {
              payload: { kind: "agentTurn", toolsAllow: ["message"] },
            });
          }
        }
        expect(assertSourceCurrent).toThrow();
        if (mutation === "tool policy") {
          expect(assertMessageCurrent).toThrow();
        } else {
          expect(assertMessageCurrent).not.toThrow();
        }
        expect(controller.signal.aborted).toBe(false);
        expect(receipts(storePath, job.id)[0]?.status).toBe("running");
        if (native) {
          await finishCronRunReceiptAsync({
            handle: receipt,
            status: "ok",
            finishedAtMs: Date.now(),
          });
          expect(receipts(storePath, job.id)[0]).toMatchObject({
            receiptId: receipt.receiptId,
            status: "ok",
            error: null,
          });
        }
      } finally {
        admission.close();
        await finishCronRunReceiptAsync({
          handle: receipt,
          status: "ok",
          finishedAtMs: Date.now(),
        });
        resetCronActiveJobs();
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

      try {
        if (storage === "present") {
          runOpenClawStateWriteTransaction(({ db }) => {
            retireCronRunTriggerStateInDatabase({ database: db, handle: editedReceipt });
          });
          await finishCronRunReceiptAsync({
            handle: editedReceipt,
            status: "ok",
            finishedAtMs: startedAtMs + 1,
          });
          // An earlier retirement must not transfer to a same-timestamp successor.
          editedReceipt = claimCronRunReceiptForTest(storePath, editedJob, startedAtMs);
        } else {
          // Preserve the receipt rows while restoring the pre-feature database shape.
          database.db.exec("DROP TABLE IF EXISTS cron_run_trigger_state_retirements");
        }
        await closeOpenClawStateDatabaseByPathAsync(database.path);
        database = openOpenClawStateDatabase();
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
        runOpenClawStateWriteTransaction(({ db }) => {
          retireCronRunTriggerStateInDatabase({
            database: db,
            handle: editedReceipt,
          });
        });
        expect(readTable()).toEqual({ name: "cron_run_trigger_state_retirements" });
        expect(database.db.prepare("PRAGMA user_version").get()).toEqual(schemaVersion);
        expect(
          database.db
            .prepare(
              "SELECT receipt_id FROM cron_run_trigger_state_retirements WHERE receipt_id = ?",
            )
            .get(untouchedReceipt.receiptId),
        ).toBeUndefined();

        await closeOpenClawStateDatabaseByPathAsync(database.path);
        database = openOpenClawStateDatabase();
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
          await finishCronRunReceiptAsync({ handle, status: "ok", finishedAtMs: startedAtMs + 1 });
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
      observed: undefined,
    });
    prepared.handle.ownerStartTime = null;
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabaseForTest({
        database: db,
        prepared,
        resolveAgentId: (current) => current.agentId!,
      }),
    );
    await saveCronStore(storePath, {
      version: 1,
      jobs: [{ ...job, agentId: "beta", updatedAtMs: 2 }],
    });
    const completed = { ...receipt, ownerPid: receipt.ownerPid + 1, configRevision: "old" };
    await finishCronRunReceiptAsync({ handle: completed, status: "ok", finishedAtMs: 310 });
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
});
