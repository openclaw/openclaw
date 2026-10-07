// Cron standing grants: mint-at-resolution, fail-closed consumption, restart survival.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { withCronReceiptAuthorityMutation } from "../cron/store/receipt-authority-owner.js";
import {
  deleteCronJobRowInDatabase,
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import {
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "../cron/store/run-receipt-store.js";
import { claimCronRunReceiptInDatabaseForTest } from "../cron/store/run-receipt-store.test-support.js";
import type { CronRunReceiptHandle } from "../cron/store/run-receipt.types.js";
import type { CronStoredJob } from "../cron/types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } from "../state/openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import {
  buildCronExecOperationBinding,
  mintCronStandingGrantLocked,
  parseCronExecOperationBinding,
} from "./operator-approval-standing-grants.js";
import {
  closeOrphanedOperatorApprovals,
  listCronStandingGrants,
  revokeCronStandingGrant,
  insertOperatorApproval,
  resolveOperatorApproval,
  validateCronStandingGrant,
  consumeCronStandingGrant,
} from "./operator-approval-store.js";
import { insertOperatorApprovalInDatabase as insertOperatorApprovalNative } from "./operator-approval-store.kernel.js";
import { resolveOperatorApprovalInDatabase as resolveOperatorApprovalNative } from "./operator-approval-store.transitions.js";

type StandingGrantDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "operator_approval_standing_grants"
  | "operator_approval_standing_grant_generations"
  | "operator_approvals"
  | "cron_jobs"
>;
type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];

const CRON_STORE_KEY = "/tmp/openclaw-standing-grant-test-store";
const NOW_MS = 1_756_000_000_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

const tempDirs: string[] = [];
const receipts = new WeakMap<OpenClawStateDatabaseOptions, CronRunReceiptHandle>();
const claimedReceipts: CronRunReceiptHandle[] = [];

const PREVIOUS_STANDING_GRANT_SCHEMA = OPENCLAW_STATE_SCHEMA_SQL.replace(
  `CREATE TABLE IF NOT EXISTS operator_approval_standing_grant_generations (
  grant_id TEXT NOT NULL PRIMARY KEY
    REFERENCES operator_approval_standing_grants(grant_id) ON DELETE CASCADE,
  job_definition_generation INTEGER NOT NULL CHECK (job_definition_generation >= 1)
) STRICT;

`,
  "",
)
  .replace("  grant_definition_revision TEXT,\n", "")
  .replace("  grant_definition_generation INTEGER,\n", "")
  .replace("  grant_definition_updated_at INTEGER,\n", "");

const GRANT_TABLE_SQL = `
  CREATE TABLE operator_approval_standing_grants (
    grant_id TEXT NOT NULL PRIMARY KEY CHECK (length(grant_id) > 0),
    minted_by_approval_id TEXT NOT NULL
      REFERENCES operator_approvals(approval_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
    cron_job_id TEXT NOT NULL CHECK (length(cron_job_id) > 0),
    job_config_revision TEXT NOT NULL CHECK (length(job_config_revision) > 0),
    operation_binding TEXT NOT NULL CHECK (length(operation_binding) > 0),
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= created_at_ms),
    revoked_at_ms INTEGER,
    revoked_by TEXT,
    last_used_at_ms INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0
  ) STRICT;
`;

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-standing-grant-")),
  );
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const receipt of claimedReceipts.splice(0)) {
    releaseLocalCronRunReceiptOwnership(receipt);
  }
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function approval(id: string, overrides: Partial<NewOperatorApproval> = {}): NewOperatorApproval {
  return {
    id,
    kind: "exec",
    presentation: {
      kind: "exec",
      commandText: "echo standing",
      commandPreview: "echo standing",
      warningText: null,
      host: "gateway",
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: { deviceId: "device-1", clientId: "client-1", deviceTokenAuth: true },
    reviewerDeviceIds: [],
    source: {
      agentId: "main",
      sessionKey: "agent:main:cron:job-1",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: null,
      toolName: "exec",
    },
    audienceSessionKeys: [],
    runtimeEpoch: "epoch-1",
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 60_000,
    ...overrides,
  };
}

function cronJob(overrides: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    id: "job-1",
    agentId: "main",
    name: "Standing grant job",
    enabled: true,
    createdAtMs: NOW_MS - 1_000,
    updatedAtMs: NOW_MS - 1_000,
    schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run the backup" },
    ...overrides,
  } as CronStoredJob;
}

