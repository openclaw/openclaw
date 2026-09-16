import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { createSqliteWorkerBackend } from "./openclaw-state.worker.js";

const controls = vi.hoisted(() => ({
  open: vi.fn<typeof import("./openclaw-state-db.js").openOpenClawStateDatabase>(),
  cached: vi.fn<() => OpenClawStateDatabase>(),
  release: vi.fn(),
  readTask: vi.fn<typeof import("../tasks/task-registry.store.kernel.js").readTaskRecord>(),
  syncFlow:
    vi.fn<
      typeof import("../tasks/task-flow-registry.store.kernel.js").syncTaskMirroredFlowRecordInDatabase
    >(),
}));

vi.mock("./openclaw-state-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-db.js")>();
  const { runSqliteImmediateTransactionSync } = await import("../infra/sqlite-transaction.js");
  const { withSqlitePostCommitPublications } = await import("../infra/sqlite-post-commit.js");
  return {
    ...actual,
    openOpenClawStateDatabase: controls.open,
    runOpenClawStateWriteTransaction<T>(
      operation: (database: OpenClawStateDatabase) => T,
      options: { database: OpenClawStateDatabase },
    ): T {
      const database = options.database;
      return withSqlitePostCommitPublications(database.db, () =>
        runSqliteImmediateTransactionSync(database.db, () => operation(database)),
      );
    },
  };
});
vi.mock("./openclaw-state-db-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db-cache.js")>()),
  openClawStateDatabaseCache: { getCachedOpenClawStateDatabase: controls.cached },
  retainOpenClawStateDatabase: () => ({ release: controls.release }),
}));
vi.mock("../tasks/task-registry.store.kernel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tasks/task-registry.store.kernel.js")>()),
  readTaskRecord: controls.readTask,
}));
vi.mock("../tasks/task-flow-registry.store.kernel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tasks/task-flow-registry.store.kernel.js")>()),
  syncTaskMirroredFlowRecordInDatabase: controls.syncFlow,
}));
vi.mock("../infra/sqlite-worker-operation-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-worker-operation-admission.js")>()),
  requestSqliteWorkerOperationAdmission: () => {},
}));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: vi.fn(),
    }),
  };
});

const task: TaskRecord = {
  taskId: "settlement-task",
  runtime: "cli",
  status: "succeeded",
  ownerKey: "agent:main:settlement",
  requesterSessionKey: "agent:main:settlement",
  scopeKind: "session",
  parentFlowId: "settlement-flow",
  task: "Synthetic settlement task",
  deliveryStatus: "not_applicable",
  notifyPolicy: "silent",
  createdAt: 10,
};
const flow: TaskFlowRecord = {
  flowId: "settlement-flow",
  syncMode: "task_mirrored",
  ownerKey: "agent:main:settlement",
  goal: "Synthetic settlement flow",
  status: "running",
  notifyPolicy: "silent",
  revision: 1,
  createdAt: 10,
  updatedAt: 10,
};
const context = {
  environment: { OPENCLAW_STATE_DIR: "/synthetic/state" },
  coordinatorRuntime: { directory: "/synthetic/locks", keepAlive: false },
};
const backends = new Set<ReturnType<typeof createSqliteWorkerBackend>>();

beforeEach(() => {
  controls.open.mockReset();
  controls.cached.mockReset();
  controls.release.mockReset();
  controls.readTask.mockReset().mockReturnValue(task);
  controls.syncFlow.mockReset();
});
afterEach(async () => {
  for (const backend of backends) {
    await backend.close();
  }
  backends.clear();
  vi.restoreAllMocks();
});

function fixture(rollback: "settled" | "poisoned" | "unsettled" = "settled", beginFailure?: Error) {
  const native = {
    isOpen: true,
    isTransaction: false,
    location: () => null,
    exec(sql: string) {
      if (sql === "BEGIN IMMEDIATE") {
        if (beginFailure) {
          throw beginFailure;
        }
        this.isTransaction = true;
      } else if (sql === "COMMIT") {
        this.isTransaction = false;
      } else if (sql === "ROLLBACK") {
        if (rollback === "poisoned") {
          throw new Error("synthetic rollback failure");
        }
        if (rollback === "settled") {
          this.isTransaction = false;
        }
      } else {
        throw new Error(`Unexpected synthetic database operation: ${sql}`);
      }
    },
    close() {
      this.isOpen = false;
      this.isTransaction = false;
    },
  };
  const database: OpenClawStateDatabase = {
    // SAFETY: Only this physical boundary is synthetic. The real transaction and
    // settlement owners consume the implemented methods; no native handle opens.
    db: native as unknown as DatabaseSync,
    path: "/synthetic/state/openclaw.db",
    walMaintenance: { checkpoint: () => false, close: () => true },
  };
  controls.open.mockReturnValue(database);
  controls.cached.mockReturnValue(database);
  const backend = runWithSqliteWorkerStateContext(context, () =>
    createSqliteWorkerBackend(undefined, { databasePath: database.path }),
  );
  backends.add(backend);
  const assertSettled = expectDefined(
    backend.assertSettled?.bind(backend),
    "backend settlement check",
  );
  const execute = () =>
    runWithSqliteWorkerStateContext(context, () =>
      backend.execute({
        type: "flows.syncLiveMirroredTask",
        input: { taskId: task.taskId, flowId: flow.flowId },
      }),
    );
  return { native, execute, assertSettled };
}

