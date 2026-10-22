import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let store: ReturnType<typeof createStore>;
beforeEach(() => {
  store = createStore();
});
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
  it("replays one byte-identical canonical context idempotently across restart", async () => {
    const envelope = captureEnvelope(facts("run-1"), identity("1", 100, "runtime-secret-1"));
    const first = persistEnvelope(envelope, { ...store.options, now: 100 });

    await restartDatabase();
    const second = persistEnvelope(structuredClone(envelope), { ...store.options, now: 999 });

    expect(second).toEqual(first);
    expect(first.coverageState).toBe("unattributed");
    expect(first.invoker).toEqual({ state: "absent" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.runtimeInstance)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("runtime-secret-1");

    await restartDatabase();
    const afterRestart = await store.inspect({ executionId: "execution-1" }, 999);
    expect(afterRestart.identity).toEqual({ state: "present", context: first });
  });

  it.each([
    ["unknown", "unknown", 100],
    ["absent", "unattributed", 101],
  ] as const)("preserves %s invoker evidence across restart", async (state, coverageState, now) => {
    const context = store.prepare(
      `run-${state}`,
      identity(state, now, `runtime-${state}`),
      state === "unknown" ? { invoker: { state } } : {},
    );
    const missingEvidence = ["invoker.principal"];
    expect(context).toMatchObject({ invoker: { state }, coverageState, missingEvidence });
    if (state === "unknown") {
      expect(context.invoker).not.toHaveProperty("principal");
    }
    await restartDatabase();
    const result = await store.inspect({ executionId: `execution-${state}` }, 101);
    expect(result.identity).toEqual({ state: "present", context });
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

  it("records attribution only when an invoker fact is actually present", () => {
    const context = store.prepare(
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
          sourceId: "legacy-run:1",
          sourceSequence: 1,
          occurredAt: Date.now(),
          kind: "agent_run",
          action: "agent.run.started",
          status: "started",
          actorType: "agent",
          actorId: "main",
          agentId: "main",
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
