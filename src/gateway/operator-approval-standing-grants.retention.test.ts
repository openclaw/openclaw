// Thirty-day approval retention must not delete the parent of a live standing grant.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import {
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
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { buildCronExecOperationBinding } from "./operator-approval-standing-grants.js";
import {
  consumeCronStandingGrant,
  forceDenyOperatorApproval,
  insertOperatorApproval,
  recoverOperatorApprovalsOnStartup,
  resolveOperatorApproval,
  revokeCronStandingGrant,
} from "./operator-approval-store.js";

const NOW_MS = 1_756_000_000_000;
const PAST_RETENTION_MS = NOW_MS + 30 * 24 * 60 * 60_000 + 1;
const STORE_KEY = "/tmp/openclaw-standing-grant-retention-store";
const OPERATION_BINDING = buildCronExecOperationBinding({
  command: "echo standing",
  cwd: "/work",
  env: undefined,
});

const tempDirs: string[] = [];

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type GrantDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "operator_approvals" | "operator_approval_standing_grants"
>;

function databaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-grant-retention-")),
  );
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];

function approval(
  id: string,
  createdAtMs = NOW_MS,
  expiresAtMs = NOW_MS + 60_000,
): NewOperatorApproval {
  return {
    id,
    kind: "exec" as const,
    presentation: {
      kind: "exec" as const,
      commandText: "echo standing",
      commandPreview: "echo standing",
      warningText: null,
      host: "gateway" as const,
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: { deviceId: "device-1", clientId: "client-1", deviceTokenAuth: true },
    reviewerDeviceIds: [],
    source: {
      agentId: "main",
      sessionKey: `agent:main:cron:${id}`,
      sessionId: `session-${id}`,
      runId: `run-${id}`,
      toolCallId: null,
      toolName: "exec",
    },
    audienceSessionKeys: [],
    runtimeEpoch: "epoch-1",
    createdAtMs,
    expiresAtMs,
  };
}

async function mintAgedGrant(expiresAtMs: number | null) {
  const options = databaseOptions();
  const database = openOpenClawStateDatabase(options);
  const job = {
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
  } as CronStoredJob;
  upsertCronJobRow(database.db, STORE_KEY, job, 0);
  const loadedJob = loadedCronStoreFromRows(loadCronRows(database.db, STORE_KEY)).store.jobs[0];
  if (!loadedJob) {
    throw new Error("seeded cron job did not load");
  }
  const revision = resolveCronJobConfigRevision(loadedJob);
  const prepared = prepareCronRunReceiptClaim({
    storePath: STORE_KEY,
    job: loadedJob,
    agentId: "main",
    startedAtMs: NOW_MS,
  });
  const handle = runOpenClawStateWriteTransaction(
    ({ db }) =>
      claimCronRunReceiptInDatabaseForTest({
        database: db,
        prepared,
      }),
    options,
  );
  await insertOperatorApproval({ approval: approval("approval-1"), databaseOptions: options });
  const resolved = await resolveOperatorApproval({
    id: "approval-1",
    decision: "allow-always",
    resolver: { kind: "device", id: "reviewer-1" },
    nowMs: NOW_MS,
    databaseOptions: options,
    standingGrant: {
      kind: "cron",
      agentId: "main",
      cronJobId: "job-1",
      jobConfigRevision: revision,
      operationBinding: OPERATION_BINDING,
      expiresAtMs,
    },
  });
  expect(resolved.outcome).toBe("resolved");
  return { options, revision, handle };
}

function rowCount(
  options: OpenClawStateDatabaseOptions,
  table: "operator_approvals" | "operator_approval_standing_grants",
) {
  const database = openOpenClawStateDatabase(options);
  const stateDb = getNodeSqliteKysely<GrantDatabase>(database.db);
  return executeSqliteQuerySync(database.db, stateDb.selectFrom(table).selectAll()).rows.length;
}

function consume(params: {
  options: OpenClawStateDatabaseOptions;
  revision: string;
  handle: CronRunReceiptHandle;
}) {
  return consumeCronStandingGrant(
    captureOpenClawStateWorkerContext(params.options),
    {
      agentId: "main",
      cronJobId: "job-1",
      jobConfigRevision: params.revision,
      operationBinding: OPERATION_BINDING,
      nowMs: PAST_RETENTION_MS,
      handle: params.handle,
      recordUse: true,
    },
    () => {},
  );
}

describe("terminal approval retention", () => {
  it("keeps an approval that anchors an unexpired standing grant", async () => {
    const minted = await mintAgedGrant(PAST_RETENTION_MS + 1_000);
    expect(
      (
        await recoverOperatorApprovalsOnStartup({
          runtimeEpoch: "epoch-1",
          nowMs: PAST_RETENTION_MS,
          databaseOptions: minted.options,
        })
      ).pruned,
    ).toBe(0);
    expect(rowCount(minted.options, "operator_approvals")).toBe(1);
    expect(rowCount(minted.options, "operator_approval_standing_grants")).toBe(1);
    expect((await consume(minted)).outcome).toBe("consumed");
  });

  it("keeps an approval that anchors a grant with no expiry", async () => {
    const minted = await mintAgedGrant(null);
    expect(
      (
        await recoverOperatorApprovalsOnStartup({
          runtimeEpoch: "epoch-1",
          nowMs: PAST_RETENTION_MS,
          databaseOptions: minted.options,
        })
      ).pruned,
    ).toBe(0);
    expect((await consume(minted)).outcome).toBe("consumed");
  });

  it("prunes an approval once its standing grant expires", async () => {
    const minted = await mintAgedGrant(PAST_RETENTION_MS);
    expect(
      (
        await recoverOperatorApprovalsOnStartup({
          runtimeEpoch: "epoch-1",
          nowMs: PAST_RETENTION_MS,
          databaseOptions: minted.options,
        })
      ).pruned,
    ).toBe(1);
    expect(rowCount(minted.options, "operator_approvals")).toBe(0);
    expect(rowCount(minted.options, "operator_approval_standing_grants")).toBe(0);
    expect((await consume(minted)).outcome).toBe("no-grant");
  });

  it("prunes an approval after its standing grant is revoked", async () => {
    const minted = await mintAgedGrant(null);
    const database = openOpenClawStateDatabase(minted.options);
    const stateDb = getNodeSqliteKysely<GrantDatabase>(database.db);
    const grantId = executeSqliteQuerySync(
      database.db,
      stateDb.selectFrom("operator_approval_standing_grants").select(["grant_id"]),
    ).rows[0]?.grant_id;
    if (typeof grantId !== "string") {
      throw new Error("expected minted grant");
    }
    expect(
      (
        await revokeCronStandingGrant({
          grantId,
          revokedBy: "operator",
          nowMs: NOW_MS + 1_000,
          databaseOptions: minted.options,
        })
      ).outcome,
    ).toBe("revoked");
    expect(
      (
        await recoverOperatorApprovalsOnStartup({
          runtimeEpoch: "epoch-1",
          nowMs: PAST_RETENTION_MS,
          databaseOptions: minted.options,
        })
      ).pruned,
    ).toBe(1);
    expect(rowCount(minted.options, "operator_approval_standing_grants")).toBe(0);
  });

  it("keeps the anchored approval when a later insert runs retention", async () => {
    const minted = await mintAgedGrant(null);
    await insertOperatorApproval({
      approval: approval("unanchored"),
      databaseOptions: minted.options,
    });
    await forceDenyOperatorApproval({
      id: "unanchored",
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: NOW_MS,
      databaseOptions: minted.options,
    });
    await insertOperatorApproval({
      approval: approval("later", PAST_RETENTION_MS, PAST_RETENTION_MS + 60_000),
      databaseOptions: minted.options,
    });
    const database = openOpenClawStateDatabase(minted.options);
    const stateDb = getNodeSqliteKysely<GrantDatabase>(database.db);
    const ids = executeSqliteQuerySync(
      database.db,
      stateDb.selectFrom("operator_approvals").select(["approval_id"]),
    ).rows.map((row) => row.approval_id);
    expect(ids.toSorted()).toEqual(["approval-1", "later"]);
    expect(rowCount(minted.options, "operator_approval_standing_grants")).toBe(1);
  });
});