/** Persists the job and returns the revision the loader observes for it. */
function seedCronJob(
  databaseOptions: OpenClawStateDatabaseOptions,
  job: CronStoredJob = cronJob(),
): string {
  const database = openOpenClawStateDatabase(databaseOptions);
  upsertCronJobRow(database.db, CRON_STORE_KEY, job, 0);
  const loaded = loadedCronStoreFromRows(loadCronRows(database.db, CRON_STORE_KEY));
  const loadedJob = loaded.store.jobs.find((entry) => entry.id === job.id);
  if (!loadedJob) {
    throw new Error(`seeded cron job ${job.id} did not load back`);
  }
  if (!receipts.has(databaseOptions)) {
    const prepared = prepareCronRunReceiptClaim({
      storePath: CRON_STORE_KEY,
      job: loadedJob,
      agentId: "main",
      startedAtMs: NOW_MS,
      observed: undefined,
    });
    receipts.set(
      databaseOptions,
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          claimCronRunReceiptInDatabaseForTest({
            database: db,
            prepared,
            resolveAgentId: (current) => current.agentId ?? "main",
          }),
        databaseOptions,
      ),
    );
    claimedReceipts.push(receipts.get(databaseOptions)!);
  }
  return resolveCronJobConfigRevision(loadedJob);
}

const OPERATION_BINDING = buildCronExecOperationBinding({
  command: "echo standing",
  cwd: "/work",
  env: undefined,
});

async function mintGrant(params: {
  databaseOptions: OpenClawStateDatabaseOptions;
  approvalId?: string;
  jobConfigRevision: string;
  operationBinding?: string;
  nowMs?: number;
  expiresAtMs?: number | null;
}): Promise<void> {
  const approvalId = params.approvalId ?? "approval-1";
  await insertOperatorApproval({
    approval: approval(approvalId),
    databaseOptions: params.databaseOptions,
  });
  const resolved = await resolveOperatorApproval({
    id: approvalId,
    decision: "allow-always",
    resolver: { kind: "device", id: "reviewer-1" },
    nowMs: params.nowMs ?? NOW_MS + 1_000,
    databaseOptions: params.databaseOptions,
    standingGrant: {
      kind: "cron",
      agentId: "main",
      cronJobId: "job-1",
      jobConfigRevision: params.jobConfigRevision,
      operationBinding: params.operationBinding ?? OPERATION_BINDING,
      expiresAtMs: params.expiresAtMs !== undefined ? params.expiresAtMs : null,
    },
  });
  expect(resolved.outcome).toBe("resolved");
}

function readGrantRows(databaseOptions: OpenClawStateDatabaseOptions) {
  const database = openOpenClawStateDatabase(databaseOptions);
  if (!tableExists(database.db, "operator_approval_standing_grants")) {
    return null;
  }
  const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    stateDb.selectFrom("operator_approval_standing_grants").selectAll(),
  ).rows;
}

async function seedMintedGrant(opts: { expiresAtMs?: number | null } = {}) {
  const databaseOptions = createDatabaseOptions();
  const revision = seedCronJob(databaseOptions);
  await mintGrant({ databaseOptions, jobConfigRevision: revision, ...opts });
  const database = openOpenClawStateDatabase(databaseOptions);
  const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(database.db);
  return { databaseOptions, revision, database, stateDb };
}

function grantInput(params: {
  databaseOptions: OpenClawStateDatabaseOptions;
  revision: string;
  operationBinding?: string;
  nowMs?: number;
}) {
  return {
    agentId: "main",
    cronJobId: "job-1",
    jobConfigRevision: params.revision,
    operationBinding: params.operationBinding ?? OPERATION_BINDING,
    nowMs: params.nowMs ?? NOW_MS + 10_000,
    handle: receipts.get(params.databaseOptions)!,
  };
}

function consumeInWorker(
  databaseOptions: OpenClawStateDatabaseOptions,
  input: Parameters<typeof consumeCronStandingGrant>[1],
) {
  const context = captureOpenClawStateWorkerContext(databaseOptions);
  return consumeCronStandingGrant(
    context,
    input,
    () => {},
    (run) => withCronReceiptAuthorityMutation(context, run),
  );
}

