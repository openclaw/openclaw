import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIdentityContextV1 } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { recordAuditEventInDatabase } from "./audit-event-store.js";
import { input as runInput } from "./audit-event-writer.test-support.js";
import { createUnattributedExecutionContext } from "./execution-decision-facts.test-support.js";
import { presentExecutionDecisionReceiptsInDatabase } from "./execution-decision-receipts.js";
import {
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
} from "./execution-identity-admission.js";
import {
  inspectExecutionIdentityRun as inspectRun,
  processExecutionIdentityAdmissionWorkInDatabase as processAdmission,
  pruneExpiredExecutionIdentityContextsInDatabase as pruneContexts,
} from "./execution-identity-context.js";
import {
  captureExecutionIdentityAdmissionEnvelope as captureEnvelope,
  executionIdentityFacts as facts,
  persistExecutionIdentityAdmissionEnvelope as persistEnvelope,
  prepareExecutionIdentityContextAtAdmission as prepareContext,
} from "./execution-identity.test-support.js";
import { deleteExecutionOwnerLifecycleMetadata } from "./execution-owner-lifecycle-binding-store.js";
import {
  pageOwnerLifecycleReceiptsInDatabase,
  summarizeOwnerLifecycleReceiptsInDatabase,
} from "./execution-owner-lifecycle-receipts.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;

let store: ReturnType<typeof createStore>;
afterEach(restartDatabase);

async function restartDatabase() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function identity(id: string, now: number, runtimeInstanceId = "runtime-1") {
  return { contextId: `context-${id}`, executionId: `execution-${id}`, now, runtimeInstanceId };
}

function rows(db: EngineConnection, sql: string) {
  return db.prepare(sql).all();
}

function count(db: EngineConnection, table: string) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
}

function createStore() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-identity-") } };
  const open = () => openOpenClawStateDatabase(options);
  const writeOptions = () => ({ ...options, database: open() });
  return {
    options,
    open,
    prepare: (runId: string, admission: Parameters<typeof prepareContext>[1] = {}) =>
      prepareContext(facts(runId), { ...options, runtimeInstanceId: "runtime-1", ...admission }),
    inspect: (selector: Parameters<typeof inspectRun>[0], now?: number) =>
      inspectRun(selector, { ...options, now }),
    process: (work: Parameters<typeof processAdmission>[0], now?: number) =>
      processAdmission(work, { ...writeOptions(), now }),
    prune: (now?: number) => pruneContexts({ database: writeOptions(), now }),
  };
}

