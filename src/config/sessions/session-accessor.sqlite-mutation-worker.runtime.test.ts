import assert from "node:assert/strict";
import { on } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { OpenClawAgentDatabaseWriteAdmission } from "../../state/openclaw-agent-db.js";
import type { ReclamationDatabaseOptions } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  runColdMutationWorkerPort,
  runReclamationWorkerPort,
} from "./session-accessor.sqlite-mutation-worker.runtime.js";
import type {
  SqliteReclamationWorkerCloseRequest,
  SqliteReclamationWorkerRequest,
} from "./session-accessor.sqlite-reclamation-worker.js";

const native = vi.hoisted(() => ({
  closeShared: vi.fn((_pathname: string) => {}),
  reclaim: vi.fn(() => ({ kind: "maintenance-statistics", value: true })),
  coldMutation: vi.fn(() => {
    throw new Error("revoked admission entered cold mutation");
  }),
}));

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
vi.mock("../../state/openclaw-state-db-cache.js", () => ({
  closeOpenClawStateDatabaseByPath: native.closeShared,
}));
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
  reclaimSqliteSessionInTransaction: native.reclaim,
}));
vi.mock("./session-cold-storage-worker.js", () => ({
  mutateSessionColdTranscriptInWorker: native.coldMutation,
  prepareSessionColdRestoreInWorker: () => {
    throw new Error("cold maintenance entered restore preparation");
  },
}));
vi.mock("./session-history-archive-pruning.js", () => ({
  reclaimSqliteFreePages: () => {
    throw new Error("revoked admission entered cold page reclamation");
  },
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

it("preserves request and native cleanup failures without acknowledging settled close", async () => {
  const requestFailure = new Error("reclamation request failed");
  const closeFailure = new Error("shared native close failed");
  native.reclaim.mockImplementationOnce(() => {
    throw requestFailure;
  });
  native.closeShared.mockImplementationOnce(() => {
    throw closeFailure;
  });
  const { port1: parentPort, port2: worker } = new MessageChannel();
  const replies = on(parentPort, "message");
  const sent = vi.spyOn(worker, "postMessage");
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
  const rejected = expect(running).rejects.toMatchObject({
    errors: [requestFailure, closeFailure],
    cause: requestFailure,
  });
  try {
    parentPort.postMessage(
      {
        type: "reclaim",
        operationId: 1,
        commitGate: new SharedArrayBuffer(4),
        plan: { kind: "maintenance-statistics", databaseOptions, materializedPlans: [] },
        coordination,
      } satisfies SqliteReclamationWorkerRequest,
      [],
    );
    const [admission]: unknown[] = (await replies.next()).value ?? [];
    assert.ok(isRecord(admission));
    expect(admission.type).toBe("admission-request");
    parentPort.postMessage(
      {
        type: "admission",
        operationId: admission.operationId,
        admissionId: admission.admissionId,
        allowed: true,
      },
      [],
    );
    await rejected;
    expect(native.closeShared).toHaveBeenCalledWith(coordination.databasePath);
    expect(sent.mock.calls.map(([message]) => message)).not.toContainEqual(
      expect.objectContaining({ type: "closed", settled: true }),
    );
  } finally {
    await replies.return?.();
    parentPort.close();
    worker.close();
    await running.catch(() => undefined);
    sent.mockRestore();
    native.closeShared.mockReset();
    native.reclaim.mockReset().mockReturnValue({ kind: "maintenance-statistics", value: true });
  }
});

it.each([false, true])(
  "closes revoked cold mutation state and preserves cleanup failure=%s",
  async (closeFails) => {
    const closeFailure = new Error("cold shared native close failed");
    native.closeShared.mockClear();
    if (closeFails) {
      native.closeShared.mockImplementationOnce(() => {
        throw closeFailure;
      });
    }
    const { port1: parentPort, port2: worker } = new MessageChannel();
    const replies = on(parentPort, "message");
    const sent = vi.spyOn(worker, "postMessage");
    const databaseOptions = { agentId: "fixture", path: "/fixture/agent.sqlite", env: {} };
    const coordination = {
      actorId: "fixture",
      databasePath: "/fixture/cold-state.sqlite",
      stateContext: {
        environment: { OPENCLAW_STATE_DIR: "/fixture" },
        coordinatorRuntime: { directory: "/fixture/runtime", keepAlive: false },
      },
    };
    const running = runColdMutationWorkerPort(worker, {
      type: "sqlite-transcript-archive-v2",
      operation: "cold-mutate",
      commitGate: new SharedArrayBuffer(4),
      plan: { kind: "cold-maintain", databaseOptions },
    });
    const outcome = running.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    try {
      parentPort.postMessage({ type: "mutate", coordination }, []);
      const [admission]: unknown[] = (await replies.next()).value ?? [];
      assert.ok(isRecord(admission));
      expect(admission.type).toBe("admission-request");
      parentPort.postMessage(
        {
          type: "admission",
          operationId: admission.operationId,
          admissionId: admission.admissionId,
          allowed: false,
        },
        [],
      );
      const { error } = await outcome;
      if (closeFails) {
        assert.ok(error instanceof AggregateError);
        expect(error.errors).toEqual([
          expect.objectContaining({ message: "SQLite reclamation database admission was revoked" }),
          closeFailure,
        ]);
        expect(error.cause).toBe(error.errors[0]);
      } else {
        expect(error).toMatchObject({
          message: "SQLite reclamation database admission was revoked",
        });
      }
      expect(native.closeShared).toHaveBeenCalledExactlyOnceWith(coordination.databasePath);
      expect(native.coldMutation).not.toHaveBeenCalled();
      expect(sent.mock.calls.map(([message]) => message)).not.toContainEqual(
        expect.objectContaining({ type: "reclaimed", settled: true }),
      );
    } finally {
      parentPort.close();
      worker.close();
      await outcome;
      await replies.return?.();
      sent.mockRestore();
      native.closeShared.mockReset();
      native.coldMutation.mockClear();
    }
  },
);
