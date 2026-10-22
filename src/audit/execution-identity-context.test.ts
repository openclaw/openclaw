import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIdentityContextV1 } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableHasColumn, tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { recordAuditEventInDatabase } from "./audit-event-store.js";
import { input as runInput } from "./audit-event-writer.test-support.js";
import { createUnattributedExecutionContext } from "./execution-decision-facts.test-support.js";
import { presentExecutionDecisionReceiptsInDatabase } from "./execution-decision-receipts.js";
import {
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionFacts,
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
  recordDeniedApprovalForRun,
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

function openIndependentStateDatabase(path: string): OpenClawStateDatabase {
  return {
    db: openNodeSqliteDatabase(path),
    path,
    walMaintenance: {
      stop: async () => {},
      checkpoint: () => true,
      close: () => true,
      reclaimFreePages: createSqliteWalReclamationResult,
    },
  };
}

function createStore() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-identity-") } };
  const open = () => openOpenClawStateDatabase(options);
  const writeOptions = () => ({ ...options, database: open() });
  return {
    options,
    open,
    prepare: (
      runId: string,
      admission: Parameters<typeof prepareContext>[1] = {},
      overrides: Partial<ExecutionIdentityAdmissionFacts> = {},
    ) => prepareContext(facts(runId, overrides), { ...options, ...admission }),
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
  it.each([
    ["absent", "unattributed"],
    ["unknown", "unknown"],
    ["present", "attribution-only"],
  ] as const)("replays canonical %s attribution across restart", async (state, coverageState) => {
    const attributed = state === "present";
    const envelope = captureEnvelope(
      facts(
        `run-${state}`,
        attributed
          ? {
              invoker: {
                state,
                kind: "local-account",
                rawPrincipalRef: "private-local-account",
                displayLabel: "Operator OPENAI_API_KEY=sk-1234567890abcdef",
              },
              applicableGrants: ["grant-z", "grant-a"].map((rawGrantRef) => ({
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
            }
          : state === "unknown"
            ? { invoker: { state } }
            : {},
      ),
      identity(state, 100, "private-runtime"),
    );
    const first = persistEnvelope(envelope, { ...store.options, now: 100 });
    await restartDatabase();
    const second = persistEnvelope(structuredClone(envelope), { ...store.options, now: 999 });
    expect(second).toEqual(first);
    const missingEvidence = attributed ? [] : ["invoker.principal"];
    expect(first).toMatchObject({ invoker: { state }, coverageState, missingEvidence });
    if (!attributed) {
      expect(first.invoker).toEqual({ state });
    } else {
      const grants = first.applicableGrants.map(({ grantRef }) => grantRef);
      expect(grants).toEqual(grants.toSorted());
      expect(first.invoker.principal?.principalRef).toMatch(/^hmac-sha256:v1:/u);
    }
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.runtimeInstance)).toBe(true);
    for (const secret of [
      "private-local-account",
      "private-process-evidence",
      "private-runtime",
      "grant-a",
      "grant-z",
      "sk-1234567890abcdef",
    ]) {
      expect(JSON.stringify(first)).not.toContain(secret);
    }
    await restartDatabase();
    const result = await store.inspect({ executionId: `execution-${state}` }, 999);
    expect(result.identity).toEqual({ state: "present", context: first });
    if (state === "unknown") {
      expect(result.coverage).toEqual({ state: "unknown", missingEvidence });
      expect(result.decisions).toEqual([
        expect.objectContaining({
          enforcement: expect.objectContaining({ coverageState: "unknown" }),
          missingEvidence,
        }),
      ]);
    }
  });

  it("keeps distinct turns sharing one run correlation exactly inspectable", async () => {
    store.prepare("session-run", identity("first", 100));
    store.prepare("session-run", identity("second", 101));
    await recordDeniedApprovalForRun("session-run", store.options, "shared-run-approval", {
      contextId: "context-first",
      executionId: "execution-first",
    });

    const discovery = await store.inspect({ runId: "session-run" }, 300);
    expect(discovery).toMatchObject({
      run: { runId: "session-run", status: "known" },
      identity: {
        state: "ambiguous",
        reasonCode: "execution_selection_required",
        candidates: [
          { executionId: "execution-first", contextId: "context-first" },
          { executionId: "execution-second", contextId: "context-second" },
        ],
      },
      decisions: [],
    });
    for (const [executionOffset, executionId, nextExecutionCursor] of [
      [0, "execution-first", "1"],
      [1, "execution-second", undefined],
    ] as const) {
      expect(
        await store.inspect({ runId: "session-run", executionOffset, executionLimit: 1 }, 300),
      ).toMatchObject({
        identity: { state: "ambiguous", candidates: [{ executionId }] },
        ...(nextExecutionCursor ? { nextExecutionCursor } : {}),
      });
    }
    const firstInspection = await store.inspect({ executionId: "execution-first" }, 300);
    const secondInspection = await store.inspect({ executionId: "execution-second" }, 300);
    expect(firstInspection).toMatchObject({
      identity: { state: "present", context: { contextId: "context-first" } },
      coverage: { state: "enforced" },
      decisions: [{ decision: { outcome: "not-applicable" } }, { decision: { outcome: "denied" } }],
    });
    expect(secondInspection).toMatchObject({
      identity: { state: "present", context: { contextId: "context-second" } },
      coverage: {
        state: "unknown",
        missingEvidence: expect.arrayContaining(["decision.execution_link"]),
      },
      decisions: [
        { decision: { outcome: "not-applicable" } },
        {
          decision: {
            outcome: "unknown",
            reasonCode: "operator_approval_execution_link_mismatch",
          },
        },
      ],
    });
    store.prepare("session-run", identity("third", 102));
    const nextPage = await store.inspect(
      { runId: "session-run", executionOffset: 2, executionLimit: 1 },
      300,
    );
    expect(nextPage.identity).toMatchObject({
      state: "ambiguous",
      candidates: [{ executionId: "execution-third", contextId: "context-third", createdAt: 102 }],
    });
    expect(nextPage).not.toHaveProperty("nextExecutionCursor");
  });

  it.each([
    ["local-cli", "agent-command.local"],
    ["system", "gateway.boot"],
  ] as const)("projects authoritative %s ingress", async (kind, boundary) => {
    const ingress = { kind, boundary, state: "present" as const };
    store.prepare("run", {}, kind === "system" ? { ingress } : {});
    expect((await store.inspect({ runId: "run" })).identity).toMatchObject({
      state: "present",
      context: { ingress },
    });
  });

  it("confirms durable retries without manufacturing lost evidence", async () => {
    const envelope = captureEnvelope(
      facts("run-recovery"),
      identity("recovery", 100, "runtime-original"),
    );
    const original = store.process({ kind: "capture", envelope }, 100);
    const token = createExecutionIdentityAdmissionToken("run-recovery", identity("recovery", 100));

    await restartDatabase();
    expect(store.process({ kind: "retry-reference", token })).toEqual(original);

    const missingDatabase = createStore();
    expect(() => missingDatabase.process({ kind: "retry-reference", token })).toThrow(
      "execution identity recovery evidence unavailable",
    );
    expect(await missingDatabase.inspect({ executionId: "execution-recovery" })).toMatchObject({
      run: { executionId: "execution-recovery", status: "unknown" },
      identity: { state: "unknown", reasonCode: "execution_not_found" },
      decisions: [],
    });
  });

  it("keeps maintenance read-only until the first identity capture", () => {
    const table = () =>
      store
        .open()
        .db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts");
    expect(table()).toBeUndefined();
    expect(store.prune()).toBe(0);
    expect(table()).toBeUndefined();
  });

  it("keeps bounded retention maintenance available while collection is disabled", () => {
    store.prepare("run-before-disable", { now: 0, runtimeInstanceId: "runtime-1" });
    expect(
      enqueueExecutionIdentityContextAtAdmission(facts("run-disabled"), { enabled: false }),
    ).toBeUndefined();

    expect(store.prune(RETENTION_MS + 1)).toBe(1);
    expect(
      store.open().db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts").get(),
    ).toEqual({ count: 0 });
  });

  it("rolls back the worker write when insert-time retention cleanup fails", () => {
    store.prepare("run-expired", { now: 0, runtimeInstanceId: "runtime-1" });
    store.open().db.exec(`
      CREATE TRIGGER reject_identity_cleanup
      BEFORE DELETE ON execution_identity_contexts
      BEGIN
        SELECT RAISE(ABORT, 'cleanup unavailable');
      END;
    `);

    expect(() =>
      store.prepare("run-still-admitted", {
        now: RETENTION_MS + 1,
        runtimeInstanceId: "runtime-1",
      }),
    ).toThrow("cleanup unavailable");
  });

  it("enforces the row cap across independent database connections", () => {
    const path = store.open().path;
    closeOpenClawStateDatabaseForTest();
    const first = openIndependentStateDatabase(path);
    const second = openIndependentStateDatabase(path);
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

      const retained = first.db
        .prepare("SELECT run_id FROM execution_identity_contexts ORDER BY created_at")
        .all() as Array<{ run_id: string }>;
      expect(retained.map((row) => row.run_id)).toEqual(["shared-cap-3", "shared-cap-4"]);
    } finally {
      first.db.close();
      second.db.close();
    }
  });

  it("prunes oldest overflow across timestamp ties within the remaining expiry budget", () => {
    const add = (id: string, now: number, limits?: { maxRows: number; pruneBatchRows: number }) =>
      store.prepare(`run-${id}`, {
        now,
        contextId: id,
        runtimeInstanceId: "runtime-1",
        limits,
      });
    add("expired-a", 0);
    add("expired-b", 0);
    for (const id of ["b", "c", "d", "e"]) {
      add(id, RETENTION_MS - 100);
    }
    const retained = () =>
      store
        .open()
        .db.prepare(
          "SELECT context_id FROM execution_identity_contexts ORDER BY created_at, context_id",
        )
        .all();
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
      expect(await store.inspect({ executionId: "execution-locked" }, 100)).toMatchObject({
        identity: {
          state: "present",
          context: {
            contextId: "context-locked",
            executionId: "execution-locked",
            runId: "locked",
          },
        },
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
      store.prepare(runId, { runtimeInstanceId: "runtime-1" });
      store
        .open()
        .db.prepare("UPDATE execution_identity_contexts SET context_json = ? WHERE run_id = ?")
        .run("{", runId);
    } else if (runId === "legacy") {
      recordAuditEventInDatabase(
        {
          ...runInput(),
          sourceId: "legacy-run:1",
          runId,
        },
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

function deleteAnchor(db: EngineConnection) {
  db.prepare(
    "DELETE FROM execution_owner_lifecycle_bindings WHERE owner_kind = 'cron' AND owner_id = 'cron-1'",
  ).run();
  db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = 'cron-1'").run();
}

function createCronDatabase(retainedBinding = true) {
  const pathname = nodePath.join(tempDirs.make("owner-lifecycle-"), "openclaw.sqlite");
  const oldReader = new DatabaseSync(pathname);
  oldReader.exec(OPENCLAW_STATE_SCHEMA_SQL);
  if (!retainedBinding) {
    oldReader.exec("DROP TABLE execution_owner_lifecycle_bindings");
  }
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
    ...createUnattributedExecutionContext(),
    contextId,
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
    addCron(db, "cron-2", 61);
    bindCron(db, "cron-2");
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
