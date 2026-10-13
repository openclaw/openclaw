import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIdentityContextV1 } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
  oldReader
    .prepare(
      `INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
         status, owner_pid, started_at_ms, finished_at_ms, cursor_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(cursor_id), 0) + 1 FROM cron_run_receipts))`,
    )
    .run("cron-1", "default", "job-1", "revision-1", "main", "run-1", "running", 1, 60, null);
  if (retainedBinding) {
    // Released rows remain inspectable alongside newly bound scheduled runs.
    oldReader
      .prepare(
        `INSERT INTO execution_owner_lifecycle_bindings (
           owner_kind, owner_id, context_id, execution_id
         ) VALUES ('cron', 'cron-1', 'context-1', 'execution-1')`,
      )
      .run();
  }
  oldReader.close();
  return { path: pathname };
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
      expect(
        pageOwnerLifecycleReceiptsInDatabase(db, { schema, context: executionContext(), limit: 1 }),
      ).toEqual({ entries: [] });
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
      expect(() =>
        pageOwnerLifecycleReceiptsInDatabase(db, {
          schema: retainedLifecycleSchema,
          context: executionContext(),
          limit: 1,
        }),
      ).toThrow(/no such table/i);
    } finally {
      prepare.mockRestore();
      db.close();
    }
  });

  it("reads an unbound released cron receipt without allocating opt-in storage", async () => {
    const options = createCronDatabase(false);
    const current = openOpenClawStateDatabase(options).db;
    expect(tableExists(current, "execution_owner_lifecycle_bindings")).toBe(false);
    expect(tableHasColumn(current, "cron_run_receipts", "context_id")).toBe(false);
    expect(tableHasColumn(current, "cron_run_receipts", "execution_id")).toBe(false);
    const unboundSchema = { cronRunReceipts: true, executionOwnerLifecycleBindings: false };
    expect(
      pageOwnerLifecycleReceiptsInDatabase(current, {
        schema: unboundSchema,
        context: executionContext(),
        limit: 1,
      }).entries,
    ).toEqual([]);
    expect(tableExists(current, "execution_owner_lifecycle_bindings")).toBe(false);

    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
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
    expect(
      pageOwnerLifecycleReceiptsInDatabase(reopened, {
        schema: retainedLifecycleSchema,
        context: executionContext(),
        limit: 1,
      }).entries[0]?.receipt.decision,
    ).toEqual({ outcome: "not-applicable", reasonCode: "cron_run_ok" });
    expect(
      reopened.prepare("SELECT COUNT(*) AS count FROM execution_decision_facts").get(),
    ).toEqual({ count: 0 });
  });

  it("uses stable cron cursors and rejects a mismatched exact execution", async () => {
    const options = createCronDatabase();
    const db = openOpenClawStateDatabase(options).db;
    db.prepare("UPDATE cron_run_receipts SET status = 'ok', finished_at_ms = 70").run();
    db.prepare(
      `INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
         status, owner_pid, started_at_ms, finished_at_ms, cursor_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(cursor_id), 0) + 1 FROM cron_run_receipts))`,
    ).run("cron-2", "default", "job-2", "revision-1", "main", "run-1", "skipped", 1, 60, 70);
    db.exec("UPDATE cron_run_receipts SET rowid = 100 WHERE receipt_id = 'cron-1'");
    db.prepare(
      `INSERT INTO execution_owner_lifecycle_bindings (
         owner_kind, owner_id, context_id, execution_id
       ) VALUES (?, ?, ?, ?)`,
    ).run("cron", "cron-2", "context-1", "execution-other");
    const context = executionContext();

    const first = presentExecutionDecisionReceiptsInDatabase(db, {
      schema: retainedLifecycleSchema,
      context,
      decisionLimit: 1,
      now: Date.now(),
    });
    expect(first.nextDecisionCursor).toBe("a:0:0");
    const cronPage = presentExecutionDecisionReceiptsInDatabase(db, {
      schema: retainedLifecycleSchema,
      context,
      decisionCursor: first.nextDecisionCursor,
      decisionLimit: 1,
      now: Date.now(),
    });
    expect(cronPage.decisions[0]?.source.owner).toBe("cron_run_receipts");
    expect(cronPage.decisionDisplays[0]).toMatchObject({
      decision: { outcome: "not-applicable", reasonCode: "cron_run_ok" },
      provenance: { state: "verified", producer: "cron-lifecycle" },
    });
    expect(cronPage.nextDecisionCursor).toBe("c:60:1");
    const mismatchPage = presentExecutionDecisionReceiptsInDatabase(db, {
      schema: retainedLifecycleSchema,
      context,
      decisionCursor: cronPage.nextDecisionCursor,
      decisionLimit: 1,
      now: Date.now(),
    });
    expect(mismatchPage.decisions[0]).toMatchObject({
      decision: { outcome: "unknown", reasonCode: "cron_run_execution_link_mismatch" },
      missingEvidence: ["decision.execution_link"],
    });
    expect(mismatchPage.nextDecisionCursor).toBeUndefined();
    expect(JSON.stringify(cronPage.decisionDisplays)).not.toMatch(
      /cron-1|private|cron_run_receipts/,
    );

    expect(
      presentExecutionDecisionReceiptsInDatabase(db, {
        schema: retainedLifecycleSchema,
        context,
        decisionCursor: "1",
        decisionLimit: 1,
        now: Date.now(),
      }).decisions[0]?.source.owner,
    ).toBe("cron_run_receipts");
  });

  const deletedAnchorCases = [
    {
      stage: "cron",
      cursor: "c:0:0",
      addSuccessor: (db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO cron_run_receipts (
             receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
             status, owner_pid, started_at_ms, finished_at_ms, cursor_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(cursor_id), 0) + 1 FROM cron_run_receipts))`,
        ).run("cron-2", "default", "job-2", "revision-1", "main", "run-1", "running", 1, 63, null);
        db.prepare(
          `INSERT INTO execution_owner_lifecycle_bindings (
             owner_kind, owner_id, context_id, execution_id
           ) VALUES ('cron', 'cron-2', 'context-1', 'execution-1')`,
        ).run();
      },
      deleteAnchor: (db: DatabaseSync) => {
        db.prepare(
          "DELETE FROM execution_owner_lifecycle_bindings WHERE owner_kind = 'cron' AND owner_id = 'cron-1'",
        ).run();
        db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = 'cron-1'").run();
      },
    },
  ] as const;

  it.each(deletedAnchorCases)(
    "rejects a nonzero $stage cursor after its exact owner anchor is deleted",
    async ({ cursor, addSuccessor, deleteAnchor }) => {
      const options = createCronDatabase();
      const db = openOpenClawStateDatabase(options).db;
      addSuccessor(db);
      const firstPage = presentExecutionDecisionReceiptsInDatabase(db, {
        schema: retainedLifecycleSchema,
        context: executionContext(),
        decisionCursor: cursor,
        decisionLimit: 1,
        now: Date.now(),
      });
      expect(firstPage.nextDecisionCursor).toMatch(/^c:[1-9]\d*:[1-9]\d*$/);

      deleteAnchor(db);

      expect(() =>
        presentExecutionDecisionReceiptsInDatabase(db, {
          schema: retainedLifecycleSchema,
          context: executionContext(),
          decisionCursor: firstPage.nextDecisionCursor,
          decisionLimit: 1,
          now: Date.now(),
        }),
      ).toThrow("decision cursor is no longer retained; restart inspection without --cursor");
    },
  );

  it("rejects a nonzero owner cursor when its retained anchor belongs to another context", async () => {
    const options = createCronDatabase();
    const db = openOpenClawStateDatabase(options).db;
    deletedAnchorCases[0].addSuccessor(db);
    const firstPage = presentExecutionDecisionReceiptsInDatabase(db, {
      schema: retainedLifecycleSchema,
      context: executionContext(),
      decisionCursor: "c:0:0",
      decisionLimit: 1,
      now: Date.now(),
    });
    expect(firstPage.nextDecisionCursor).toMatch(/^c:[1-9]\d*:[1-9]\d*$/);

    expect(() =>
      presentExecutionDecisionReceiptsInDatabase(db, {
        schema: retainedLifecycleSchema,
        context: executionContext("context-other"),
        decisionCursor: firstPage.nextDecisionCursor,
        decisionLimit: 1,
        now: Date.now(),
      }),
    ).toThrow("decision cursor is no longer retained; restart inspection without --cursor");
  });

  it("rejects a reused owner cursor whose binding belongs to another execution", async () => {
    const options = createCronDatabase();
    const db = openOpenClawStateDatabase(options).db;
    db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = 'cron-1'").run();
    db.prepare(
      `INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
         status, owner_pid, started_at_ms, finished_at_ms, cursor_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(cursor_id), 0) + 1 FROM cron_run_receipts))`,
    ).run("cron-2", "default", "job-2", "revision-1", "main", "run-1", "running", 1, 63, null);
    db.prepare(
      `INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
         status, owner_pid, started_at_ms, finished_at_ms, cursor_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(cursor_id), 0) + 1 FROM cron_run_receipts))`,
    ).run("cron-1", "default", "job-1", "revision-1", "main", "run-1", "running", 1, 60, null);
    db.prepare(
      `INSERT INTO execution_owner_lifecycle_bindings (
         owner_kind, owner_id, context_id, execution_id
       ) VALUES ('cron', 'cron-2', 'context-1', 'execution-1')`,
    ).run();
    const firstPage = presentExecutionDecisionReceiptsInDatabase(db, {
      schema: retainedLifecycleSchema,
      context: executionContext(),
      decisionCursor: "c:0:0",
      decisionLimit: 1,
      now: Date.now(),
    });
    expect(firstPage.nextDecisionCursor).toMatch(/^c:60:[1-9]\d*$/);

    db.prepare(
      "DELETE FROM execution_owner_lifecycle_bindings WHERE owner_kind = 'cron' AND owner_id = 'cron-1'",
    ).run();
    db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = 'cron-1'").run();
    db.prepare(
      `INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
         status, owner_pid, started_at_ms, finished_at_ms, cursor_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(cursor_id), 0) + 1 FROM cron_run_receipts))`,
    ).run(
      "cron-replacement",
      "default",
      "job-replacement",
      "revision-1",
      "main",
      "run-2",
      "running",
      1,
      60,
      null,
    );
    db.prepare(
      `INSERT INTO execution_owner_lifecycle_bindings (
         owner_kind, owner_id, context_id, execution_id
       ) VALUES ('cron', 'cron-replacement', 'context-1', 'execution-other')`,
    ).run();

    expect(() =>
      presentExecutionDecisionReceiptsInDatabase(db, {
        schema: retainedLifecycleSchema,
        context: executionContext(),
        decisionCursor: firstPage.nextDecisionCursor,
        decisionLimit: 1,
        now: Date.now(),
      }),
    ).toThrow("decision cursor is no longer retained; restart inspection without --cursor");
  });

  it("projects every cron terminal state without rederiving lifecycle precedence", async () => {
    const options = createCronDatabase();
    const context = executionContext();
    const db = openOpenClawStateDatabase(options).db;

    for (const status of ["ok", "error", "skipped", "interrupted", "superseded"]) {
      db.prepare(
        "UPDATE cron_run_receipts SET status = ?, finished_at_ms = 70 WHERE receipt_id = ?",
      ).run(status, "cron-1");
      expect(
        pageOwnerLifecycleReceiptsInDatabase(db, {
          schema: retainedLifecycleSchema,
          context,
          limit: 1,
        }).entries[0]?.receipt.decision,
      ).toEqual({ outcome: "not-applicable", reasonCode: `cron_run_${status}` });
    }
  });
});
