import assert from "node:assert/strict";
import { on } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { MessageChannel } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { OpenClawAgentDatabaseWriteAdmission } from "../../state/openclaw-agent-db.js";
import { runReclamationWorkerPort } from "./session-accessor.sqlite-mutation-worker.runtime.js";
import type {
  SqliteReclamationWorkerCloseRequest,
  SqliteReclamationWorkerRequest,
} from "./session-accessor.sqlite-reclamation-worker.types.js";

const gc = vi.hoisted(() => ({
  pending: undefined as (() => void) | undefined,
  collect: vi.fn(),
  result: undefined as WeakRef<object> | undefined,
}));

const workerClose = vi.hoisted(() => ({
  results: [] as Array<{ errors: Error[]; settled: boolean }>,
}));

vi.mock("../../infra/worker-idle-gc.js", () => ({
  scheduleWorkerIdleGc: () => {
    gc.pending = gc.collect;
  },
  cancelWorkerIdleGc: () => {
    gc.pending = undefined;
  },
}));
vi.mock("../../infra/kysely-sync-cache-state.js", () => ({
  clearNodeSqliteKyselyCacheForDatabase: () => {},
}));
vi.mock("../../state/openclaw-agent-canonical-validation-receipt.js", () => ({}));
vi.mock("../../state/openclaw-agent-db-readonly-open.js", () => ({}));
vi.mock("../../state/openclaw-state-db-cache.js", () => ({
  closeOpenClawStateDatabaseByPath: () => {},
}));
vi.mock("../../state/openclaw-agent-db-identity.js", () => ({
  readOpenClawAgentDatabaseIdentity: () => ({
    identity: "1:2",
    birthtime: "1",
    incarnation: "fixture-incarnation",
    filename: "/fixture/agent.sqlite",
  }),
  createOpenClawAgentDatabaseClaim: () => ({ assertCurrent() {}, release() {} }),
}));
vi.mock("../../state/openclaw-agent-db-lease.js", () => ({
  assertOpenClawAgentDatabaseLease: () => {},
}));
vi.mock("../../state/openclaw-agent-db-lifecycle.js", () => ({
  readOpenClawAgentDatabaseWorkerLeaseReceipt: () => ({ leaseId: "fixture-lease" }),
}));
vi.mock("../../state/openclaw-agent-db-validation-cache.js", () => ({
  getOpenClawAgentDatabaseValidation: () => undefined,
}));
vi.mock("../../state/openclaw-agent-db.js", () => {
  const database = { db: { isOpen: true, isTransaction: false } };
  return {
    borrowOpenClawAgentDatabase: () => ({ release() {} }),
    settleOpenClawAgentDatabaseWorkerClose: () =>
      workerClose.results.shift() ?? { errors: [], settled: true },
    withOpenClawAgentDatabaseAdmission: <T>(
      _options: unknown,
      withAdmission: OpenClawAgentDatabaseWriteAdmission,
      run: (opened: typeof database) => T | Promise<T>,
    ) =>
      withAdmission((assertCurrent) => {
        assertCurrent();
        return run(database);
      }),
  };
});
// mock-isolation: Exercise worker settlement without opening a reclamation database.
vi.mock("./session-accessor.sqlite-reclamation.js", () => ({
  reclaimSqliteSessionInTransaction: () => {
    const result = {
      kind: "maintenance-finalize",
      value: { archivedTranscripts: [], committedEntryIndices: [] },
    };
    gc.result = new WeakRef(result);
    return result;
  },
}));

