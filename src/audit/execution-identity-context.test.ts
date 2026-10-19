import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordAuditEventInDatabase } from "./audit-event-store.js";
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
  persistExecutionIdentityAdmissionEnvelope as persistEnvelope,
  prepareExecutionIdentityContextAtAdmission as prepareContext,
  recordDeniedApprovalForRun,
} from "./execution-identity.test-support.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;

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

function facts(
  runId: string,
  overrides: Partial<ExecutionIdentityAdmissionFacts> = {},
): ExecutionIdentityAdmissionFacts {
  return {
    runId,
    agentId: "main",
    ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
    runtime: { kind: "embedded" },
    ...overrides,
  };
}

function createStore() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-identity-") } };
  const open = () => openOpenClawStateDatabase(options);
  return {
    options,
    open,
    prepare(
      runId: string,
      admission: Parameters<typeof prepareContext>[1] = {},
      overrides: Partial<ExecutionIdentityAdmissionFacts> = {},
    ) {
      return prepareContext(facts(runId, overrides), {
        ...options,
        ...admission,
      });
    },
    inspect(selector: Parameters<typeof inspectRun>[0], now?: number) {
      return inspectRun(selector, { ...options, now });
    },
    process(work: Parameters<typeof processAdmission>[0], now?: number) {
      return processAdmission(work, {
        ...options,
        database: open(),
        now,
      });
    },
    prune(now?: number) {
      return pruneContexts({
        database: { ...options, database: open() },
        now,
      });
    },
  };
}