function consume(params: Parameters<typeof grantInput>[0]) {
  return consumeInWorker(params.databaseOptions, { ...grantInput(params), recordUse: true });
}

describe("cron standing grant mint", () => {
  it.each([null, NOW_MS + 1_000 + THIRTY_DAYS_MS])(
    "mints a scoped grant with frozen expiry %s in the resolution transaction",
    async (expiresAtMs) => {
      const databaseOptions = createDatabaseOptions();
      const revision = seedCronJob(databaseOptions);
      await mintGrant({ databaseOptions, jobConfigRevision: revision, expiresAtMs });
      const rows = readGrantRows(databaseOptions);
      expect(rows).toHaveLength(1);
      const grant = rows![0]!;
      expect(grant.minted_by_approval_id).toBe("approval-1");
      expect(grant.agent_id).toBe("main");
      expect(grant.cron_job_id).toBe("job-1");
      expect(grant.job_config_revision).toBe(revision);
      const database = openOpenClawStateDatabase(databaseOptions);
      const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(database.db);
      const generationRows = executeSqliteQuerySync(
        database.db,
        stateDb.selectFrom("operator_approval_standing_grant_generations").selectAll(),
      ).rows;
      expect(generationRows).toEqual([{ grant_id: grant.grant_id, job_definition_generation: 1 }]);
      expect(grant.operation_binding).toBe(OPERATION_BINDING);
      expect(grant.created_at_ms).toBe(NOW_MS + 1_000);
      expect(grant.expires_at_ms).toBe(expiresAtMs);
      expect(grant.revoked_at_ms).toBeNull();
      expect(grant.use_count).toBe(0);
    },
  );

  it("rolls back first-use companion creation and retries on the same database", async () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    await insertOperatorApproval({ approval: approval("approval-1"), databaseOptions });
    const database = openOpenClawStateDatabase(databaseOptions);
    database.db.exec(GRANT_TABLE_SQL);

    expect(() =>
      runOpenClawStateWriteTransaction((lockedDatabase) => {
        mintCronStandingGrantLocked(lockedDatabase, {
          approvalId: "approval-1",
          agentId: "main",
          cronJobId: "job-1",
          jobConfigRevision: revision,
          operationBinding: OPERATION_BINDING,
          nowMs: NOW_MS + 1_000,
          expiresAtMs: null,
        });
        throw new Error("force outer rollback");
      }, databaseOptions),
    ).toThrow("force outer rollback");
    expect(
      runSqliteReadOperationSync(database.db, () =>
        tableExists(database.db, "operator_approval_standing_grant_generations"),
      ),
    ).toBe(false);

    const resolved = await resolveOperatorApproval({
      id: "approval-1",
      decision: "allow-always",
      resolver: { kind: "device", id: "reviewer-1" },
      nowMs: NOW_MS + 2_000,
      databaseOptions,
      standingGrant: {
        kind: "cron",
        agentId: "main",
        cronJobId: "job-1",
        jobConfigRevision: revision,
        operationBinding: OPERATION_BINDING,
        expiresAtMs: null,
      },
    });
    expect(resolved.outcome).toBe("resolved");
    expect(
      runSqliteReadOperationSync(database.db, () =>
        tableExists(database.db, "operator_approval_standing_grant_generations"),
      ),
    ).toBe(true);
    expect((await consume({ databaseOptions, revision, nowMs: NOW_MS + 3_000 })).outcome).toBe(
      "consumed",
    );
  });

  it("survives a previous-schema reader and candidate reopen", async () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    await mintGrant({ databaseOptions, jobConfigRevision: revision });
    const pathname = openOpenClawStateDatabase(databaseOptions).path;
    await closeOpenClawStateDatabaseAsync();

    const previousReader = new DatabaseSync(pathname);
    try {
      expect(() =>
        assertSqliteSchemaContains(
          previousReader,
          "previous standing-grant schema",
          PREVIOUS_STANDING_GRANT_SCHEMA,
          OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
        ),
      ).not.toThrow();
      expect(
        previousReader
          .prepare("SELECT COUNT(*) AS count FROM operator_approval_standing_grants")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      previousReader.close();
    }

    expect((await consume({ databaseOptions, revision, nowMs: NOW_MS + 2_000 })).outcome).toBe(
      "consumed",
    );
  });

  it("does not create the table or mint for non-allow-always decisions", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({ approval: approval("approval-1"), databaseOptions });
    const resolved = await resolveOperatorApproval({
      id: "approval-1",
      decision: "allow-once",
      resolver: { kind: "device", id: "reviewer-1" },
      nowMs: NOW_MS + 1_000,
      databaseOptions,
      standingGrant: {
        kind: "cron",
        agentId: "main",
        cronJobId: "job-1",
        jobConfigRevision: "sha256:rev",
        operationBinding: OPERATION_BINDING,
        expiresAtMs: null,
      },
    });
    expect(resolved.outcome).toBe("resolved");
    expect(readGrantRows(databaseOptions)).toBeNull();
  });

  it("replaces the prior grant for the same agent, job, and binding", async () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    await mintGrant({ databaseOptions, jobConfigRevision: revision });
    await mintGrant({
      databaseOptions,
      approvalId: "approval-2",
      jobConfigRevision: revision,
      nowMs: NOW_MS + 5_000,
    });
    const rows = readGrantRows(databaseOptions);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.minted_by_approval_id).toBe("approval-2");
  });

  it.each([false, true])(
    "freezes manager grant terms (configured expiry: %s)",
    async (configured) => {
      const databaseOptions = createDatabaseOptions();
      const revision = seedCronJob(databaseOptions);
      const request = {
        command: "echo standing",
        host: "gateway",
        agentId: "main",
        runId: "run-1",
        cronExecutionSource: { jobId: "job-1", jobConfigRevision: revision },
        cronOperationBinding: OPERATION_BINDING,
      };
      const configuredExpiresAtMs = configured ? Date.now() + 10 * 24 * 60 * 60_000 : null;
      const manager = new ExecApprovalManager({
        scheduler: createTestGatewayScheduler(),
        approvalKind: "exec",
        persistence: { runtimeEpoch: "epoch-1", databaseOptions },
        resolveAllowedDecisions: () => ["allow-once", "allow-always", "deny"],
        ...(configured ? { resolveStandingGrantExpiresAtMs: () => configuredExpiresAtMs } : {}),
        resolveStandingGrantMint: (payload) => {
          const source = payload.cronExecutionSource;
          if (!source || !payload.cronOperationBinding || !payload.agentId) {
            return null;
          }
          return {
            kind: "cron",
            agentId: payload.agentId,
            cronJobId: source.jobId,
            jobConfigRevision: source.jobConfigRevision,
            operationBinding: payload.cronOperationBinding,
          };
        },
      });
      const record = manager.create(request, 60_000, "approval-mgr");
      await manager.register(record, 60_000);
      const resolved = await manager.resolveDetailed("approval-mgr", "allow-always", {
        kind: "device",
        id: "reviewer-1",
      });
      expect(resolved.outcome).toBe("resolved");
      const rows = readGrantRows(databaseOptions);
      expect(rows).toHaveLength(1);
      expect(rows![0]!.minted_by_approval_id).toBe("approval-mgr");
      expect(rows![0]!.expires_at_ms).toBe(configuredExpiresAtMs);

      // A non-cron request never mints: the resolver returns null.
      const plainRecord = manager.create(
        { ...request, cronExecutionSource: null },
        60_000,
        "plain",
      );
      await manager.register(plainRecord, 60_000);
      expect(
        (
          await manager.resolveDetailed("plain", "allow-always", {
            kind: "device",
            id: "reviewer-1",
          })
        ).outcome,
      ).toBe("resolved");
      expect(readGrantRows(databaseOptions)).toHaveLength(1);
      if (configured) {
        const overrideExpiresAtMs = Date.now() + 99 * 24 * 60 * 60_000;
        const overrideBinding = buildCronExecOperationBinding({
          command: "echo standing-override",
          cwd: "/work",
          env: undefined,
        });
        const overrideRecord = manager.create(
          { ...request, cronOperationBinding: overrideBinding },
          60_000,
          "approval-override",
        );
        await manager.register(overrideRecord, 60_000);
        expect(
          (
            await manager.resolveDetailed(
              "approval-override",
              "allow-always",
              { kind: "device", id: "reviewer-1" },
              null,
              "operator",
              { grantExpiresAtMs: overrideExpiresAtMs },
            )
          ).outcome,
        ).toBe("resolved");
        const overrideRow = readGrantRows(databaseOptions)!.find(
          (row) => row.minted_by_approval_id === "approval-override",
        );
        expect(overrideRow?.expires_at_ms).toBe(overrideExpiresAtMs);
      }
    },
  );
});