it("releases replies and preserves idle collection across buffered admissions", async () => {
  const { port1: parentPort, port2: worker } = new MessageChannel();
  const replies = on(parentPort, "message");
  const databaseOptions = { agentId: "fixture", path: "/fixture/agent.sqlite", env: {} };
  const coordination = {
    actorId: "fixture",
    databasePath: "/fixture/state.sqlite",
    stateContext: {
      environment: { OPENCLAW_STATE_DIR: "/fixture" },
    },
  };
  const running = runReclamationWorkerPort(worker, databaseOptions);
  let operationId = 0;
  let pendingAdmission: Record<string, unknown> | undefined;
  const receive = async (type: string) => {
    const [reply]: unknown[] = (await replies.next()).value ?? [];
    assert.ok(isRecord(reply));
    expect(reply.type).toBe(type);
    if (type === "admission-request") {
      pendingAdmission = reply;
    }
    return reply;
  };
  const request = () =>
    parentPort.postMessage(
      {
        type: "reclaim",
        operationId: ++operationId,
        plan: {
          kind: "maintenance-finalize",
          agentId: databaseOptions.agentId,
          databaseOptions,
          entries: [],
          materializedPlans: [],
        },
        coordination,
      } satisfies SqliteReclamationWorkerRequest,
      [],
    );
  const admit = (reply: Record<string, unknown>) => {
    pendingAdmission = undefined;
    parentPort.postMessage(
      {
        type: "admission",
        operationId: reply.operationId,
        allowed: true,
      },
      [],
    );
  };
  try {
    request();
    admit(await receive("admission-request"));
    await receive("lease");
    expect(await receive("reclaimed")).toMatchObject({ operationId: 1, settled: true });
    // Delivery of the result follows the worker's draining of its buffered admission reply.
    expect(gc.pending).toBeTypeOf("function");

    request();
    const admission = await receive("admission-request");
    expect(gc.pending).toBeUndefined();
    expect(gc.collect).not.toHaveBeenCalled();
    admit(admission);
    expect(await receive("reclaimed")).toMatchObject({ operationId: 2, settled: true });
    gc.pending?.();
    expect(gc.collect).toHaveBeenCalledOnce();
    const control = new WeakRef({});
    for (let pass = 0; pass < 4; pass++) {
      await nextTurn();
      queryObjects(WeakRef);
    }
    await nextTurn();
    expect(control.deref()).toBeUndefined();
    expect(gc.result?.deref()).toBeUndefined();
  } finally {
    if (pendingAdmission) {
      admit(pendingAdmission);
    }
    parentPort.postMessage(
      {
        type: "close",
        operationId: ++operationId,
        coordination,
      } satisfies SqliteReclamationWorkerCloseRequest,
      [],
    );
    try {
      await running;
    } finally {
      await replies.return?.();
      parentPort.close();
      worker.close();
      gc.pending = undefined;
      gc.collect.mockClear();
    }
  }
});

it("retries a pooled close that lost its race instead of rejecting the task", async () => {
  const { port1: parentPort, port2: worker } = new MessageChannel();
  const databaseOptions = { agentId: "fixture", path: "/fixture/agent.sqlite", env: {} };
  const coordination = {
    actorId: "fixture",
    databasePath: "/fixture/state.sqlite",
    stateContext: {
      environment: { OPENCLAW_STATE_DIR: "/fixture" },
    },
  };
  // The first close loses its race; the retry converges the same handle.
  workerClose.results = [
    { errors: [new Error("database is locked")], settled: false },
    { errors: [], settled: true },
  ];
  const running = runReclamationWorkerPort(worker, databaseOptions, { operationId: 0 });
  parentPort.postMessage(
    {
      type: "close",
      operationId: 1,
      coordination,
    } satisfies SqliteReclamationWorkerCloseRequest,
    [],
  );
  try {
    await expect(running).resolves.toMatchObject({ settled: true, cleanupWarnings: [] });
  } finally {
    parentPort.close();
    worker.close();
    workerClose.results = [];
  }
});

it("keeps a damaged pooled close terminal instead of retrying it", async () => {
  const { port1: parentPort, port2: worker } = new MessageChannel();
  const databaseOptions = { agentId: "fixture", path: "/fixture/agent.sqlite", env: {} };
  const coordination = {
    actorId: "fixture",
    databasePath: "/fixture/state.sqlite",
    stateContext: {
      environment: { OPENCLAW_STATE_DIR: "/fixture" },
    },
  };
  workerClose.results = [{ errors: [new Error("file is not a database")], settled: false }];
  const running = runReclamationWorkerPort(worker, databaseOptions, { operationId: 0 });
  parentPort.postMessage(
    {
      type: "close",
      operationId: 1,
      coordination,
    } satisfies SqliteReclamationWorkerCloseRequest,
    [],
  );
  try {
    await expect(running).rejects.toThrow(/could not close its agent database/);
  } finally {
    parentPort.close();
    worker.close();
    workerClose.results = [];
  }
});
