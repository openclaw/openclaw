import assert from "node:assert/strict";
import { on } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { OpenClawAgentDatabaseWriteAdmission } from "../../state/openclaw-agent-db.js";
import type { ReclamationDatabaseOptions } from "./session-accessor.sqlite-lifecycle-types.js";
import { runReclamationWorkerPort } from "./session-accessor.sqlite-mutation-worker.runtime.js";
import type {
  SqliteReclamationWorkerCloseRequest,
  SqliteReclamationWorkerRequest,
} from "./session-accessor.sqlite-reclamation-worker.js";

const gc = vi.hoisted(() => ({
  pending: undefined as (() => void) | undefined,
  collect: vi.fn(),
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
vi.mock("../../state/openclaw-state-db-cache.js", () => ({}));
vi.mock("../../state/openclaw-agent-db-identity.js", () => ({
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
    settleOpenClawAgentDatabaseWorkerClose: () => ({ errors: [], settled: true }),
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
vi.mock("./session-accessor.sqlite-worker-coordination.js", () => ({
  runWithSqliteMutationWorkerCoordination: <T>(
    _coordination: unknown,
    _operationId: number,
    options: ReclamationDatabaseOptions,
    run: (options: ReclamationDatabaseOptions) => Promise<T>,
  ) => run(options),
}));
vi.mock("./session-accessor.sqlite-reclamation.js", () => ({
  reclaimSqliteSessionInTransaction: () => ({ kind: "maintenance-statistics", value: true }),
}));
vi.mock("./session-accessor.sqlite-reclamation-commit.js", () => ({
  markSqliteReclamationSettled: () => {},
}));

it("keeps idle collection after buffered admission replies and cancels it for the next request", async () => {
  const { port1: parentPort, port2: worker } = new MessageChannel();
  const replies = on(parentPort, "message");
  const databaseOptions = { agentId: "fixture", path: "/fixture/agent.sqlite", env: {} };
  const coordination = {
    actorId: "fixture",
    databasePath: "/fixture/state.sqlite",
    stateContext: {
      environment: { OPENCLAW_STATE_DIR: "/fixture" },
      coordinatorRuntime: { directory: "/fixture/runtime", keepAlive: false },
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
        commitGate: new SharedArrayBuffer(4),
        plan: { kind: "maintenance-statistics", databaseOptions, materializedPlans: [] },
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
        admissionId: reply.admissionId,
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