describe("cron standing grant consumption", () => {
  it("serializes concurrent consumes and records each committed use", async () => {
    const { databaseOptions, revision } = await seedMintedGrant();
    const [first, second] = await Promise.all([
      consume({ databaseOptions, revision }),
      consume({ databaseOptions, revision, nowMs: NOW_MS + 20_000 }),
    ]);
    expect(first.outcome).toBe("consumed");
    if (first.outcome !== "consumed") {
      throw new Error("expected consumed");
    }
    expect(first.grant.useCount).toBe(1);
    expect(first.grant.lastUsedAtMs).toBe(NOW_MS + 10_000);
    expect(first.grant.mintedByApprovalId).toBe("approval-1");
    expect(second.outcome).toBe("consumed");
    if (second.outcome !== "consumed") {
      throw new Error("expected consumed");
    }
    expect(second.grant.useCount).toBe(2);
  });

  it.each([
    ["different operation binding", ["no-grant"]],
    ["different cwd", ["no-grant"]],
    ["different env", ["no-grant"]],
    ["ambiguous job store", ["job-missing"]],
    ["generation mismatch", ["job-revision-changed"]],
    ["stale updated-at projection", ["job-revision-changed"]],
    ["reversed parent", ["approval-not-allow-always"]],
    ["stamped expiry passed", ["expired"]],
    ["deleted job", ["job-missing"]],
    ["recreated job", ["revoked"]],
    ["changed run revision", ["job-revision-changed"]],
    ["missing definition generation", ["job-revision-changed"]],
    ["authoritative job changed under a stale run", ["job-revision-changed"]],
    ["deleted minting approval", ["approval-missing", "no-grant"]],
  ] as const)("fails closed for %s", async (reason, outcomes) => {
    const expiresAtMs = NOW_MS + 1_000 + THIRTY_DAYS_MS;
    const { databaseOptions, revision, database, stateDb } = await seedMintedGrant({
      expiresAtMs: reason === "stamped expiry passed" ? expiresAtMs : null,
    });
    const input: Parameters<typeof consume>[0] = { databaseOptions, revision };
    if (reason === "different operation binding") {
      input.operationBinding = buildCronExecOperationBinding({
        command: "echo different",
        cwd: "/work",
        env: undefined,
      });
    } else if (reason === "different cwd" || reason === "different env") {
      input.operationBinding = buildCronExecOperationBinding({
        command: "echo standing",
        cwd: reason === "different cwd" ? "/changed" : "/work",
        env: reason === "different env" ? { SYNTHETIC: "changed" } : undefined,
      });
    } else if (reason === "ambiguous job store") {
      upsertCronJobRow(database.db, `${CRON_STORE_KEY}-other`, cronJob(), 0);
    } else if (reason === "generation mismatch") {
      executeSqliteQuerySync(
        database.db,
        stateDb
          .updateTable("operator_approval_standing_grant_generations")
          .set({ job_definition_generation: 2 }),
      );
    } else if (reason === "stale updated-at projection") {
      executeSqliteQuerySync(
        database.db,
        stateDb.updateTable("cron_jobs").set({ grant_definition_updated_at: NOW_MS - 2_000 }),
      );
    } else if (reason === "reversed parent") {
      executeSqliteQuerySync(
        database.db,
        stateDb.updateTable("operator_approvals").set({ status: "denied", decision: "deny" }),
      );
    } else if (reason === "stamped expiry passed") {
      input.nowMs = expiresAtMs;
    } else if (reason === "deleted job") {
      executeSqliteQuerySync(database.db, stateDb.deleteFrom("cron_jobs"));
    } else if (reason === "recreated job") {
      deleteCronJobRowInDatabase(database.db, CRON_STORE_KEY, "job-1");
      input.revision = seedCronJob(databaseOptions);
      expect(input.revision).toBe(revision);
    } else if (reason === "missing definition generation") {
      executeSqliteQuerySync(
        database.db,
        stateDb.deleteFrom("operator_approval_standing_grant_generations"),
      );
    } else if (reason === "deleted minting approval") {
      executeSqliteQuerySync(
        database.db,
        stateDb.deleteFrom("operator_approvals").where("approval_id", "=", "approval-1"),
      );
    } else {
      const changedRevision = seedCronJob(
        databaseOptions,
        cronJob({ payload: { kind: "agentTurn", message: "changed" } }),
      );
      if (reason === "changed run revision") {
        input.revision = changedRevision;
      }
    }
    // A pruned parent may cascade-delete the derivative grant; neither outcome authorizes it.
    expect(outcomes).toContain((await consume(input)).outcome);
    expect(readGrantRows(databaseOptions)?.every((row) => row.use_count === 0)).toBe(true);
  });

  it("requires the exact running receipt and selected grant without recording refused uses", async () => {
    const { databaseOptions, revision } = await seedMintedGrant();
    const input = grantInput({ databaseOptions, revision });
    const changes: Partial<CronRunReceiptHandle>[] = [
      { receiptId: "another-receipt" },
      { ownerPid: input.handle.ownerPid + 1 },
      { ownerStartTime: input.handle.ownerStartTime! + 1 },
      { startedAtMs: NOW_MS + 1 },
      { storeKey: `${CRON_STORE_KEY}-other` },
      { jobId: "another-job" },
      { agentId: "another-agent" },
      { configRevision: "another-revision" },
    ];
    for (const change of changes) {
      const result = await consumeInWorker(databaseOptions, {
        ...input,
        handle: { ...input.handle, ...change },
        recordUse: true,
      });
      expect(result.outcome).toBe("receipt-not-current");
    }
    const used = await consume({ databaseOptions, revision });
    if (used.outcome !== "consumed") {
      throw new Error("expected consumed");
    }
    const retry = async (expectedGrant = used.grant) =>
      consumeInWorker(databaseOptions, { ...input, recordUse: false, expectedGrant });
    expect(await retry()).toMatchObject({ outcome: "consumed", grant: { useCount: 1 } });
    expect(await retry({ ...used.grant, grantId: "replacement-grant" })).toEqual({
      outcome: "no-grant",
    });
    expect(readGrantRows(databaseOptions)?.[0]?.use_count).toBe(1);
  });

  it("does not reuse a grant generation after an older writer deletes the job", async () => {
    const { databaseOptions, revision } = await seedMintedGrant();
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(database.db);
    const originalRow = executeSqliteQuerySync(
      database.db,
      stateDb.selectFrom("cron_jobs").selectAll().where("job_id", "=", "job-1"),
    ).rows[0]!;
    const pathname = database.path;
    await closeOpenClawStateDatabaseAsync();
    const previousWriter = new DatabaseSync(pathname);
    try {
      previousWriter.prepare("DELETE FROM cron_jobs WHERE job_id = ?").run("job-1");
      previousWriter
        .prepare(
          `INSERT INTO cron_jobs (
             store_key, job_id, declaration_key, owner_agent_id, name, description,
             enabled, agent_id, payload_kind, job_json, state_json,
             runtime_updated_at_ms, schedule_identity, sort_order, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          originalRow.store_key,
          originalRow.job_id,
          originalRow.declaration_key,
          originalRow.owner_agent_id,
          originalRow.name,
          originalRow.description,
          originalRow.enabled,
          originalRow.agent_id,
          originalRow.payload_kind,
          originalRow.job_json,
          originalRow.state_json,
          originalRow.runtime_updated_at_ms,
          originalRow.schedule_identity,
          originalRow.sort_order,
          originalRow.updated_at,
        );
    } finally {
      previousWriter.close();
    }
    const recreatedRevision = seedCronJob(
      databaseOptions,
      cronJob({ updatedAtMs: NOW_MS + 2_000 }),
    );
    expect(recreatedRevision).toBe(revision);

    expect((await consume({ databaseOptions, revision: recreatedRevision })).outcome).toBe(
      "job-revision-changed",
    );
    const reopened = openOpenClawStateDatabase(databaseOptions);
    const reopenedDb = getNodeSqliteKysely<StandingGrantDatabase>(reopened.db);
    expect(
      executeSqliteQuerySync(
        reopened.db,
        reopenedDb.selectFrom("cron_jobs").select("grant_definition_generation"),
      ).rows[0]?.grant_definition_generation,
    ).toBeGreaterThan(1);
  });

  it.each(["current", "older edit", "older edit and restore"] as const)(
    "keeps grants invalid across definition restoration by %s writers",
    async (writer) => {
      const { databaseOptions, revision, database, stateDb } = await seedMintedGrant();
      const originalRow = executeSqliteQuerySync(
        database.db,
        stateDb.selectFrom("cron_jobs").selectAll().where("job_id", "=", "job-1"),
      ).rows[0]!;
      seedCronJob(
        databaseOptions,
        cronJob({
          payload: { kind: "agentTurn", message: "run something else" },
          ...(writer === "older edit and restore" ? { updatedAtMs: NOW_MS + 2_000 } : {}),
        }),
      );
      if (writer === "older edit and restore") {
        seedCronJob(databaseOptions, cronJob({ updatedAtMs: NOW_MS + 3_000 }));
      }
      if (writer !== "current") {
        executeSqliteQuerySync(
          database.db,
          stateDb
            .updateTable("cron_jobs")
            .set({
              grant_definition_revision: originalRow.grant_definition_revision,
              grant_definition_generation: originalRow.grant_definition_generation,
              ...(writer === "older edit and restore"
                ? { grant_definition_updated_at: originalRow.grant_definition_updated_at }
                : {}),
            })
            .where("job_id", "=", "job-1"),
        );
      }
      const restoredRevision =
        writer === "older edit and restore" ? revision : seedCronJob(databaseOptions);
      expect(restoredRevision).toBe(revision);
      expect((await consume({ databaseOptions, revision: restoredRevision })).outcome).toBe(
        "job-revision-changed",
      );
    },
  );

  it("keeps a grant valid across disable and re-enable", async () => {
    const { databaseOptions, revision } = await seedMintedGrant();
    seedCronJob(databaseOptions, cronJob({ enabled: false, updatedAtMs: NOW_MS + 2_000 }));
    expect((await consume({ databaseOptions, revision })).outcome).toBe("job-revision-changed");
    const reenabledRevision = seedCronJob(
      databaseOptions,
      cronJob({ updatedAtMs: NOW_MS + 3_000 }),
    );
    expect(reenabledRevision).toBe(revision);

    expect((await consume({ databaseOptions, revision: reenabledRevision })).outcome).toBe(
      "consumed",
    );
  });

  it("consumes an explicitly approved disabled definition for its matching force-run", async () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions, cronJob({ enabled: false }));
    await mintGrant({ databaseOptions, jobConfigRevision: revision });
    expect((await consume({ databaseOptions, revision })).outcome).toBe("consumed");
  });

  it("survives a gateway restart and orphan cleanup of pending approvals", async () => {
    const { databaseOptions, revision } = await seedMintedGrant();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    // New runtime epoch: startup cancels orphaned pending approvals only; the
    // resolved allow-always parent and its grant remain valid durable truth.
    closeOrphanedOperatorApprovals({
      runtimeEpoch: "epoch-2",
      nowMs: NOW_MS + 5_000,
      databaseOptions,
    });
    expect(
      (await consume({ databaseOptions, revision, nowMs: NOW_MS + 1_000 + 400 * THIRTY_DAYS_MS }))
        .outcome,
    ).toBe("consumed");
  });
});

describe("standing grant operator surfaces", () => {
  it.each([
    {
      operation: "consume",
      run: async (databaseOptions: OpenClawStateDatabaseOptions, revision: string) =>
        expect((await consume({ databaseOptions, revision })).outcome).toBe("no-grant"),
    },
    {
      operation: "list",
      run: async (databaseOptions: OpenClawStateDatabaseOptions) =>
        expect(await listCronStandingGrants({ databaseOptions })).toEqual([]),
    },
    {
      operation: "revoke",
      run: async (databaseOptions: OpenClawStateDatabaseOptions) =>
        expect(
          (await revokeCronStandingGrant({ grantId: "missing", revokedBy: "x", databaseOptions }))
            .outcome,
        ).toBe("not-found"),
    },
  ])("keeps the absent grant table lazy during $operation", async ({ run }) => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    await run(databaseOptions, revision);
    expect(readGrantRows(databaseOptions)).toBeNull();
  });

  it("keeps grant lookup, consumption, listing and revocation off the calling thread", async () => {
    const { databaseOptions, revision } = await seedMintedGrant();
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    try {
      sql.calibrate();
      expect(
        await validateCronStandingGrant({
          ...grantInput({ databaseOptions, revision }),
          databaseOptions,
        }),
      ).toMatchObject({ outcome: "consumed", grant: { useCount: 0 } });
      expect(await consume({ databaseOptions, revision })).toMatchObject({
        outcome: "consumed",
        grant: { useCount: 1 },
      });
      const grants = await listCronStandingGrants({ databaseOptions });
      const grant = grants[0]!;
      expect(grants).toHaveLength(1);
      expect(grant.cronJobId).toBe("job-1");
      expect(grant.cronJobName).toBe("Standing grant job");
      expect(grant.expiresAtMs).toBeNull();
      expect(grant.revokedAtMs).toBeNull();
      expect(grant.useCount).toBe(1);
      const operation = parseCronExecOperationBinding(grant.operationBinding);
      expect(operation?.command).toBe("echo standing");
      expect(
        await revokeCronStandingGrant({
          grantId: grant!.grantId,
          revokedBy: "reviewer",
          databaseOptions,
        }),
      ).toMatchObject({ outcome: "revoked" });
      expect(await listCronStandingGrants({ databaseOptions })).toMatchObject([
        { grantId: grant!.grantId, revokedBy: "reviewer" },
      ]);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it("rolls back revocation when authority is revoked at worker commit", async () => {
    const { databaseOptions } = await seedMintedGrant();
    const [before] = await listCronStandingGrants({ databaseOptions });
    let current = true;
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            current = false;
          }
          return admit(request, grant);
        }, attachment),
    );
    const pending = revokeCronStandingGrant({
      grantId: before!.grantId,
      revokedBy: "reviewer",
      databaseOptions,
      assertCurrent() {
        if (!current) {
          throw new Error("synthetic grant authority revoked");
        }
      },
    });
    await expect(pending).rejects.toThrow("synthetic grant authority revoked");
    vi.restoreAllMocks();
    expect(await listCronStandingGrants({ databaseOptions })).toEqual([before]);
  });

  it("revokes once, reports already-revoked after, and fails closed at consume", async () => {
    const { databaseOptions, revision } = await seedMintedGrant();
    const grantId = (await listCronStandingGrants({ databaseOptions }))[0]!.grantId;
    const revoked = await revokeCronStandingGrant({
      grantId,
      revokedBy: "operator-cli",
      nowMs: NOW_MS + 2_000,
      databaseOptions,
    });
    expect(revoked.outcome).toBe("revoked");
    expect((await consume({ databaseOptions, revision, nowMs: NOW_MS + 3_000 })).outcome).toBe(
      "revoked",
    );
    expect(
      (await revokeCronStandingGrant({ grantId, revokedBy: "someone-else", databaseOptions }))
        .outcome,
    ).toBe("already-revoked");
    const listed = (await listCronStandingGrants({ databaseOptions }))[0]!;
    expect(listed.revokedAtMs).toBe(NOW_MS + 2_000);
    expect(listed.revokedBy).toBe("operator-cli");
  });

  it("rebuilds the unshipped mandatory-expiry table shape on first use", async () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    const database = openOpenClawStateDatabase(databaseOptions);
    database.db.exec(
      GRANT_TABLE_SQL.replace(
        "expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= created_at_ms)",
        "expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms)",
      ),
    );
    // This deliberately noncanonical boot fixture cannot enter an admitted worker.
    insertOperatorApprovalNative({ approval: approval("approval-1"), databaseOptions });
    expect(
      resolveOperatorApprovalNative({
        id: "approval-1",
        decision: "allow-always",
        resolver: { kind: "device", id: "reviewer-1" },
        nowMs: NOW_MS + 1_000,
        databaseOptions,
        standingGrant: {
          kind: "cron",
          agentId: "main",
          cronJobId: "job-1",
          jobConfigRevision: revision,
          operationBinding: OPERATION_BINDING,
          expiresAtMs: null,
        },
      }),
    ).toMatchObject({ outcome: "resolved" });
    const grants = await listCronStandingGrants({ databaseOptions });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.expiresAtMs).toBeNull();
  });
});
