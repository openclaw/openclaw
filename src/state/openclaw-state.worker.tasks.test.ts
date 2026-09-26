import { beforeEach, expect, it, vi } from "vitest";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import { buildFlowRecord } from "../tasks/task-flow-registry.records.js";
import { openExistingSqliteWorkerBackend } from "./openclaw-state.worker.js";

const mocks = vi.hoisted(() => {
  const database = { db: { isOpen: true }, path: "/synthetic/task-policy.sqlite" };
  return {
    database,
    open: vi.fn(() => database),
    write: vi.fn((operation: (store: typeof database) => unknown) => operation(database)),
    coordinator: vi.fn((_options: unknown, operation: () => unknown) => operation()),
    existingRead: vi.fn(),
    preservingRead: vi.fn((operation: () => unknown) => operation()),
    readFlow: vi.fn(),
    updateFlow: vi.fn(),
    insertFlow: vi.fn(),
    runTask: vi.fn(),
    release: vi.fn(),
  };
});

vi.mock("./openclaw-state-db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db.js")>()),
  openOpenClawStateDatabase: mocks.open,
  runOpenClawStateWriteTransaction: mocks.write,
}));
vi.mock("./openclaw-state-db-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db-cache.js")>()),
  openClawStateDatabaseCache: {
    getCachedOpenClawStateDatabase: () => mocks.database,
  },
  retainOpenClawStateDatabase: () => ({ release: mocks.release }),
}));
vi.mock("../infra/sqlite-worker-state-context.js", () => ({
  getSqliteWorkerStateContext: () => ({ environment: {} }),
}));
vi.mock("./openclaw-state-db-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db-readonly.js")>()),
  withExistingOpenClawStateDatabaseReadOnly: mocks.existingRead,
  withArtifactPreservingStateReads: mocks.preservingRead,
}));
vi.mock("./openclaw-state-db-write-coordination.js", () => ({
  withSharedStateWriteCoordinator: mocks.coordinator,
}));
vi.mock("../infra/sqlite-post-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-post-commit.js")>()),
  deferSqlitePostCommitPublication: (_db: unknown, publish: () => void) => publish(),
}));
vi.mock("../tasks/task-flow-registry.store.kernel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tasks/task-flow-registry.store.kernel.js")>()),
  readTaskFlowRecord: mocks.readFlow,
  updateSelectedTaskFlowRecordInDatabase: mocks.updateFlow,
  upsertTaskFlowRowInDatabase: mocks.insertFlow,
}));
vi.mock("../tasks/task-flow-managed-run-task.kernel.js", () => ({
  runManagedTaskInFlowInDatabase: mocks.runTask,
}));

const flow = buildFlowRecord({
  ownerKey: "agent:main:policy",
  controllerId: "tests/policy",
  goal: "Synthetic task policy",
  createdAt: 100,
});
const updateInput = {
  flowId: flow.flowId,
  ownerKey: flow.ownerKey,
  expectedRevision: 0,
  patch: { status: "succeeded" as const, updatedAt: 200, endedAt: 200 },
};

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.open.mockImplementation(() => mocks.database);
  mocks.write.mockImplementation((operation) => operation(mocks.database));
  mocks.coordinator.mockImplementation((_options, operation) => operation());
  mocks.existingRead.mockReturnValue(undefined);
  mocks.readFlow.mockReturnValue(flow);
  mocks.updateFlow.mockReturnValue({ applied: true, flow });
  const prepared = backend();
  await prepared[SQLITE_WORKER_PREPARE_COMMAND]?.("tasks.statusSummary");
  await prepared.close();
});

function backend() {
  return openExistingSqliteWorkerBackend(undefined, { databasePath: mocks.database.path });
}

it.each([false, true])(
  "keeps status reads noncreating with artifact preservation %s",
  (preserveSourceArtifacts) => {
    expect(
      backend().execute({
        type: "tasks.statusSummary",
        input: { now: 100, preserveSourceArtifacts },
      }),
    ).toBeUndefined();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.existingRead).toHaveBeenCalledOnce();
    expect(mocks.preservingRead).toHaveBeenCalledTimes(preserveSourceArtifacts ? 1 : 0);
  },
);

it("keeps a managed update's open failure nullable and a create failure strict", () => {
  const error = new Error("Synthetic open refusal");
  mocks.open.mockImplementation(() => {
    throw error;
  });
  expect(backend().execute({ type: "flows.updateManaged", input: updateInput })).toEqual({
    applied: false,
    reason: "persist_failed",
  });
  expect(() => backend().execute({ type: "flows.createManaged", input: { flow } })).toThrow(error);
  expect(mocks.write).not.toHaveBeenCalled();
});

it.each(["create", "update"] as const)(
  "retains the committed %s outcome after modeled cleanup rejection",
  (operation) => {
    mocks.write.mockImplementation((write) => {
      write(mocks.database);
      throw new Error("Modeled cleanup rejection; no native handle is used");
    });
    const result =
      operation === "create"
        ? backend().execute({ type: "flows.createManaged", input: { flow } })
        : backend().execute({ type: "flows.updateManaged", input: updateInput });
    expect(result).toEqual(operation === "create" ? flow : { applied: true, flow });
  },
);

it("retains a completed run-task result after modeled coordinator cleanup rejection", () => {
  const result = { found: false, created: false, reason: "Flow not found." };
  mocks.runTask.mockImplementation((_db, _input, _write, committed) => {
    committed(result);
    return result;
  });
  mocks.coordinator.mockImplementation((_options, operation) => {
    operation();
    throw new Error("Modeled cleanup rejection; no native coordinator is used");
  });
  expect(
    backend().execute({
      type: "flows.runTask",
      input: {
        callerOwnerKey: flow.ownerKey,
        taskId: "synthetic-task",
        now: 100,
        params: { flowId: flow.flowId, runtime: "subagent", task: "Synthetic task" },
      },
    }),
  ).toEqual(result);
});
