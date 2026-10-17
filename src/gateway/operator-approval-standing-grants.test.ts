// Cron standing grants: mint-at-resolution, fail-closed consumption, restart survival.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Compilable } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import {
  deleteCronJobRowInDatabase,
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import {
  claimCronRunReceiptInDatabaseForTest,
  prepareCronRunReceiptClaim,
} from "../cron/store/run-receipt-store.test-support.js";
import type { CronRunReceiptHandle } from "../cron/store/run-receipt.types.js";
import type { CronStoredJob } from "../cron/types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.test-support.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
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
  parseCronExecOperationBinding,
} from "./operator-approval-standing-grants.js";
import { mintCronStandingGrantLocked } from "./operator-approval-standing-grants.worker.js";
import {
  recoverOperatorApprovalsOnStartup,
  listCronStandingGrants,
  revokeCronStandingGrant,
  insertOperatorApproval,
  resolveOperatorApproval,
  validateCronStandingGrant,
  consumeCronStandingGrant,
} from "./operator-approval-store.js";
import { insertOperatorApprovalInDatabase as insertOperatorApprovalNative } from "./operator-approval-store.kernel.worker.js";
import { resolveOperatorApprovalInDatabase as resolveOperatorApprovalNative } from "./operator-approval-store.transitions.worker.js";

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
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function approval(id: string): NewOperatorApproval {
  return {
    id,
    kind: "exec",
    presentation: {
      kind: "exec",
      commandText: "echo standing",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    runtimeEpoch: "epoch-1",
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 60_000,
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
          }),
        databaseOptions,
      ),
    );
  }
  return resolveCronJobConfigRevision(loadedJob);
}

const OPERATION_BINDING = buildCronExecOperationBinding({
  command: "echo standing",
  cwd: "/work",
  env: undefined,
});

const reviewer = { kind: "device", id: "reviewer-1" } as const;
function grantTerms(
  jobConfigRevision: string,
  operationBinding = OPERATION_BINDING,
  expiresAtMs: number | null = null,
) {
  return {
    kind: "cron" as const,
    agentId: "main",
    cronJobId: "job-1",
    jobConfigRevision,
    operationBinding,
    expiresAtMs,
  };
}
function resolution(
  databaseOptions: OpenClawStateDatabaseOptions,
  revision: string,
  overrides: Partial<Parameters<typeof resolveOperatorApproval>[0]> = {},
) {
  return {
    id: "approval-1",
    decision: "allow-always" as const,
    resolver: reviewer,
    nowMs: NOW_MS + 1_000,
    databaseOptions,
    standingGrant: grantTerms(revision),
    ...overrides,
  };
}

