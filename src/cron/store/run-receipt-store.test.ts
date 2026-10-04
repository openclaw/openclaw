import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { withPreparedChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { withEffectPreparation, type PreparedEffectUse } from "../../shared/effect-authority.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "../../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  advanceCronActiveJobGeneration,
  bindCronJobAdmittedRun,
  bindCronSelfRemovalCommitGuard,
  captureCronJobMessageActionAuthority,
  captureCronJobMessageSourceAuthority,
  markCronJobActive,
  noteActiveCronJobRemoval,
  requestActiveCronJobCancellation,
  resetCronActiveJobs,
} from "../active-jobs.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { update } from "../service/ops-mutations.js";
import {
  assertServiceCronRunReceiptCurrent,
  markServiceCronJobActive,
} from "../service/run-receipts.js";
import {
  makeForeignOwner,
  observeCronRecoveryForTest,
  recoverCronRunForTest,
} from "../service/run-recovery.test-support.js";
import { createCronServiceState, type CronServiceDeps } from "../service/state.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob, CronJobPatch, CronStoredJob, CronToolsAllowProvenance } from "../types.js";
import { cronStoreKey } from "./key.js";
import {
  activateCronRunReceiptInDatabase,
  CronRunReceiptConflictError,
  CronRunReceiptRevisionError,
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptAsync,
  listActiveCronRunReceiptJobIdsInDatabase,
  prepareCronRunReceiptClaim,
  readCronRunReceiptCurrentJob,
  releaseLocalCronRunReceiptOwnership,
} from "./run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  claimCronRunReceiptInDatabaseForTest,
  inspectActiveCronRunReceipt,
  makeCronReceiptJob,
} from "./run-receipt-store.test-support.js";
import {
  isCronRunTriggerStateRetiredInDatabase,
  retireCronRunTriggerStateInDatabase,
} from "./run-receipt-trigger-state.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-run-receipt-" });

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

