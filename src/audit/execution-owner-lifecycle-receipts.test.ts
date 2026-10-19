import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIdentityContextV1 } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableHasColumn, tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { presentExecutionDecisionReceiptsInDatabase } from "./execution-decision-receipts.js";
import { deleteExecutionOwnerLifecycleMetadata } from "./execution-owner-lifecycle-binding-store.js";
import {
  pageOwnerLifecycleReceiptsInDatabase,
  summarizeOwnerLifecycleReceiptsInDatabase,
} from "./execution-owner-lifecycle-receipts.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function oldSchemaSql(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS execution_owner_lifecycle_bindings (",
  );
  const endMarker = ") STRICT;";
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start);
  if (start < 0 || end < start) {
    throw new Error("owner lifecycle binding schema marker is missing");
  }
  return `${OPENCLAW_STATE_SCHEMA_SQL.slice(0, start)}${OPENCLAW_STATE_SCHEMA_SQL.slice(end + endMarker.length)}`;
}

function addCron(
  db: EngineConnection,
  id: string,
  startedAt = 60,
  status = "running",
  finishedAt: number | null = null,
  runId = "run-1",
) {
  db.prepare(`INSERT INTO cron_run_receipts (
    receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
    status, owner_pid, started_at_ms, finished_at_ms, cursor_id
  ) VALUES (?, 'default', ?, 'revision-1', 'main', ?, ?, 1, ?, ?,
    (SELECT COALESCE(MAX(cursor_id), 0) + 1 FROM cron_run_receipts))`).run(
    id,
    id.replace("cron-", "job-"),
    runId,
    status,
    startedAt,
    finishedAt,
  );
}

function bindCron(db: EngineConnection, id: string, executionId = "execution-1") {
  db.prepare(`INSERT INTO execution_owner_lifecycle_bindings (
    owner_kind, owner_id, context_id, execution_id
  ) VALUES ('cron', ?, 'context-1', ?)`).run(id, executionId);
}

function present(db: EngineConnection, decisionCursor?: string, context = executionContext()) {
  return presentExecutionDecisionReceiptsInDatabase(db, {
    schema: retainedLifecycleSchema,
    context,
    decisionCursor,
    decisionLimit: 1,
    now: Date.now(),
  });
}

function page(db: EngineConnection, schema = retainedLifecycleSchema) {
  return pageOwnerLifecycleReceiptsInDatabase(db, {
    schema,
    context: executionContext(),
    limit: 1,
  });
}

function addSuccessor(db: EngineConnection) {
  addCron(db, "cron-2", 63);
  bindCron(db, "cron-2");
}

function deleteAnchor(db: EngineConnection) {
  db.prepare(
    "DELETE FROM execution_owner_lifecycle_bindings WHERE owner_kind = 'cron' AND owner_id = 'cron-1'",
  ).run();
  db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = 'cron-1'").run();
}

function createCronDatabase(retainedBinding = true) {
  const pathname = path.join(tempDirs.make("owner-lifecycle-"), "openclaw.sqlite");
  const oldReader = new DatabaseSync(pathname);
  oldReader.exec(retainedBinding ? OPENCLAW_STATE_SCHEMA_SQL : oldSchemaSql());
  oldReader.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
  oldReader
    .prepare(
      `INSERT INTO schema_meta (
         meta_key, role, schema_version, created_at, updated_at
       ) VALUES ('primary', 'global', ?, 1, 1)`,
    )
    .run(OPENCLAW_STATE_SCHEMA_VERSION);
  addCron(oldReader, "cron-1");
  if (retainedBinding) {
    // Released rows remain inspectable alongside newly bound scheduled runs.
    bindCron(oldReader, "cron-1");
  }
  oldReader.close();
  return { path: pathname };
}

function openCronDatabase() {
  return openOpenClawStateDatabase(createCronDatabase()).db;
}

function executionContext(contextId = "context-1"): ExecutionIdentityContextV1 {
  return {
    schemaVersion: 1,
    contextId,
    executionId: "execution-1",
    runId: "run-1",
    createdAt: 50,
    trustDomain: { kind: "gateway-cell", domainRef: "host-1", state: "present" },
    invoker: { state: "unknown" },
    ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
    agentPrincipal: { kind: "agent", domainRef: "host-1", principalRef: "main" },
    agentDefinition: { definitionRef: "main", state: "present" },
    runtimeInstance: { runtimeRef: "runtime-1", kind: "embedded", state: "present" },
    applicableGrants: [],
    assurance: [],
    coverageState: "unattributed",
    missingEvidence: [],
  };
}

const retainedLifecycleSchema = { cronRunReceipts: true, executionOwnerLifecycleBindings: true };