async function mintGrant(
  databaseOptions: OpenClawStateDatabaseOptions,
  revision: string,
  expiresAtMs: number | null = null,
) {
  await insertOperatorApproval({ approval: approval("approval-1"), databaseOptions });
  const resolved = await resolveOperatorApproval(
    resolution(databaseOptions, revision, {
      standingGrant: grantTerms(revision, OPERATION_BINDING, expiresAtMs),
    }),
  );
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
  await mintGrant(databaseOptions, revision, opts.expiresAtMs);
  const database = openOpenClawStateDatabase(databaseOptions);
  const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(database.db);
  return {
    databaseOptions,
    revision,
    database,
    stateDb,
    run: <Row>(query: Compilable<Row>) => executeSqliteQuerySync(database.db, query),
    seed: (changes: Partial<CronStoredJob> = {}) => seedCronJob(databaseOptions, cronJob(changes)),
    consume: (changes: Partial<Parameters<typeof grantInput>[0]> = {}) =>
      consume({ databaseOptions, revision, ...changes }),
    list: () => listCronStandingGrants({ databaseOptions }),
    rows: () => readGrantRows(databaseOptions),
  };
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
  return consumeCronStandingGrant(context, input, () => {});
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
          ...grantTerms(revision),
          approvalId: "approval-1",
          nowMs: NOW_MS + 1_000,
        });
        throw new Error("force outer rollback");
      }, databaseOptions),
    ).toThrow("force outer rollback");
    expect(
      runSqliteReadOperationSync(database.db, () =>
        tableExists(database.db, "operator_approval_standing_grant_generations"),
      ),
    ).toBe(false);

    const resolved = await resolveOperatorApproval(
      resolution(databaseOptions, revision, { nowMs: NOW_MS + 2_000 }),
    );
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
    await mintGrant(databaseOptions, revision);
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
    const resolved = await resolveOperatorApproval(
      resolution(databaseOptions, "sha256:rev", { decision: "allow-once" }),
    );
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
      const approve = async (
        id: string,
        changes: Partial<Parameters<typeof manager.create>[0]> = {},
        grantExpiresAtMs?: number,
      ) => {
        await manager.register(manager.create({ ...request, ...changes }, 60_000, id), 60_000);
        const result = await manager.resolveDetailed(
          id,
          "allow-always",
          reviewer,
          null,
          "operator",
          grantExpiresAtMs === undefined ? undefined : { grantExpiresAtMs },
        );
        expect(result.outcome).toBe("resolved");
      };
      await approve("approval-mgr");
      const rows = readGrantRows(databaseOptions);
      expect(rows).toHaveLength(1);
      expect(rows![0]).toMatchObject({
        minted_by_approval_id: "approval-mgr",
        expires_at_ms: configuredExpiresAtMs,
      });

      // A non-cron request never mints: the resolver returns null.
      await approve("plain", { cronExecutionSource: null });
      expect(readGrantRows(databaseOptions)).toHaveLength(1);
      if (configured) {
        const overrideExpiresAtMs = Date.now() + 99 * 24 * 60 * 60_000;
        const overrideBinding = buildCronExecOperationBinding({
          command: "echo standing-override",
          cwd: "/work",
          env: undefined,
        });
        await approve(
          "approval-override",
          { cronOperationBinding: overrideBinding },
          overrideExpiresAtMs,
        );
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
    const f = await seedMintedGrant();
    const [first, second] = await Promise.all([f.consume(), f.consume({ nowMs: NOW_MS + 20_000 })]);
    expect(first).toMatchObject({
      outcome: "consumed",
      grant: { useCount: 1, lastUsedAtMs: NOW_MS + 10_000, mintedByApprovalId: "approval-1" },
    });
    expect(second).toMatchObject({ outcome: "consumed", grant: { useCount: 2 } });
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
    const f = await seedMintedGrant({
      expiresAtMs: reason === "stamped expiry passed" ? expiresAtMs : null,
    });
    const { database, stateDb, revision } = f;
    const input: Partial<Parameters<typeof consume>[0]> = {};
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
      f.run(
        stateDb
          .updateTable("operator_approval_standing_grant_generations")
          .set({ job_definition_generation: 2 }),
      );
    } else if (reason === "stale updated-at projection") {
      f.run(stateDb.updateTable("cron_jobs").set({ grant_definition_updated_at: NOW_MS - 2_000 }));
    } else if (reason === "reversed parent") {
      f.run(stateDb.updateTable("operator_approvals").set({ status: "denied", decision: "deny" }));
    } else if (reason === "stamped expiry passed") {
      input.nowMs = expiresAtMs;
    } else if (reason === "deleted job") {
      f.run(stateDb.deleteFrom("cron_jobs"));
    } else if (reason === "recreated job") {
      deleteCronJobRowInDatabase(database.db, CRON_STORE_KEY, "job-1");
      input.revision = f.seed();
      expect(input.revision).toBe(revision);
    } else if (reason === "missing definition generation") {
      f.run(stateDb.deleteFrom("operator_approval_standing_grant_generations"));
    } else if (reason === "deleted minting approval") {
      f.run(stateDb.deleteFrom("operator_approvals").where("approval_id", "=", "approval-1"));
    } else {
      const changedRevision = f.seed({ payload: { kind: "agentTurn", message: "changed" } });
      if (reason === "changed run revision") {
        input.revision = changedRevision;
      }
    }
    // A pruned parent may cascade-delete the derivative grant; neither outcome authorizes it.
    expect(outcomes).toContain((await f.consume(input)).outcome);
    expect(f.rows()?.every((row) => row.use_count === 0)).toBe(true);
  });

  it("requires the exact running receipt and selected grant without recording refused uses", async () => {
    const f = await seedMintedGrant();
    const input = grantInput(f);
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
      const result = await consumeInWorker(f.databaseOptions, {
        ...input,
        handle: { ...input.handle, ...change },
        recordUse: true,
      });
      expect(result.outcome).toBe("receipt-not-current");
    }
    const used = await f.consume();
    if (used.outcome !== "consumed") {
      throw new Error("expected consumed");
    }
    const retry = async (expectedGrant = used.grant) =>
      consumeInWorker(f.databaseOptions, { ...input, recordUse: false, expectedGrant });
    expect(await retry()).toMatchObject({ outcome: "consumed", grant: { useCount: 1 } });
    expect(await retry({ ...used.grant, grantId: "replacement-grant" })).toEqual({
      outcome: "no-grant",
    });
    expect(f.rows()?.[0]?.use_count).toBe(1);
  });

  it("does not reuse a grant generation after an older writer deletes the job", async () => {
    const f = await seedMintedGrant();
    const originalRow = f.run(
      f.stateDb.selectFrom("cron_jobs").selectAll().where("job_id", "=", "job-1"),
    ).rows[0]!;
    const pathname = f.database.path;
    await closeOpenClawStateDatabaseAsync();
    const previousWriter = new DatabaseSync(pathname);
    try {
      previousWriter.prepare("DELETE FROM cron_jobs WHERE job_id = ?").run("job-1");
      const columns = [
        "store_key",
        "job_id",
        "declaration_key",
        "owner_agent_id",
        "name",
        "description",
        "enabled",
        "agent_id",
        "payload_kind",
        "job_json",
        "state_json",
        "runtime_updated_at_ms",
        "schedule_identity",
        "sort_order",
        "updated_at",
      ] as const;
      previousWriter
        .prepare(
          `INSERT INTO cron_jobs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...columns.map((column) => originalRow[column]));
    } finally {
      previousWriter.close();
    }
    const recreatedRevision = f.seed({ updatedAtMs: NOW_MS + 2_000 });
    expect(recreatedRevision).toBe(f.revision);

    expect((await f.consume({ revision: recreatedRevision })).outcome).toBe("job-revision-changed");
    const reopened = openOpenClawStateDatabase(f.databaseOptions);
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
      const f = await seedMintedGrant();
      const originalRow = f.run(
        f.stateDb.selectFrom("cron_jobs").selectAll().where("job_id", "=", "job-1"),
      ).rows[0]!;
      f.seed({
        payload: { kind: "agentTurn", message: "run something else" },
        ...(writer === "older edit and restore" ? { updatedAtMs: NOW_MS + 2_000 } : {}),
      });
      if (writer === "older edit and restore") {
        f.seed({ updatedAtMs: NOW_MS + 3_000 });
      }
      if (writer !== "current") {
        f.run(
          f.stateDb
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
      const restoredRevision = writer === "older edit and restore" ? f.revision : f.seed();
      expect(restoredRevision).toBe(f.revision);
      expect((await f.consume({ revision: restoredRevision })).outcome).toBe(
        "job-revision-changed",
      );
    },
  );

  it("keeps a grant valid across disable and re-enable", async () => {
    const f = await seedMintedGrant();
    f.seed({ enabled: false, updatedAtMs: NOW_MS + 2_000 });
    expect((await f.consume()).outcome).toBe("job-revision-changed");
    const reenabledRevision = f.seed({ updatedAtMs: NOW_MS + 3_000 });
    expect(reenabledRevision).toBe(f.revision);

    expect((await f.consume({ revision: reenabledRevision })).outcome).toBe("consumed");
  });

  it("consumes an explicitly approved disabled definition for its matching force-run", async () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions, cronJob({ enabled: false }));
    await mintGrant(databaseOptions, revision);
    expect((await consume({ databaseOptions, revision })).outcome).toBe("consumed");
  });

  it("survives a gateway restart and orphan cleanup of pending approvals", async () => {
    const f = await seedMintedGrant();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    // New runtime epoch: startup cancels orphaned pending approvals only; the
    // resolved allow-always parent and its grant remain valid durable truth.
    await recoverOperatorApprovalsOnStartup({
      runtimeEpoch: "epoch-2",
      nowMs: NOW_MS + 5_000,
      databaseOptions: f.databaseOptions,
    });
    expect((await f.consume({ nowMs: NOW_MS + 1_000 + 400 * THIRTY_DAYS_MS })).outcome).toBe(
      "consumed",
    );
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
    const f = await seedMintedGrant();
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    try {
      sql.calibrate();
      expect(
        await validateCronStandingGrant({
          ...grantInput(f),
          databaseOptions: f.databaseOptions,
        }),
      ).toMatchObject({ outcome: "consumed", grant: { useCount: 0 } });
      expect(await f.consume()).toMatchObject({
        outcome: "consumed",
        grant: { useCount: 1 },
      });
      const grants = await f.list();
      const grant = grants[0]!;
      expect(grants).toHaveLength(1);
      expect(grant).toMatchObject({
        cronJobId: "job-1",
        cronJobName: "Standing grant job",
        expiresAtMs: null,
        revokedAtMs: null,
        useCount: 1,
      });
      const operation = parseCronExecOperationBinding(grant.operationBinding);
      expect(operation?.command).toBe("echo standing");
      expect(
        await revokeCronStandingGrant({
          grantId: grant!.grantId,
          revokedBy: "reviewer",
          databaseOptions: f.databaseOptions,
        }),
      ).toMatchObject({ outcome: "revoked" });
      expect(await f.list()).toMatchObject([{ grantId: grant!.grantId, revokedBy: "reviewer" }]);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it("rolls back revocation when authority is revoked at worker commit", async () => {
    const f = await seedMintedGrant();
    const [before] = await f.list();
    let current = true;
    probe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "commit") {
        current = false;
      }
      return admit(request, grant);
    });
    const pending = revokeCronStandingGrant({
      grantId: before!.grantId,
      revokedBy: "reviewer",
      databaseOptions: f.databaseOptions,
      assertCurrent() {
        if (!current) {
          throw new Error("synthetic grant authority revoked");
        }
      },
    });
    await expect(pending).rejects.toThrow("synthetic grant authority revoked");
    vi.restoreAllMocks();
    expect(await f.list()).toEqual([before]);
  });

  it("revokes once, reports already-revoked after, and fails closed at consume", async () => {
    const f = await seedMintedGrant();
    const grantId = (await f.list())[0]!.grantId;
    const revoke = (revokedBy: string, nowMs?: number) =>
      revokeCronStandingGrant({ grantId, revokedBy, nowMs, databaseOptions: f.databaseOptions });
    const revoked = await revoke("operator-cli", NOW_MS + 2_000);
    expect(revoked.outcome).toBe("revoked");
    expect((await f.consume({ nowMs: NOW_MS + 3_000 })).outcome).toBe("revoked");
    expect((await revoke("someone-else")).outcome).toBe("already-revoked");
    const listed = (await f.list())[0]!;
    expect(listed).toMatchObject({ revokedAtMs: NOW_MS + 2_000, revokedBy: "operator-cli" });
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
    expect(resolveOperatorApprovalNative(resolution(databaseOptions, revision))).toMatchObject({
      outcome: "resolved",
    });
    const grants = await listCronStandingGrants({ databaseOptions });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.expiresAtMs).toBeNull();
  });
});