it.each(["implicit", "supplied"] as const)(
  "checks receipt availability with the %s transaction without spawning or opening another database",
  async (source) => {
    const { storePath, job } = await storeJob(makeCronReceiptJob("transaction-availability"));
    const handle = claimCronRunReceiptForTest(storePath, job, 1);
    const state = makeState(storePath, (agentId, database) => {
      if (source === "supplied") {
        expect(database?.isTransaction).toBe(true);
      }
      return !isAgentDeletionBlocked(agentId, {}, source === "supplied" ? database : undefined);
    });
    const spawn = vi.spyOn(childProcess, "spawnSync");
    syncBuiltinESMExports();
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    let connections = 0;
    for (let index = 0; index < 3; index += 1) {
      runOpenClawStateWriteTransaction(() => {
        const before = open.mock.calls.length;
        readCronRunReceiptCurrentJob({
          handle,
          resolveAgentId: () => handle.agentId,
          isAgentAvailable: state.deps.isAgentAvailable,
        });
        connections += open.mock.calls.length - before;
      });
    }
    expect(spawn.mock.calls.length).toBe(0);
    expect(connections).toBe(0);
  },
);

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
  it("prepares an exact force-disabled message use and releases at initiation", async ({
    signal,
  }) => {
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
    const response = createDeferred<string>();
    const dnsEntered = createDeferred();
    const releaseDns = createDeferred();
    const readResponse = createDeferred<string>();
    const pending: Promise<unknown>[] = [];
    let use: PreparedEffectUse | undefined;
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
      const copiedRunId = captureCronJobMessageActionAuthority({
        jobId: job.id,
        operationalRunInstance: createOperationalRunInstanceRef(operationalRunInstance.runId),
      });
      expect(message?.prepareUse).toBeTypeOf("function");
      expect(source?.prepareUse).toBeTypeOf("function");
      expect(copiedRunId).toThrow("no longer active");
      expect(() => copiedRunId!.prepareUse!()).toThrow("no longer active");
      sql = observeMainThreadSql();
      sql.calibrate();
      use = await source!.prepareUse!();
      use.assertCurrent();
      use.release();
      use = await message!.prepareUse!();
      const initiate = vi.fn(() => response.promise);
      const delivered = use.initiate(initiate);
      sql.expectIdle();
      sql.restore();
      sql = undefined;
      expect(source).not.toThrow();
      expect(message).not.toThrow();
      expect(initiate).toHaveBeenCalledOnce();
      expect(() => use!.initiate(initiate)).toThrow();
      const providerError = new Error("provider read failed");
      await expect(
        withPreparedChannelReadAuthority(source!.prepareUse, source, async () => {
          const result = await fetchWithSsrFGuard({
            url: "https://public.example/provider-failure",
            lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
            fetchImpl: async () => {
              throw providerError;
            },
          });
          await result.release();
        }),
      ).rejects.toBe(providerError);
      const fetchImpl = vi.fn(async () => new Response("private provider response"));
      const fetched = withEffectPreparation(message!.prepareUse, async () => {
        const result = await fetchWithSsrFGuard({
          url: "https://public.example/cron-message",
          fetchImpl,
          lookupFn: async () => {
            dnsEntered.resolve();
            await releaseDns.promise;
            return [{ address: "93.184.216.34", family: 4 }];
          },
        });
        await result.release();
        return result.response;
      });
      const fetchDenied = expect(fetched).rejects.toThrow("no longer active");
      const read = withPreparedChannelReadAuthority(
        source!.prepareUse,
        source,
        () => readResponse.promise,
        signal,
      );
      const disclosureDenied = expect(read).rejects.toThrow("no longer active");
      pending.push(fetched, fetchDenied, read, disclosureDenied);
      await withinTest(
        awaitGateBeforeSettlement(dnsEntered.promise, fetched, "Provider request skipped DNS gate"),
        signal,
      );
      await withinTest(
        update(state, job.id, { payload: { kind: "agentTurn", toolsAllow: ["read"] } }),
        signal,
      );
      releaseDns.resolve();
      readResponse.resolve("private contents must not be disclosed");
      await Promise.all([fetchDenied, disclosureDenied]);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(message).toThrow("no longer active");
      expect(() => message!.prepareUse!()).toThrow("no longer active");
      response.resolve("accepted before revocation");
      await expect(delivered).resolves.toBe("accepted before revocation");
      expect(initiate).toHaveBeenCalledOnce();
    } finally {
      sql?.restore();
      use?.release();
      response.resolve("settled");
      releaseDns.resolve();
      readResponse.resolve("settled");
      await Promise.allSettled(pending);
      admission.close();
      state.timer?.cancel();
      resetCronActiveJobs();
      await finishCronRunReceiptAsync({ handle: receipt, status: "ok", finishedAtMs: Date.now() });
    }
  });

  it.each([
    { writer: "service", enabled: true, mutation: "tool policy" },
    { writer: "service", enabled: false, mutation: "tool policy" },
    { writer: "canonical store", enabled: true, mutation: "tool policy" },
    { writer: "service", enabled: true, mutation: "origin" },
    { writer: "canonical store", enabled: true, mutation: "origin" },
    { writer: "service", enabled: true, mutation: "native name" },
    { writer: "service", enabled: true, mutation: "native delivery" },
    { writer: "service", enabled: true, mutation: "native requester" },
    { writer: "service", enabled: true, mutation: "native trigger state" },
  ] as const)(
    "retires message access after $writer $mutation changes from enabled=$enabled without retiring its receipt",
    async ({ writer, enabled, mutation }) => {
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
      const receiptContext = captureOpenClawStateReadWorkerContext();
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
        const prepared = await assertMessageCurrent!.prepareUse!();
        prepared.release();
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
              if (writer === "service") {
                await update(
                  state,
                  job.id,
                  { payload: { kind: "agentTurn", toolsAllow: ["message", "exec"] } },
                  { toolsAllowProvenance: originProvenance },
                );
              } else {
                await saveCronStore(storePath, {
                  version: 1,
                  jobs: [{ ...job, toolsAllowProvenance: originProvenance }],
                });
                expect(assertSourceCurrent).toThrow();
              }
            }
          } else if (writer === "service") {
            await update(state, job.id, { payload: { kind: "agentTurn", toolsAllow: ["read"] } });
            await update(state, job.id, {
              payload: { kind: "agentTurn", toolsAllow: ["message"] },
            });
          } else {
            await saveCronStore(storePath, {
              version: 1,
              jobs: [{ ...job, payload: { kind: "command", argv: ["true"] } }],
            });
            expect(assertSourceCurrent).toThrow();
            expect(assertMessageCurrent).toThrow();
            await saveCronStore(storePath, { version: 1, jobs: [job] });
          }
        }
        await expect(
          Promise.resolve().then(async () => {
            const use = await assertSourceCurrent!.prepareUse!();
            use.release();
          }),
        ).rejects.toThrow();
        expect(assertSourceCurrent).toThrow();
        if (mutation === "tool policy") {
          expect(assertMessageCurrent).toThrow();
        } else {
          const use = await assertMessageCurrent!.prepareUse!();
          use.initiate(() => assertMessageCurrent!());
          expect(assertMessageCurrent).not.toThrow();
        }
        expect(controller.signal.aborted).toBe(false);
        await expect(
          assertServiceCronRunReceiptCurrent(state, receipt, marker, receiptContext),
        ).resolves.toBeUndefined();
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
        if (state.timer) {
          state.timer.cancel();
        }
        await finishCronRunReceiptAsync({
          handle: receipt,
          status: "ok",
          finishedAtMs: Date.now(),
        });
        resetCronActiveJobs();
      }
    },
  );

  it("reports the recorded database refusal when a scheduled agent is unavailable", async () => {
    const { storePath, job } = await storeJob(makeCronReceiptJob("database-refusal"));
    const receipt = claimCronRunReceiptForTest(storePath, job, Date.now());
    const reason = "Refused agent alpha: its database belongs to main.";
    recordAgentDatabaseAdmissions([
      {
        agentId: "alpha",
        paths: ["/synthetic/alpha/openclaw-agent.sqlite"],
        embeddedOwnerId: "main",
        code: "agent-database-ownership-mismatch",
        reason,
        repairHint: "Inspect the copy, then restart.",
      },
    ]);
    try {
      expect(() =>
        readCronRunReceiptCurrentJob({
          handle: receipt,
          resolveAgentId: (current) => current.agentId!,
          isAgentAvailable: () => false,
        }),
      ).toThrow(reason);
    } finally {
      recordAgentDatabaseAdmissions([]);
      await finishCronRunReceiptAsync({
        handle: receipt,
        status: "error",
        finishedAtMs: Date.now(),
        error: reason,
      });
    }
  });

  it.each([
    "self-removed",
    "operator-removed",
    "cancelled",
    "copied guard",
    "copied marker",
    "replaced marker",
    "retired generation",
    "closed receipt",
    "foreign receipt owner",
    "unavailable agent",
  ] as const)("revalidates completion ownership for a %s job", async (scenario) => {
    const { storePath, job } = await storeJob(makeCronReceiptJob("removed-completion"));
    const receipt = claimCronRunReceiptForTest(storePath, job, Date.now());
    const receiptContext = captureOpenClawStateReadWorkerContext();
    let liveReceipt = receipt;
    const marker = markCronJobActive(job.id)!;
    const controller = new AbortController();
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("removed-completion-run"),
      facts: {
        runId: "removed-completion-run",
        agentId: job.agentId!,
        ingress: { kind: "schedule", boundary: "cron.script", state: "present" },
      },
    });
    try {
      const context = await admission.admit("gateway");
      bindCronJobAdmittedRun(marker, context, controller.signal);
      const guard = () => {};
      bindCronSelfRemovalCommitGuard(job.id, context.operationalRunInstance, guard, () => {});
      await saveCronStore(storePath, { version: 1, jobs: [] });
      noteActiveCronJobRemoval(
        job.id,
        scenario === "operator-removed"
          ? undefined
          : scenario === "copied guard"
            ? () => guard()
            : guard,
      );
      admission.close();
      if (scenario === "cancelled") {
        requestActiveCronJobCancellation(job.id, "cancelled after removal");
      } else if (scenario === "replaced marker") {
        markCronJobActive(job.id);
      } else if (scenario === "retired generation") {
        advanceCronActiveJobGeneration();
      } else if (scenario === "closed receipt") {
        await finishCronRunReceiptAsync({
          handle: receipt,
          status: "ok",
          finishedAtMs: Date.now(),
        });
      } else if (scenario === "foreign receipt owner") {
        liveReceipt = makeForeignOwner(receipt).handle;
      }
      const state = makeState(storePath, () => scenario !== "unavailable agent");
      const assertCurrent = () =>
        assertServiceCronRunReceiptCurrent(
          state,
          receipt,
          scenario === "copied marker" ? { ...marker } : marker,
          receiptContext,
        );
      if (scenario === "self-removed") {
        await expect(assertCurrent()).resolves.toBeUndefined();
      } else {
        await expect(assertCurrent()).rejects.toBeInstanceOf(CronRunReceiptRevisionError);
      }
    } finally {
      admission.close();
      await finishCronRunReceiptAsync({
        handle: liveReceipt,
        status: "ok",
        finishedAtMs: Date.now(),
      });
      resetCronActiveJobs();
    }
  });

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

  it.each(["reopened", "missing"] as const)(
    "refuses receipt guards whose storage is %s without reacquiring authority",
    async (storage) => {
      const { storePath, job } = await storeJob(makeCronReceiptJob(`${storage}-guard-storage`));
      const handle = claimCronRunReceiptForTest(storePath, job, Date.now());
      const context = captureOpenClawStateReadWorkerContext();
      const state = makeState(storePath);
      try {
        if (storage === "reopened") {
          await closeOpenClawStateDatabaseAsync();
          openOpenClawStateDatabase();
          const replacementContext = captureOpenClawStateReadWorkerContext();
          await expect(
            assertServiceCronRunReceiptCurrent(state, handle, undefined, context),
          ).rejects.toBeInstanceOf(StateDatabaseReadAdmissionInvalidatedError);
          await expect(
            assertServiceCronRunReceiptCurrent(state, handle, undefined, replacementContext),
          ).resolves.toBeUndefined();
        } else {
          const database = openOpenClawStateDatabase().db;
          database.exec("DROP TABLE cron_run_receipts");
          expect(() =>
            readCronRunReceiptCurrentJob({ handle, resolveAgentId: () => job.agentId! }),
          ).toThrow(CronRunReceiptRevisionError);
          await expect(
            assertServiceCronRunReceiptCurrent(state, handle, undefined, context),
          ).rejects.toBeInstanceOf(CronRunReceiptRevisionError);
          expect(
            database
              .prepare("SELECT name FROM sqlite_schema WHERE name = 'cron_run_receipts'")
              .get(),
          ).toBeUndefined();
        }
      } finally {
        releaseLocalCronRunReceiptOwnership(handle);
      }
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

  it.each(["dead", "reused", "unreadable"] as const)(
    "retires a stale %s process claim before admitting its successor",
    async (owner) => {
      const { storePath, job } = await storeJob(makeCronReceiptJob(`restart-${owner}`));
      const startedAtMs = Date.now();
      const abandoned = claimCronRunReceiptForTest(storePath, job, startedAtMs);
      if (owner === "dead") {
        openOpenClawStateDatabase()
          .db.prepare("UPDATE cron_run_receipts SET owner_pid = ? WHERE receipt_id = ?")
          .run(2_147_483_647, abandoned.receiptId);
        releaseLocalCronRunReceiptOwnership(abandoned);
      } else {
        const foreign = makeForeignOwner(abandoned);
        foreign.startTimeProbe.mockImplementation((pid) =>
          pid === foreign.handle.ownerPid
            ? owner === "unreadable"
              ? null
              : abandoned.ownerStartTime! + 1
            : foreign.getStartTime(pid),
        );
      }
      vi.setSystemTime(startedAtMs + (owner === "unreadable" ? 2 * 60 * 60_000 : 0) + 1);

      const replacement = claimCronRunReceiptForTest(storePath, job, Date.now());

      expect(replacement.receiptId).not.toBe(abandoned.receiptId);
      expect(receipts(storePath, job.id)).toMatchObject([
        { receiptId: replacement.receiptId, status: "running" },
        { receiptId: abandoned.receiptId, status: "interrupted" },
      ]);
      await finishCronRunReceiptAsync({
        handle: replacement,
        status: "ok",
        finishedAtMs: Date.now() + 1,
      });
    },
  );

  it.each(["canonical", "unrepaired"])(
    "recovers an unreadable foreign owner only after the stuck-run horizon with %s delivery",
    async (delivery) => {
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.now();
      const job = makeCronReceiptJob("unreadable-owner");
      job.state.runningAtMs = startedAtMs;
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const foreign = makeForeignOwner(claimCronRunReceiptForTest(storePath, job, startedAtMs));
      const database = openOpenClawStateDatabase().db;
      if (delivery === "unrepaired") {
        database
          .prepare(
            "UPDATE cron_jobs SET job_json = json_remove(job_json, '$.delivery.mode') WHERE store_key = ? AND job_id = ?",
          )
          .run(cronStoreKey(storePath), job.id);
      }
      const definition = () =>
        database
          .prepare("SELECT job_json FROM cron_jobs WHERE store_key = ? AND job_id = ?")
          .get(cronStoreKey(storePath), job.id)?.job_json;
      const originalDefinition = definition();
      const state = makeState(storePath);
      const proposal = await observeCronRecoveryForTest(state, job.id, undefined, startedAtMs);
      expect(await recoverCronRunForTest(state, proposal)).toMatchObject({ kind: "live" });

      foreign.startTimeProbe.mockImplementation((pid) =>
        pid === foreign.handle.ownerPid ? null : foreign.getStartTime(pid),
      );
      vi.setSystemTime(startedAtMs + 2 * 60 * 60_000);
      expect(await recoverCronRunForTest(state, proposal)).toMatchObject({ kind: "live" });
      expect(() => claimCronRunReceiptForTest(storePath, job, Date.now())).toThrow(
        CronRunReceiptConflictError,
      );
      vi.setSystemTime(Date.now() + 1);

      expect(await recoverCronRunForTest(state, proposal)).toMatchObject({ kind: "repaired" });
      const recovered = (await loadCronStore(storePath)).jobs[0]!;
      expect(recovered.state).toMatchObject({ lastRunStatus: "error" });
      expect(recovered.state.runningAtMs).toBeUndefined();
      expect(receipts(storePath, job.id)).toMatchObject([
        { receiptId: foreign.handle.receiptId, status: "interrupted" },
      ]);
      expect(() =>
        readCronRunReceiptCurrentJob({
          handle: foreign.handle,
          resolveAgentId: () => job.agentId!,
        }),
      ).toThrow(CronRunReceiptRevisionError);
      expect(definition()).toBe(originalDefinition);
      if (delivery === "unrepaired") {
        expect(() => claimCronRunReceiptForTest(storePath, recovered, Date.now())).toThrow(
          "openclaw doctor --fix",
        );
      } else {
        const successor = claimCronRunReceiptForTest(storePath, recovered, Date.now());
        await finishCronRunReceiptAsync({
          handle: successor,
          status: "ok",
          finishedAtMs: Date.now() + 1,
        });
      }
    },
  );

  it.each(["local", "foreign"] as const)(
    "keeps a verified %s owner fenced beyond the stuck-run horizon",
    async (owner) => {
      const { storePath, job } = await storeJob(makeCronReceiptJob(`verified-${owner}`));
      const startedAtMs = Date.now();
      const claimed = claimCronRunReceiptForTest(storePath, job, startedAtMs);
      const handle = owner === "foreign" ? makeForeignOwner(claimed).handle : claimed;
      vi.setSystemTime(startedAtMs + 3 * 60 * 60_000);

      expect(() => claimCronRunReceiptForTest(storePath, job, Date.now())).toThrow(
        CronRunReceiptConflictError,
      );
      expect(receipts(storePath, job.id)).toMatchObject([
        { receiptId: handle.receiptId, status: "running", startedAtMs },
      ]);
      await finishCronRunReceiptAsync({ handle, status: "ok", finishedAtMs: Date.now() });
      if (owner === "local") {
        const successor = claimCronRunReceiptForTest(storePath, job, Date.now() + 1);
        await finishCronRunReceiptAsync({
          handle: successor,
          status: "skipped",
          finishedAtMs: Date.now() + 2,
        });
        expect(receipts(storePath, job.id).map((receipt) => receipt.status)).toEqual([
          "skipped",
          "ok",
        ]);
      }
    },
  );

  it("invalidates stale-owner adjudication when a queued receipt starts running", async () => {
    const { storePath, job } = await storeJob(makeCronReceiptJob("unreadable-queued-owner"));
    const startedAtMs = Date.now();
    const foreign = makeForeignOwner(claimCronRunReceiptForTest(storePath, job, startedAtMs));
    foreign.startTimeProbe.mockImplementation((pid) =>
      pid === foreign.handle.ownerPid ? null : foreign.getStartTime(pid),
    );
    vi.setSystemTime(startedAtMs + 2 * 60 * 60_000 + 1);
    const prepared = prepareCronRunReceiptClaim({
      storePath,
      job,
      agentId: job.agentId!,
      startedAtMs: Date.now(),
      observed: inspectActiveCronRunReceipt({ storePath, jobId: job.id }),
    });
    const running = runOpenClawStateWriteTransaction(({ db }) =>
      activateCronRunReceiptInDatabase({
        database: db,
        handle: foreign.handle,
        startedAtMs: Date.now(),
        resolveAgentId: () => job.agentId!,
      }),
    );

    expect(() =>
      runOpenClawStateWriteTransaction(({ db }) =>
        claimCronRunReceiptInDatabaseForTest({
          database: db,
          prepared,
          resolveAgentId: () => job.agentId!,
        }),
      ),
    ).toThrow(CronRunReceiptConflictError);
    expect(receipts(storePath, job.id)).toMatchObject([
      { receiptId: running.receiptId, status: "running", startedAtMs: Date.now() },
    ]);
    await finishCronRunReceiptAsync({
      handle: running,
      status: "ok",
      finishedAtMs: Date.now() + 1,
    });
  });

  it("rejects a live run after its durable owner revision changes", async () => {
    const { storePath, job: admitted } = await storeJob(
      makeCronReceiptJob("owner-change", "alpha"),
    );
    const receipt = claimCronRunReceiptForTest(storePath, admitted, 300);
    const reassigned = { ...admitted, agentId: "beta", updatedAtMs: 2 };
    await saveCronStore(storePath, { version: 1, jobs: [reassigned] });

    expect(() =>
      readCronRunReceiptCurrentJob({
        handle: receipt,
        resolveAgentId: (job) => job.agentId!,
      }),
    ).toThrow(CronRunReceiptRevisionError);

    await finishCronRunReceiptAsync({
      handle: receipt,
      status: "superseded",
      finishedAtMs: 310,
      error: "owner changed",
    });
    expect(receipts(storePath, admitted.id)[0]).toMatchObject({
      status: "superseded",
      agentId: "alpha",
      error: "owner changed",
    });
  });
});