describe("execution identity context storage", () => {
  beforeEach(() => {
    store = createStore();
  });
  it("replays frozen, canonical, redacted attribution across restart", async () => {
    const representedSubject = {
      state: "present" as const,
      kind: "person" as const,
      rawPrincipalRef: "selected-person",
    };
    const ingress = {
      kind: "system" as const,
      boundary: "gateway.boot",
      state: "present" as const,
    };
    const envelope = captureEnvelope(
      facts("run-present", {
        ingress,
        invoker: {
          state: "present",
          kind: "local-account",
          rawPrincipalRef: "private-local-account",
          displayLabel: "Operator OPENAI_API_KEY=sk-1234567890abcdef",
        },
        representedSubject,
        applicableGrants: ["grant-é", "grant-z", "grant-é"].map((rawGrantRef) => ({
          rawGrantRef,
          state: "present" as const,
        })),
        assurance: [
          {
            kind: "local-process",
            rawEvidenceRef: "private-process-evidence",
            strength: "boundary-verified",
          },
        ],
      }),
      identity("present", 100, "private-runtime"),
    );
    expect(envelope).toMatchObject({
      contextId: "context-present",
      executionId: "execution-present",
      runId: "run-present",
      createdAt: 100,
      runtimeInstanceId: "private-runtime",
      ingress,
    });
    expect(envelope.applicableGrants).toEqual(
      ["grant-z", "grant-é"].map((rawGrantRef) => ({ rawGrantRef, state: "present" })),
    );
    expect(envelope.representedSubject).toEqual(representedSubject);
    expect(envelope.invoker).toMatchObject({ displayLabel: expect.any(String) });
    for (const value of [
      envelope,
      envelope.ingress,
      envelope.representedSubject,
      envelope.assurance,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    const stringify = vi.spyOn(JSON, "stringify");
    let first: ExecutionIdentityContextV1;
    try {
      first = persistEnvelope(envelope, { ...store.options, now: 100 });
      const encodings = stringify.mock.calls.flatMap(([value], index) =>
        value === first ? [stringify.mock.results[index]?.value] : [],
      );
      expect(encodings).toHaveLength(1);
      expect(
        store
          .open()
          .db.prepare("SELECT context_json, context_bytes FROM execution_identity_contexts")
          .get(),
      ).toEqual({
        context_json: encodings[0],
        context_bytes: Buffer.byteLength(encodings[0], "utf8"),
      });
    } finally {
      stringify.mockRestore();
    }
    await restartDatabase();
    const second = persistEnvelope(structuredClone(envelope), { ...store.options, now: 999 });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      invoker: { state: "present" },
      ingress,
      coverageState: "attribution-only",
      missingEvidence: [],
    });
    expect(first.invoker.principal?.principalRef).toMatch(/^hmac-sha256:v1:/u);
    expect([first, first.runtimeInstance].map(Object.isFrozen)).toEqual([true, true]);
    expect(JSON.stringify(first)).not.toMatch(
      /selected-person|private-local-account|private-process-evidence|private-runtime|grant-é|grant-z|sk-1234567890abcdef/,
    );
    await restartDatabase();
    const result = await store.inspect({ runId: "run-present" }, 999);
    expect(result.identity).toEqual({ state: "present", context: first });
    const token = createExecutionIdentityAdmissionToken("run-present", identity("present", 100));
    expect(store.process({ kind: "retry-reference", token })).toEqual(first);
  });

  it("keeps distinct turns sharing one run correlation exactly inspectable", async () => {
    store.prepare("session-run", identity("first", 100));
    store.prepare("session-run", identity("second", 101));
    const candidates = ["first", "second"].map((id) => ({
      executionId: `execution-${id}`,
      contextId: `context-${id}`,
    }));
    expect(await store.inspect({ runId: "session-run" }, 300)).toMatchObject({
      identity: {
        state: "ambiguous",
        reasonCode: "execution_selection_required",
        candidates,
      },
      decisions: [],
    });
    for (const [executionOffset, executionId, nextExecutionCursor] of [
      [0, "execution-first", "1"],
      [1, "execution-second", undefined],
    ] as const) {
      const selection = await store.inspect(
        { runId: "session-run", executionOffset, executionLimit: 1 },
        300,
      );
      expect(selection).toMatchObject({
        identity: { state: "ambiguous", candidates: [{ executionId }] },
      });
      expect(selection.nextExecutionCursor).toBe(nextExecutionCursor);
    }
    for (const id of ["first", "second"]) {
      const inspection = await store.inspect({ executionId: `execution-${id}` }, 300);
      expect(inspection.identity).toMatchObject({
        state: "present",
        context: { contextId: `context-${id}` },
      });
    }
  });

  it("rejects recovery without manufacturing lost evidence", async () => {
    const token = createExecutionIdentityAdmissionToken("run-recovery", identity("recovery", 100));

    expect(() => store.process({ kind: "retry-reference", token })).toThrow(
      "execution identity recovery evidence unavailable",
    );
    expect(await store.inspect({ executionId: "execution-recovery" })).toMatchObject({
      run: { executionId: "execution-recovery", status: "unknown" },
      identity: { state: "unknown", reasonCode: "execution_not_found" },
      decisions: [],
    });
  });

  it("keeps maintenance lazy before capture and active after collection is disabled", () => {
    const hasContexts = () => tableExists(store.open().db, "execution_identity_contexts");
    expect(hasContexts()).toBe(false);
    expect(store.prune()).toBe(0);
    expect(hasContexts()).toBe(false);
    store.prepare("run-before-disable", { now: 0 });
    expect(
      enqueueExecutionIdentityContextAtAdmission(facts("run-disabled"), { enabled: false }),
    ).toBeUndefined();

    expect(store.prune(RETENTION_MS + 1)).toBe(1);
    expect(count(store.open().db, "execution_identity_contexts")).toEqual({ count: 0 });
  });

  it("rolls back the worker write when insert-time retention cleanup fails", () => {
    store.prepare("run-expired", { now: 0 });
    store.open().db.exec(`
      CREATE TRIGGER reject_identity_cleanup
      BEFORE DELETE ON execution_identity_contexts
      BEGIN
        SELECT RAISE(ABORT, 'cleanup unavailable');
      END;
    `);

    expect(() => store.prepare("run-still-admitted", { now: RETENTION_MS + 1 })).toThrow(
      "cleanup unavailable",
    );
  });

  it("enforces the row cap across independent database connections", () => {
    const first = store.open();
    const second = { ...first, db: openNodeSqliteDatabase(first.path) };
    try {
      for (const [index, connection] of [first, second, first, second].entries()) {
        const runId = `shared-cap-${index + 1}`;
        prepareContext(facts(runId), {
          database: connection,
          now: 100 + index,
          contextId: `context-${runId}`,
          runtimeInstanceId: "runtime-1",
          limits: { maxRows: 2, pruneBatchRows: 1 },
        });
      }

      const retained = rows(
        first.db,
        "SELECT run_id FROM execution_identity_contexts ORDER BY created_at",
      );
      expect(retained.map((row) => row.run_id)).toEqual(["shared-cap-3", "shared-cap-4"]);
    } finally {
      second.db.close();
    }
  });

  it("prunes oldest overflow across timestamp ties within the remaining expiry budget", () => {
    const add = (id: string, now: number, limits?: { maxRows: number; pruneBatchRows: number }) =>
      store.prepare(`run-${id}`, {
        now,
        contextId: id,
        limits,
      });
    add("expired-a", 0);
    add("expired-b", 0);
    for (const id of ["b", "c", "d", "e"]) {
      add(id, RETENTION_MS - 100);
    }
    const retained = () =>
      rows(
        store.open().db,
        "SELECT context_id FROM execution_identity_contexts ORDER BY created_at, context_id",
      );
    const limits = { maxRows: 2, pruneBatchRows: 3 };
    add("new", RETENTION_MS + 1, limits);
    expect(retained()).toEqual(["c", "d", "e", "new"].map((context_id) => ({ context_id })));
    add("newer", RETENTION_MS + 2, limits);
    expect(retained()).toEqual([{ context_id: "new" }, { context_id: "newer" }]);
    add("last", RETENTION_MS + 3, { maxRows: 0, pruneBatchRows: 3 });
    expect(retained()).toEqual([]);
  });

  it("inspects through a read-only connection while another writer holds the database", async () => {
    store.prepare("locked", identity("locked", 100));
    const path = store.open().path;
    await restartDatabase();
    const lockDatabase = openNodeSqliteDatabase(path);
    lockDatabase.exec("BEGIN IMMEDIATE");
    try {
      expect(
        (await store.inspect({ executionId: "execution-locked" }, 100)).identity,
      ).toMatchObject({
        state: "present",
        context: { contextId: "context-locked" },
      });
    } finally {
      lockDatabase.exec("ROLLBACK");
      lockDatabase.close();
    }
  });

  it.each([
    ["corrupt", "known", "identity_context_corrupt", undefined],
    ["missing", "unknown", "run_not_found", "verify_run_id"],
    ["legacy", "known", "identity_context_unavailable", "record_new_identity_context"],
  ] as const)("returns a typed projection for %s", async (runId, status, reasonCode, code) => {
    if (runId === "corrupt") {
      store.prepare(runId);
      store
        .open()
        .db.prepare("UPDATE execution_identity_contexts SET context_json = ? WHERE run_id = ?")
        .run("{", runId);
    } else if (runId === "legacy") {
      recordAuditEventInDatabase(
        { ...runInput(), sourceId: "legacy-run:1", runId },
        { ...store.options, database: store.open() },
      );
    }
    expect(await store.inspect({ runId })).toMatchObject({
      run: { status },
      identity: {
        state: runId === "legacy" ? "unsupported" : "unknown",
        reasonCode,
        ...(code ? { remediation: [expect.objectContaining({ code })] } : {}),
      },
      ...(runId === "corrupt" ? { coverage: { state: "unknown" } } : {}),
    });
  });
});

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