it.each(["settled", "poisoned", "unsettled"] as const)(
  "checks %s native settlement after live sync catches its persistence error",
  (rollback) => {
    const { native, execute, assertSettled } = fixture(rollback);
    const persistenceFailure = new Error("synthetic persistence failure after admission");
    controls.syncFlow.mockImplementation((_db, _task, admit) => {
      expectDefined(admit, "live selection admission")(flow);
      throw persistenceFailure;
    });

    expect(execute()).toEqual({
      kind: "result",
      result: { ok: false, reason: "persist_failed", current: flow },
    });
    if (rollback === "settled") {
      expect(native.isTransaction).toBe(false);
      expect(assertSettled).not.toThrow();
    } else if (rollback === "poisoned") {
      // The real transaction owner poisoned and closed the synthetic handle.
      // Closure alone must not make the caught failure safe to acknowledge.
      expect(native.isOpen).toBe(false);
      expect(assertSettled).toThrow(persistenceFailure);
    } else {
      expect(native.isOpen && native.isTransaction).toBe(true);
      expect(assertSettled).toThrow("retained an unsettled transaction");
    }
  },
);

it("preserves an uncommitted aggregate after admission even when rollback settles", () => {
  const { native, execute, assertSettled } = fixture();
  const failure = new AggregateError(
    [new Error("synthetic persistence failure"), new Error("synthetic cleanup failure")],
    "Synthetic write and cleanup both failed",
  );
  controls.syncFlow.mockImplementation((_db, _task, admit) => {
    expectDefined(admit, "live selection admission")(flow);
    throw failure;
  });
  expect(execute).toThrow(failure);
  expect(native.isOpen).toBe(true);
  expect(native.isTransaction).toBe(false);
  expect(assertSettled).not.toThrow();
});

it("allows an ordinary live sync result only after its transaction has settled", () => {
  const { native, execute, assertSettled } = fixture();
  controls.syncFlow.mockImplementation((_db, _task, admit) => {
    expectDefined(admit, "live selection admission")(flow);
    return { changed: false, flow };
  });
  expect(execute()).toEqual({ kind: "result", result: { ok: true, flow } });
  expect(native.isOpen).toBe(true);
  expect(native.isTransaction).toBe(false);
  expect(assertSettled).not.toThrow();
});

it.each(["missing task", "changed flow link"] as const)(
  "settles the early %s outcome without requesting live write authority",
  (boundary) => {
    const { native, execute, assertSettled } = fixture();
    controls.readTask.mockReturnValue(
      boundary === "missing task" ? undefined : { ...task, parentFlowId: "other-flow" },
    );
    expect(execute()).toEqual({ kind: "not-selected" });
    expect(controls.syncFlow).not.toHaveBeenCalled();
    expect(native.isTransaction).toBe(false);
    expect(assertSettled).not.toThrow();
  },
);

it.each([{ code: "SQLITE_BUSY" }, { code: "ERR_SQLITE_ERROR", errcode: 261 }])(
  "keeps settled BEGIN contention retryable: %j",
  (fields) => {
    const { native, execute, assertSettled } = fixture(
      "settled",
      Object.assign(new Error("Controlled BEGIN contention"), fields),
    );
    expect(execute()).toEqual({ kind: "retry", reason: "storage_contention" });
    expect(controls.readTask).not.toHaveBeenCalled();
    expect(controls.syncFlow).not.toHaveBeenCalled();
    expect(native.isTransaction).toBe(false);
    expect(assertSettled).not.toThrow();
  },
);

it.each([
  new SqliteWorkerError("Controlled retired owner", "closed"),
  new SqliteWorkerError("Controlled unknown outcome", "outcome-unknown"),
  Object.assign(new AggregateError([new Error("Controlled cleanup failure")]), {
    code: "SQLITE_BUSY",
  }),
])("keeps non-retryable BEGIN failure distinct: $message", (failure) => {
  const { execute, assertSettled } = fixture("settled", failure);
  expect(execute).toThrow(failure);
  expect(assertSettled).not.toThrow();
});
