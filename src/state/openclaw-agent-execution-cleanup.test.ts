import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { onSqliteWalCheckpoint } from "../infra/sqlite-wal-checkpoint.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import {
  runWithSqliteWorkerStateContext as inContext,
  type SqliteWorkerStateContext,
} from "../infra/sqlite-worker-state-context.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as validation from "./openclaw-agent-db-validation-cache.js";
import {
  cleanupRetiredAgentDatabaseLease,
  closeAgentDatabaseNativeGeneration,
  readAgentDatabaseClosedReceipt,
} from "./openclaw-agent-execution-cleanup.js";
import type { AgentDatabaseNativeStore } from "./openclaw-agent-execution-contract.js";
import * as schema from "./openclaw-state-db-schema-policy.js";
import type { OpenClawStateWorkerCleanupOperations } from "./openclaw-state-worker-contract.js";

type CleanupStore = SqliteWorkerStore<
  Pick<OpenClawStateWorkerCleanupOperations, "agentDatabases.releaseExitedLease">
>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sharedStatePath = "/synthetic/state/openclaw.sqlite";
const target = { agentId: "main", path: "/synthetic/reader-recovery/main.sqlite" };
function cleanup() {
  return cleanupRetiredAgentDatabaseLease({
    context: {
      environment: { OPENCLAW_STATE_DIR: "/synthetic" },
      existingSchemaPath: sharedStatePath,
      admission: {
        coordinationKey: "file:synthetic-state",
        databasePath: sharedStatePath,
        identity: { key: "file:synthetic-state", canonicalPath: sharedStatePath },
        assertCurrent() {},
      },
    },
    stopped: Promise.resolve(),
    assertOwned() {},
    lease: {
      leaseId: "synthetic-lease",
      ...target,
      ownerPid: process.pid,
      ownerStartTime: null,
      sharedStatePath,
      sharedStateIdentity: "file:synthetic-state",
    },
  });
}

const edge = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  prepare: vi.fn(async () => {}),
  repairs: [] as string[],
  forbidden: vi.fn(() => expect.unreachable("Unexpected native database/Worker access")),
}));

vi.mock("node:sqlite", () => ({ DatabaseSync: edge.forbidden }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: edge.forbidden,
}));
vi.mock("../infra/sqlite-worker-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-worker-identity.js")>()),
  readDatabasePathIdentity: async (canonicalPath: string) => ({
    key: "file:synthetic-state",
    canonicalPath,
  }),
}));
vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-worker-store.js")>()),
  openOpenClawStateWorkerCleanupStore: async (
    databasePath: string,
    context: SqliteWorkerStateContext,
  ): Promise<CleanupStore> => {
    inContext(context, () => inspectRepairPolicy("open", databasePath));
    await edge.prepare();
    return {
      async execute(command) {
        inspectRepairPolicy("cleanup", command.input.sharedStatePath);
      },
      close: edge.close,
    };
  },
}));
// mock-isolation: Keep schema ownership proof off real SQLite workers; model transport in-process.
vi.mock("../infra/sqlite-worker-store.js", () => ({
  runSqliteWorkerStoreOperation: async (
    store: CleanupStore,
    operation: (scope: CleanupStore) => Promise<void>,
    context: SqliteWorkerStateContext,
  ) => inContext(context, () => operation(store)),
}));

function inspectRepairPolicy(phase: string, databasePath: string) {
  expect(() => schema.assertOpenClawStateSchemaRepairAllowed(databasePath)).toThrow(
    "schema repair is owned by the existing installation",
  );
  edge.repairs.push(phase);
}

afterEach(() => {
  expect(edge.forbidden).not.toHaveBeenCalled();
  edge.prepare.mockReset();
  validation.clearOpenClawAgentDatabaseValidationCache("/synthetic/reader-recovery");
  edge.repairs.length = 0;
  vi.clearAllMocks();
});

it("retains installed-schema repair ownership through retired agent lease cleanup", async () => {
  expect(schema.getExistingOpenClawStateSchemaPath()).toBeUndefined();
  await cleanup();
  expect(edge.repairs).toEqual(["open", "cleanup"]);
  expect(edge.close).toHaveBeenCalledOnce();
  expect(schema.getExistingOpenClawStateSchemaPath()).toBeUndefined();
});

