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
  inspectExecutionIdentityRun,
  processExecutionIdentityAdmissionWorkInDatabase,
  pruneExpiredExecutionIdentityContextsInDatabase,
} from "./execution-identity-context.js";
import {
  captureExecutionIdentityAdmissionEnvelope,
  persistExecutionIdentityAdmissionEnvelope,
  prepareExecutionIdentityContextAtAdmission,
  recordDeniedApprovalForRun,
} from "./execution-identity.test-support.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-identity-") } };
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

describe("execution identity context storage", () => {
  it("replays one byte-identical canonical context idempotently across restart", async () => {
    const database = databaseOptions();
    const envelope = captureExecutionIdentityAdmissionEnvelope(facts("run-1"), {
      now: 100,
      contextId: "context-1",
      executionId: "execution-1",
      runtimeInstanceId: "runtime-secret-1",
    });
    const first = persistExecutionIdentityAdmissionEnvelope(envelope, { ...database, now: 100 });

    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const second = persistExecutionIdentityAdmissionEnvelope(structuredClone(envelope), {
      ...database,
      now: 999,
    });

    expect(second).toEqual(first);
    expect(first.coverageState).toBe("unattributed");
    expect(first.invoker).toEqual({ state: "absent" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.runtimeInstance)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("runtime-secret-1");

    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const afterRestart = await inspectExecutionIdentityRun(
      { executionId: "execution-1" },
      {
        ...database,
        now: 999,
      },
    );
    expect(afterRestart.identity).toEqual({ state: "present", context: first });
  });

  it("keeps explicit unknown invoker evidence distinct from omission across restart", async () => {
    const database = databaseOptions();
    const unknown = prepareExecutionIdentityContextAtAdmission(
      facts("run-unknown", { invoker: { state: "unknown" } }),
      {
        ...database,
        now: 100,
        contextId: "context-unknown",
        executionId: "execution-unknown",
        runtimeInstanceId: "runtime-unknown",
      },
    );
    const absent = prepareExecutionIdentityContextAtAdmission(facts("run-absent"), {
      ...database,
      now: 101,
      contextId: "context-absent",
      executionId: "execution-absent",
      runtimeInstanceId: "runtime-absent",
    });

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

    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const unknownAfterRestart = await inspectExecutionIdentityRun(
      { executionId: "execution-unknown" },
      { ...database, now: 101 },
    );
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
    expect(
      (
        await inspectExecutionIdentityRun(
          { executionId: "execution-absent" },
          { ...database, now: 101 },
        )
      ).identity,
    ).toEqual({ state: "present", context: absent });
  });

  it("keeps distinct turns sharing one run correlation exactly inspectable", async () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("session-run"), {
      ...database,
      now: 100,
      contextId: "context-first",
      executionId: "execution-first",
      runtimeInstanceId: "runtime-1",
    });
    prepareExecutionIdentityContextAtAdmission(facts("session-run"), {
      ...database,
      now: 101,
      contextId: "context-second",
      executionId: "execution-second",
      runtimeInstanceId: "runtime-1",
    });
    await recordDeniedApprovalForRun("session-run", database, "shared-run-approval", {
      contextId: "context-first",
      executionId: "execution-first",
    });

    const discovery = await inspectExecutionIdentityRun(
      { runId: "session-run" },
      { ...database, now: 300 },
    );
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
        await inspectExecutionIdentityRun(
          { runId: "session-run", executionOffset, executionLimit: 1 },
          { ...database, now: 300 },
        ),
      ).toMatchObject({
        identity: { state: "ambiguous", candidates: [{ executionId }] },
        ...(nextExecutionCursor ? { nextExecutionCursor } : {}),
      });
    }
    const firstInspection = await inspectExecutionIdentityRun(
      { executionId: "execution-first" },
      { ...database, now: 300 },
    );
    const secondInspection = await inspectExecutionIdentityRun(
      { executionId: "execution-second" },
      { ...database, now: 300 },
    );
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
    prepareExecutionIdentityContextAtAdmission(facts("session-run"), {
      ...database,
      now: 102,
      contextId: "context-third",
      executionId: "execution-third",
      runtimeInstanceId: "runtime-1",
    });
    const nextPage = await inspectExecutionIdentityRun(
      { runId: "session-run", executionOffset: 2, executionLimit: 1 },
      { ...database, now: 300 },
    );
    expect(nextPage.identity).toMatchObject({
      state: "ambiguous",
      candidates: [{ executionId: "execution-third", contextId: "context-third", createdAt: 102 }],
    });
    expect(nextPage).not.toHaveProperty("nextExecutionCursor");
  });

  it("confirms durable retries without manufacturing lost evidence", async () => {
    const database = databaseOptions();
    const envelope = captureExecutionIdentityAdmissionEnvelope(facts("run-recovery"), {
      now: 100,
      contextId: "context-recovery",
      executionId: "execution-recovery",
      runtimeInstanceId: "runtime-original",
    });
    const original = processExecutionIdentityAdmissionWorkInDatabase(
      { kind: "capture", envelope },
      { ...database, database: openOpenClawStateDatabase(database), now: 100 },
    );
    const token = createExecutionIdentityAdmissionToken("run-recovery", {
      now: 100,
      contextId: "context-recovery",
      executionId: "execution-recovery",
    });

    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    expect(
      processExecutionIdentityAdmissionWorkInDatabase(
        { kind: "retry-reference", token },
        { ...database, database: openOpenClawStateDatabase(database) },
      ),
    ).toEqual(original);

    const missingDatabase = databaseOptions();
    expect(() =>
      processExecutionIdentityAdmissionWorkInDatabase(
        { kind: "retry-reference", token },
        { ...missingDatabase, database: openOpenClawStateDatabase(missingDatabase) },
      ),
    ).toThrow("execution identity recovery evidence unavailable");
    expect(
      await inspectExecutionIdentityRun({ executionId: "execution-recovery" }, missingDatabase),
    ).toMatchObject({
      run: { executionId: "execution-recovery", status: "unknown" },
      identity: { state: "unknown", reasonCode: "execution_not_found" },
      decisions: [],
    });
  });

  it("projects authoritative local CLI and system ingress without conflating them", async () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-local"), database);
    prepareExecutionIdentityContextAtAdmission(
      facts("run-system", {
        ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
      }),
      database,
    );

    expect(
      (await inspectExecutionIdentityRun({ runId: "run-local" }, database)).identity,
    ).toMatchObject({
      state: "present",
      context: {
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
      },
    });
    expect(
      (await inspectExecutionIdentityRun({ runId: "run-system" }, database)).identity,
    ).toMatchObject({
      state: "present",
      context: {
        ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
      },
    });
  });

  it("keeps maintenance read-only until the first identity capture", () => {
    const database = databaseOptions();
    const opened = openOpenClawStateDatabase(database);
    expect(
      opened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();

    expect(
      pruneExpiredExecutionIdentityContextsInDatabase({
        database: { ...database, database: openOpenClawStateDatabase(database) },
      }),
    ).toBe(0);
    expect(
      opened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();
  });

  it("records attribution only when an invoker fact is actually present", () => {
    const database = databaseOptions();
    const context = prepareExecutionIdentityContextAtAdmission(
      facts("run-attributed", {
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
      }),
      { ...database, runtimeInstanceId: "private-runtime" },
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
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-before-disable"), {
      ...database,
      now: 0,
      runtimeInstanceId: "runtime-1",
    });
    expect(
      enqueueExecutionIdentityContextAtAdmission(facts("run-disabled"), { enabled: false }),
    ).toBeUndefined();

    expect(
      pruneExpiredExecutionIdentityContextsInDatabase({
        database: { ...database, database: openOpenClawStateDatabase(database) },
        now: RETENTION_MS + 1,
      }),
    ).toBe(1);
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rolls back the worker write when insert-time retention cleanup fails", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-expired"), {
      ...database,
      now: 0,
      runtimeInstanceId: "runtime-1",
    });
    openOpenClawStateDatabase(database).db.exec(`
      CREATE TRIGGER reject_identity_cleanup
      BEFORE DELETE ON execution_identity_contexts
      BEGIN
        SELECT RAISE(ABORT, 'cleanup unavailable');
      END;
    `);

    expect(() =>
      prepareExecutionIdentityContextAtAdmission(facts("run-still-admitted"), {
        ...database,
        now: RETENTION_MS + 1,
        runtimeInstanceId: "runtime-1",
      }),
    ).toThrow("cleanup unavailable");
  });

  it("enforces the row cap across independent database connections", () => {
    const database = databaseOptions();
    const path = openOpenClawStateDatabase(database).path;
    closeOpenClawStateDatabaseForTest();
    const first = openIndependentStateDatabase(path);
    const second = openIndependentStateDatabase(path);
    try {
      for (const [index, connection] of [first, second, first, second].entries()) {
        const runId = `shared-cap-${index + 1}`;
        prepareExecutionIdentityContextAtAdmission(facts(runId), {
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

  it("inspects through a read-only connection while another writer holds the database", async () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("held-lock-inspection"), {
      ...database,
      now: 100,
      contextId: "context-held-lock-inspection",
      executionId: "execution-held-lock-inspection",
      runtimeInstanceId: "runtime-1",
    });
    const path = openOpenClawStateDatabase(database).path;
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const lockDatabase = openNodeSqliteDatabase(path);
    lockDatabase.exec("BEGIN IMMEDIATE");
    try {
      expect(
        await inspectExecutionIdentityRun(
          { executionId: "execution-held-lock-inspection" },
          { ...database, now: 100 },
        ),
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
    const corruptDatabase = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-corrupt"), {
      ...corruptDatabase,
      runtimeInstanceId: "runtime-1",
    });
    openOpenClawStateDatabase(corruptDatabase)
      .db.prepare("UPDATE execution_identity_contexts SET context_json = ? WHERE run_id = ?")
      .run("{", "run-corrupt");
    expect(
      await inspectExecutionIdentityRun({ runId: "run-corrupt" }, corruptDatabase),
    ).toMatchObject({
      run: { status: "known" },
      identity: { state: "unknown", reasonCode: "identity_context_corrupt" },
      coverage: { state: "unknown" },
    });

    const unknownDatabase = databaseOptions();
    expect(
      await inspectExecutionIdentityRun({ runId: "never-seen" }, unknownDatabase),
    ).toMatchObject({
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
      { ...unknownDatabase, database: openOpenClawStateDatabase(unknownDatabase) },
    );
    expect(
      await inspectExecutionIdentityRun({ runId: "legacy-run" }, unknownDatabase),
    ).toMatchObject({
      run: { status: "known" },
      identity: {
        state: "unsupported",
        reasonCode: "identity_context_unavailable",
        remediation: [expect.objectContaining({ code: "record_new_identity_context" })],
      },
    });
  });
});