describe("owner-native execution lifecycle receipts", () => {
  it("uses admitted absence without catalog probes or allocating opt-in storage", () => {
    const db = new DatabaseSync(":memory:");
    const prepare = vi.spyOn(db, "prepare");
    const schema = { cronRunReceipts: false, executionOwnerLifecycleBindings: false };
    try {
      expect(page(db, schema)).toEqual({ entries: [] });
      expect(
        summarizeOwnerLifecycleReceiptsInDatabase(db, { schema, context: executionContext() }),
      ).toEqual({ count: 0, missingEvidence: [] });
      deleteExecutionOwnerLifecycleMetadata({
        db,
        ownerKind: "cron",
        ownerIds: ["cron-1"],
        executionOwnerLifecycleBindings: false,
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(() =>
        pageOwnerLifecycleReceiptsInDatabase(db, {
          schema,
          context: executionContext(),
          after: { occurredAt: 60, rowId: 1 },
          limit: 1,
        }),
      ).toThrow("owner lifecycle cursor is no longer retained");
      expect(prepare).not.toHaveBeenCalled();
      // An admitted table disappearing is not absence; SQLite failure must reach the owner.
      expect(() => page(db)).toThrow(/no such table/i);
    } finally {
      prepare.mockRestore();
      db.close();
    }
  });

  it("reads an unbound released cron receipt without allocating opt-in storage", () => {
    const options = createCronDatabase(false);
    const current = openOpenClawStateDatabase(options).db;
    expect(tableExists(current, "execution_owner_lifecycle_bindings")).toBe(false);
    expect(tableHasColumn(current, "cron_run_receipts", "context_id")).toBe(false);
    expect(tableHasColumn(current, "cron_run_receipts", "execution_id")).toBe(false);
    const unboundSchema = { cronRunReceipts: true, executionOwnerLifecycleBindings: false };
    expect(page(current, unboundSchema).entries).toEqual([]);
    expect(tableExists(current, "execution_owner_lifecycle_bindings")).toBe(false);
  });

  it("preserves released cron binding metadata and its terminal receipt on reopen", async () => {
    const options = createCronDatabase();
    const current = openOpenClawStateDatabase(options).db;
    current.prepare("UPDATE cron_run_receipts SET status = 'ok', finished_at_ms = 70").run();

    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options).db;
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      reopened
        .prepare(
          "SELECT owner_kind, owner_id, context_id, execution_id FROM execution_owner_lifecycle_bindings",
        )
        .all(),
    ).toEqual([
      {
        owner_kind: "cron",
        owner_id: "cron-1",
        context_id: "context-1",
        execution_id: "execution-1",
      },
    ]);
    expect(page(reopened).entries[0]?.receipt.decision).toEqual({
      outcome: "not-applicable",
      reasonCode: "cron_run_ok",
    });
    expect(
      reopened.prepare("SELECT COUNT(*) AS count FROM execution_decision_facts").get(),
    ).toEqual({ count: 0 });
  });

  it("uses stable cron cursors and rejects a mismatched exact execution", async () => {
    const db = openCronDatabase();
    db.prepare("UPDATE cron_run_receipts SET status = 'ok', finished_at_ms = 70").run();
    addCron(db, "cron-2", 60, "skipped", 70);
    db.exec("UPDATE cron_run_receipts SET rowid = 100 WHERE receipt_id = 'cron-1'");
    bindCron(db, "cron-2", "execution-other");
    const first = present(db);
    expect(first.nextDecisionCursor).toBe("a:0:0");
    const cronPage = present(db, first.nextDecisionCursor);
    expect(cronPage.decisions[0]?.source.owner).toBe("cron_run_receipts");
    expect(cronPage.decisionDisplays[0]).toMatchObject({
      decision: { outcome: "not-applicable", reasonCode: "cron_run_ok" },
      provenance: { state: "verified", producer: "cron-lifecycle" },
    });
    expect(cronPage.nextDecisionCursor).toBe("c:60:1");
    const mismatchPage = present(db, cronPage.nextDecisionCursor);
    expect(mismatchPage.decisions[0]).toMatchObject({
      decision: { outcome: "unknown", reasonCode: "cron_run_execution_link_mismatch" },
      missingEvidence: ["decision.execution_link"],
    });
    expect(mismatchPage.nextDecisionCursor).toBeUndefined();
    expect(JSON.stringify(cronPage.decisionDisplays)).not.toMatch(
      /cron-1|private|cron_run_receipts/,
    );

    expect(present(db, "1").decisions[0]?.source.owner).toBe("cron_run_receipts");
  });

  it.each(["deleted", "other-context"] as const)("rejects the %s owner cursor", (invalid) => {
    const db = openCronDatabase();
    addSuccessor(db);
    const firstPage = present(db, "c:0:0");
    expect(firstPage.nextDecisionCursor).toMatch(/^c:[1-9]\d*:[1-9]\d*$/);

    if (invalid === "deleted") {
      deleteAnchor(db);
    }
    const context = invalid === "other-context" ? executionContext("context-other") : undefined;
    expect(() => present(db, firstPage.nextDecisionCursor, context)).toThrow(
      "decision cursor is no longer retained; restart inspection without --cursor",
    );
  });

  it("rejects a reused owner cursor whose binding belongs to another execution", async () => {
    const db = openCronDatabase();
    db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = 'cron-1'").run();
    addCron(db, "cron-2", 63);
    addCron(db, "cron-1");
    bindCron(db, "cron-2");
    const firstPage = present(db, "c:0:0");
    expect(firstPage.nextDecisionCursor).toMatch(/^c:60:[1-9]\d*$/);

    deleteAnchor(db);
    addCron(db, "cron-replacement", 60, "running", null, "run-2");
    bindCron(db, "cron-replacement", "execution-other");

    expect(() => present(db, firstPage.nextDecisionCursor)).toThrow(
      "decision cursor is no longer retained; restart inspection without --cursor",
    );
  });

  it("projects every cron terminal state without rederiving lifecycle precedence", async () => {
    const db = openCronDatabase();

    for (const status of ["ok", "error", "skipped", "interrupted", "superseded"]) {
      db.prepare(
        "UPDATE cron_run_receipts SET status = ?, finished_at_ms = 70 WHERE receipt_id = ?",
      ).run(status, "cron-1");
      expect(page(db).entries[0]?.receipt.decision).toEqual({
        outcome: "not-applicable",
        reasonCode: `cron_run_${status}`,
      });
    }
  });
});
