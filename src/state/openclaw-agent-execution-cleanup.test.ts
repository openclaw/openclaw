import { afterEach, expect, it, vi } from "vitest";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import {
  runWithSqliteWorkerStateContext as inContext,
  type SqliteWorkerStateContext,
} from "../infra/sqlite-worker-state-context.js";
import * as validation from "./openclaw-agent-db-validation-cache.js";
import { cleanupRetiredAgentDatabaseLease } from "./openclaw-agent-execution-cleanup.js";
import * as schema from "./openclaw-state-db-schema-policy.js";
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
  prepare: vi.fn(async () => {}),
  repairs: [] as string[],
  forbidden: vi.fn(() => expect.unreachable("Unexpected native database/Worker access")),
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