describe("execution identity context storage", () => {
  it("replays one byte-identical canonical context idempotently across restart", async () => {
    const database = createStore();
    const envelope = captureEnvelope(facts("run-1"), identity("1", 100, "runtime-secret-1"));
    const first = persistEnvelope(envelope, {
      ...database.options,
      now: 100,
    });

    await restartDatabase();
    const second = persistEnvelope(structuredClone(envelope), {
      ...database.options,
      now: 999,
    });

    expect(second).toEqual(first);
    expect(first.coverageState).toBe("unattributed");
    expect(first.invoker).toEqual({ state: "absent" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.runtimeInstance)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("runtime-secret-1");

    await restartDatabase();
    const afterRestart = await database.inspect({ executionId: "execution-1" }, 999);
    expect(afterRestart.identity).toEqual({ state: "present", context: first });
  });

  it("keeps explicit unknown invoker evidence distinct from omission across restart", async () => {
    const database = createStore();
    const unknown = database.prepare("run-unknown", identity("unknown", 100, "runtime-unknown"), {
      invoker: { state: "unknown" },
    });
    const absent = database.prepare("run-absent", identity("absent", 101, "runtime-absent"));

    expect(unknown).toMatchObject({
      invoker: { state: "unknown" },
      coverageState: "unknown",
      missingEvidence: ["invoker.principal"],
    });
    expect(unknown.invoker).not.toHaveProperty("principal");
    expect(absent).toMatchObject({
      invoker: { state: "absent" },
      coverageState: "unattributed",
      missingEvidence: ["invoker.principal"],
    });

    await restartDatabase();
    const unknownAfterRestart = await database.inspect({ executionId: "execution-unknown" }, 101);
    expect(unknownAfterRestart.identity).toEqual({ state: "present", context: unknown });
    expect(unknownAfterRestart.coverage).toEqual({
      state: "unknown",
      missingEvidence: ["invoker.principal"],
    });
    expect(unknownAfterRestart.decisions).toEqual([
      expect.objectContaining({
        enforcement: expect.objectContaining({ coverageState: "unknown" }),
        missingEvidence: ["invoker.principal"],
      }),
    ]);
    expect((await database.inspect({ executionId: "execution-absent" }, 101)).identity).toEqual({
      state: "present",
      context: absent,
    });
  });

  it("keeps distinct turns sharing one run correlation exactly inspectable", async () => {
    const database = createStore();
    database.prepare("session-run", identity("first", 100));
    database.prepare("session-run", identity("second", 101));
    await recordDeniedApprovalForRun("session-run", database.options, "shared-run-approval", {
      contextId: "context-first",
      executionId: "execution-first",
    });

    const discovery = await database.inspect({ runId: "session-run" }, 300);
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
        await database.inspect({ runId: "session-run", executionOffset, executionLimit: 1 }, 300),
      ).toMatchObject({
        identity: { state: "ambiguous", candidates: [{ executionId }] },
        ...(nextExecutionCursor ? { nextExecutionCursor } : {}),
      });
    }
    const firstInspection = await database.inspect({ executionId: "execution-first" }, 300);
    const secondInspection = await database.inspect({ executionId: "execution-second" }, 300);
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
    database.prepare("session-run", identity("third", 102));
    const nextPage = await database.inspect(
      { runId: "session-run", executionOffset: 2, executionLimit: 1 },
      300,
    );
    expect(nextPage.identity).toMatchObject({
      state: "ambiguous",
      candidates: [{ executionId: "execution-third", contextId: "context-third", createdAt: 102 }],
    });
    expect(nextPage).not.toHaveProperty("nextExecutionCursor");
  });

  it("confirms durable retries without manufacturing lost evidence", async () => {
    const database = createStore();
    const envelope = captureEnvelope(
      facts("run-recovery"),
      identity("recovery", 100, "runtime-original"),
    );
    const original = database.process({ kind: "capture", envelope }, 100);
    const token = createExecutionIdentityAdmissionToken("run-recovery", {
      now: 100,
      contextId: "context-recovery",
      executionId: "execution-recovery",
    });

    await restartDatabase();
    expect(database.process({ kind: "retry-reference", token })).toEqual(original);

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

  it("projects authoritative local CLI and system ingress without conflating them", async () => {
    const database = createStore();
    database.prepare("run-local");
    database.prepare(
      "run-system",
      {},
      {
        ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
      },
    );

    expect((await database.inspect({ runId: "run-local" })).identity).toMatchObject({
      state: "present",
      context: {
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
      },
    });
    expect((await database.inspect({ runId: "run-system" })).identity).toMatchObject({
      state: "present",
      context: {
        ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
      },
    });
  });

  it("keeps maintenance read-only until the first identity capture", () => {
    const database = createStore();
    const opened = database.open();
    expect(
      opened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();

    expect(database.prune()).toBe(0);
    expect(
      opened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();
  });

  it("records attribution only when an invoker fact is actually present", () => {
    const database = createStore();
    const context = database.prepare(
      "run-attributed",
      { runtimeInstanceId: "private-runtime" },
      {
        invoker: {
          state: "present",
          kind: "local-account",
          rawPrincipalRef: "private-local-account",
          displayLabel: "Operator OPENAI_API_KEY=sk-1234567890abcdef",
        },
        applicableGrants: [
          { rawGrantRef: "grant-z", state: "present" },
          { rawGrantRef: "grant-a", state: "present" },
        ],
        assurance: [
          {
            kind: "local-process",
            rawEvidenceRef: "private-process-evidence",
            strength: "boundary-verified",
          },
        ],
      },
    );
    const encoded = JSON.stringify(context);

    expect(context.coverageState).toBe("attribution-only");
    expect(context.invoker.state).toBe("present");
    expect(context.missingEvidence).toEqual([]);
    expect(context.applicableGrants.map((grant) => grant.grantRef)).toEqual(
      context.applicableGrants.map((grant) => grant.grantRef).toSorted(),
    );
    for (const secret of [
      "private-local-account",
      "private-process-evidence",
      "private-runtime",
      "grant-a",
      "grant-z",
      "sk-1234567890abcdef",
    ]) {
      expect(encoded).not.toContain(secret);
    }
    expect(context.invoker.principal?.principalRef).toMatch(/^hmac-sha256:v1:/u);
  });

  it("keeps bounded retention maintenance available while collection is disabled", () => {
    const database = createStore();
    database.prepare("run-before-disable", { now: 0, runtimeInstanceId: "runtime-1" });
    expect(
      enqueueExecutionIdentityContextAtAdmission(facts("run-disabled"), { enabled: false }),
    ).toBeUndefined();

    expect(database.prune(RETENTION_MS + 1)).toBe(1);
    expect(
      database.open().db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts").get(),
    ).toEqual({ count: 0 });
  });

  it("rolls back the worker write when insert-time retention cleanup fails", () => {
    const database = createStore();
    database.prepare("run-expired", { now: 0, runtimeInstanceId: "runtime-1" });
    database.open().db.exec(`
      CREATE TRIGGER reject_identity_cleanup
      BEFORE DELETE ON execution_identity_contexts
      BEGIN
        SELECT RAISE(ABORT, 'cleanup unavailable');
      END;
    `);

    expect(() =>
      database.prepare("run-still-admitted", {
        now: RETENTION_MS + 1,
        runtimeInstanceId: "runtime-1",
      }),
    ).toThrow("cleanup unavailable");
  });

  it("enforces the row cap across independent database connections", () => {
    const database = createStore();
    const path = database.open().path;
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
    const database = createStore();
    const add = (id: string, now: number, limits?: { maxRows: number; pruneBatchRows: number }) =>
      database.prepare(`run-${id}`, {
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
      database
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
    const database = createStore();
    database.prepare("held-lock-inspection", identity("held-lock-inspection", 100));
    const path = database.open().path;
    await restartDatabase();
    const lockDatabase = openNodeSqliteDatabase(path);
    lockDatabase.exec("BEGIN IMMEDIATE");
    try {
      expect(
        await database.inspect({ executionId: "execution-held-lock-inspection" }, 100),
      ).toMatchObject({
        identity: {
          state: "present",
          context: {
            contextId: "context-held-lock-inspection",
            executionId: "execution-held-lock-inspection",
            runId: "held-lock-inspection",
          },
        },
      });
    } finally {
      lockDatabase.exec("ROLLBACK");
      lockDatabase.close();
    }
  });

  it("returns typed corrupt, unknown, and unsupported projections", async () => {
    const corruptDatabase = createStore();
    prepareContext(facts("run-corrupt"), {
      ...corruptDatabase.options,
      runtimeInstanceId: "runtime-1",
    });
    corruptDatabase
      .open()
      .db.prepare("UPDATE execution_identity_contexts SET context_json = ? WHERE run_id = ?")
      .run("{", "run-corrupt");
    expect(await corruptDatabase.inspect({ runId: "run-corrupt" })).toMatchObject({
      run: { status: "known" },
      identity: { state: "unknown", reasonCode: "identity_context_corrupt" },
      coverage: { state: "unknown" },
    });

    const unknownDatabase = createStore();
    expect(await unknownDatabase.inspect({ runId: "never-seen" })).toMatchObject({
      run: { status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        remediation: [expect.objectContaining({ code: "verify_run_id" })],
      },
    });

    recordAuditEventInDatabase(
      {
        sourceId: "legacy-run:1",
        sourceSequence: 1,
        occurredAt: Date.now(),
        kind: "agent_run",
        action: "agent.run.started",
        status: "started",
        actorType: "agent",
        actorId: "main",
        agentId: "main",
        runId: "legacy-run",
      },
      { ...unknownDatabase.options, database: unknownDatabase.open() },
    );
    expect(await unknownDatabase.inspect({ runId: "legacy-run" })).toMatchObject({
      run: { status: "known" },
      identity: {
        state: "unsupported",
        reasonCode: "identity_context_unavailable",
        remediation: [expect.objectContaining({ code: "record_new_identity_context" })],
      },
    });
  });
});
