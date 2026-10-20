import { afterEach, expect, it, vi } from "vitest";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import {
  runWithSqliteWorkerStateContext as inContext,
  type SqliteWorkerStateContext,
} from "../infra/sqlite-worker-state-context.js";
import {
  captureOpenClawAgentDatabaseValidationTransfer,
  clearOpenClawAgentDatabaseValidationCache,
  getOpenClawAgentDatabaseValidationForTransfer,
} from "./openclaw-agent-db-validation-cache.js";
import { cleanupRetiredAgentDatabaseLease } from "./openclaw-agent-execution-cleanup.js";
import {
  assertOpenClawStateSchemaRepairAllowed,
  getExistingOpenClawStateSchemaPath,
} from "./openclaw-state-db-schema-policy.js";
import type { OpenClawStateWorkerCleanupOperations } from "./openclaw-state-worker-contract.js";

type CleanupStore = SqliteWorkerStore<
  Pick<OpenClawStateWorkerCleanupOperations, "agentDatabases.releaseExitedLease">
>;
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
  openFailure: undefined as Error | undefined,
  repairs: [] as string[],
  forbidden: vi.fn((): never => {
    throw new Error("Cleanup schema proof crossed a native database or Worker boundary");
  }),
}));

vi.mock("node:sqlite", () => ({ DatabaseSync: edge.forbidden }));
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
  ) => {
    inContext(context, () => inspectRepairPolicy("open", databasePath));
    if (edge.openFailure) {
      throw edge.openFailure;
    }
    const store: CleanupStore = {
      async execute(command) {
        inspectRepairPolicy("cleanup", command.input.sharedStatePath);
      },
      close: edge.close,
    };
    return store;
  },
}));
vi.mock("../infra/sqlite-worker-store.js", () => ({
  runSqliteWorkerStoreOperation: async (
    store: CleanupStore,
    operation: (scope: CleanupStore) => Promise<void>,
    context: SqliteWorkerStateContext,
  ) => inContext(context, () => operation(store)),
}));

function inspectRepairPolicy(phase: string, databasePath: string) {
  expect(() => assertOpenClawStateSchemaRepairAllowed(databasePath)).toThrow(
    expect.objectContaining({
      message: expect.stringContaining("schema repair is owned by the existing installation"),
    }),
  );
  edge.repairs.push(phase);
}

afterEach(() => {
  expect(edge.forbidden).not.toHaveBeenCalled();
  edge.openFailure = undefined;
  clearOpenClawAgentDatabaseValidationCache("/synthetic/reader-recovery");
  edge.repairs.length = 0;
  vi.clearAllMocks();
});

it("retains installed-schema repair ownership through retired agent lease cleanup", async () => {
  expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
  await cleanup();
  expect(edge.repairs).toEqual(["open", "cleanup"]);
  expect(edge.close).toHaveBeenCalledOnce();
  expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
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
  expect(captureOpenClawAgentDatabaseValidationTransfer(target)(receipt.identity, receipt)).toBe(
    true,
  );
  expect(getOpenClawAgentDatabaseValidationForTransfer(target)).toMatchObject({
    receiptId: receipt.receiptId,
  });

  const failure = new Error("shared state is undergoing offline maintenance");
  edge.openFailure = failure;
  await expect(cleanup()).rejects.toBe(failure);

  expect(getOpenClawAgentDatabaseValidationForTransfer(target)).toBeUndefined();
  expect(Atomics.load(new Int32Array(valid), 0)).toBe(0);
  expect(edge.close).not.toHaveBeenCalled();
});