function present(db: EngineConnection, decisionCursor?: string) {
  return presentExecutionDecisionReceiptsInDatabase(db, {
    schema: retainedLifecycleSchema,
    context: executionContext(),
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

function deleteAnchor(db: EngineConnection) {
  db.prepare(
    "DELETE FROM execution_owner_lifecycle_bindings WHERE owner_kind = 'cron' AND owner_id = 'cron-1'",
  ).run();
  db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = 'cron-1'").run();
}

function createCronDatabase(retainedBinding = true) {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("owner-lifecycle-") } };
  const { db } = openOpenClawStateDatabase(options);
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  if (!retainedBinding) {
    db.exec("DROP TABLE execution_owner_lifecycle_bindings");
  }
  addCron(db, "cron-1");
  if (retainedBinding) {
    bindCron(db, "cron-1");
  }
  return options;
}

function openCronDatabase() {
  return openOpenClawStateDatabase(createCronDatabase()).db;
}

function executionContext(): ExecutionIdentityContextV1 {
  return {
    ...createUnattributedExecutionContext(),
    invoker: { state: "unknown" },
    ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
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

  it("keeps unbound cron storage opt-in on reopen", () => {
    const db = openOpenClawStateDatabase(createCronDatabase(false)).db;
    expect(
      page(db, { cronRunReceipts: true, executionOwnerLifecycleBindings: false }).entries,
    ).toEqual([]);
    expect(tableExists(db, "execution_owner_lifecycle_bindings")).toBe(false);
  });

  it.each(["ok", "error", "skipped", "interrupted", "superseded"])(
    "preserves the bound cron %s receipt on reopen",
    async (status) => {
      const options = createCronDatabase();
      const current = openOpenClawStateDatabase(options).db;
      current.prepare("UPDATE cron_run_receipts SET status = ?, finished_at_ms = 70").run(status);

      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      const reopened = openOpenClawStateDatabase(options).db;
      expect(page(reopened).entries[0]?.receipt.decision).toEqual({
        outcome: "not-applicable",
        reasonCode: `cron_run_${status}`,
      });
      expect(count(reopened, "execution_decision_facts")).toEqual({ count: 0 });
    },
  );

  it("keeps cron cursors stable and rejects mismatched or reused execution bindings", () => {
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

    deleteAnchor(db);
    db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = 'cron-2'").run();
    addCron(db, "cron-replacement", 60, "running", null, "run-2");
    bindCron(db, "cron-replacement", "execution-other");

    expect(() => present(db, cronPage.nextDecisionCursor)).toThrow(
      "decision cursor is no longer retained; restart inspection without --cursor",
    );
  });
});