it("revokes retired reader validation when shared cleanup admission fails", async () => {
  const valid = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const canonicalReady = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.store(new Int32Array(valid), 0, 1);
  Atomics.store(new Int32Array(canonicalReady), 0, 1);
  const receipt = {
    agentId: target.agentId,
    identity: "synthetic-agent",
    birthtime: "synthetic-birthtime",
    receiptId: "reader-recovery-proof",
    valid,
    canonicalReady,
  };
  expect(
    validation.captureOpenClawAgentDatabaseValidationTransfer(target)(receipt.identity, receipt),
  ).toBe(true);
  expect(validation.getOpenClawAgentDatabaseValidationForTransfer(target)?.receiptId).toBe(
    receipt.receiptId,
  );

  const failure = new Error("shared state is undergoing offline maintenance");
  edge.prepare.mockRejectedValueOnce(failure);
  await expect(cleanup()).rejects.toBe(failure);

  expect(validation.getOpenClawAgentDatabaseValidationForTransfer(target)).toBeUndefined();
  expect(Atomics.load(new Int32Array(valid), 0)).toBe(0);
  expect(edge.close).not.toHaveBeenCalled();
});

it.each(["current", "replaced", "revoked"] as const)(
  "keeps delayed close-checkpoint inspection off the event loop (%s owner)",
  async (owner) => {
    const dir = tempDirs.make("agent-close-checkpoint-");
    const nativePath = path.join(dir, "agent.sqlite");
    const selectedPath = path.join(dir, "selected.sqlite");
    const statePath = path.join(dir, "state.sqlite");
    fs.writeFileSync(nativePath, "original agent");
    fs.linkSync(nativePath, selectedPath);
    fs.writeFileSync(statePath, "original state");
    const identity = readDatabasePathIdentitySync(nativePath);
    const shared = readDatabasePathIdentitySync(statePath);
    const checkpoint = {
      observedAtNs: 1n,
      lastCompletedAtNs: 1n,
      health: {
        state: "complete" as const,
        observedAtMs: 1,
        walBytes: 0,
        databaseBytes: 0,
        logFrames: 0,
        checkpointedFrames: 0,
        lastCompletedAtMs: 1,
        consecutiveBlocked: 0,
        warning: false,
      },
    };
    const lease = {
      leaseId: "closed-lease",
      agentId: "main",
      path: nativePath,
      ownerPid: process.pid,
      ownerStartTime: null,
      sharedStatePath: statePath,
      sharedStateIdentity: shared.key,
    };
    const closed = readAgentDatabaseClosedReceipt(
      { identity, incarnation: "closed-worker", checkpoint },
      {
        kind: "file",
        physicalIdentity: identity.key.slice("file:".length),
        incarnation: "closed-worker",
        nativeLocation: nativePath,
      },
      lease,
    );
    expect(closed).toBeDefined();
    const observation = vi.fn();
    const unsubscribe = onSqliteWalCheckpoint(observation);
    const stalled = createDeferredCore();
    const entered = createDeferredCore();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const inspection = vi.mocked(fsPromises.stat).mockImplementation(async (...args) => {
      entered.resolve();
      await stalled.promise;
      return actualFs.stat(...args);
    });
    const syncInspection = vi.spyOn(fs, "statSync");
    let owned = true;
    const stopped = createDeferredCore();
    let closeReceipt: typeof closed;
    const store: AgentDatabaseNativeStore = {
      async execute() {
        return expect.unreachable("Unexpected database operation during close");
      },
      async close() {
        closeReceipt = closed;
        stopped.resolve();
      },
    };
    const publishing = closeAgentDatabaseNativeGeneration({
      pathname: selectedPath,
      context: {
        environment: { OPENCLAW_STATE_DIR: dir },
        existingSchemaPath: statePath,
        admission: {
          coordinationKey: shared.key,
          databasePath: statePath,
          identity: shared,
          assertCurrent() {},
        },
      },
      processOwner: undefined,
      opening: Promise.resolve(store),
      readOpenedStore: () => store,
      assertCleanupOwned() {
        if (!owned) {
          throw new Error("cleanup authority revoked");
        }
      },
      readRetirement: () => ({
        stopped: stopped.promise,
        lease,
        readOpenRefused: undefined,
        closed: closeReceipt,
      }),
    });
    try {
      await entered.promise;
      expect(inspection).toHaveBeenCalledWith(selectedPath, { bigint: true });
      await setImmediate();
      expect(syncInspection).not.toHaveBeenCalled();
      expect(observation).not.toHaveBeenCalled();
      if (owner === "replaced") {
        fs.unlinkSync(selectedPath);
        fs.writeFileSync(selectedPath, "replacement agent");
      }
      owned = owner !== "revoked";
      stalled.resolve();
      await publishing;
      expect(observation).toHaveBeenCalledTimes(owner === "current" ? 1 : 0);
      if (owner === "current") {
        expect(observation).toHaveBeenCalledWith({ ...checkpoint, databasePath: selectedPath });
      }
    } finally {
      stalled.resolve();
      await publishing;
      inspection.mockRestore();
      syncInspection.mockRestore();
      unsubscribe();
    }
  },
);
