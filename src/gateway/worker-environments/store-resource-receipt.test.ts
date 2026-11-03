import { beforeEach, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { WorkerResourceReceipt } from "../../plugins/capability-provider.types.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";
import { workerReadyPatch } from "./store.test-support.js";

const directories = useStateDatabaseTempDirs();
const receipt: WorkerResourceReceipt = {
  version: 1,
  leaseId: "lease-original",
  identity: { machineId: "machine-original", diskId: "disk-original" },
};
const environmentId = "resource-owner";
const provisionOperationId = "provision-original";
let database: OpenClawStateDatabase;
let store: WorkerEnvironmentStore;
let nowMs: number;
let root: string;
const record = (value = receipt, operation = provisionOperationId, assertCurrent = () => {}) =>
  store.recordResourceReceipt({
    environmentId,
    provisionOperationId: operation,
    receipt: value,
    assertCurrent,
  });

beforeEach(async () => {
  root = directories.make("worker-resource-receipt-");
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  nowMs = 1_000;
  store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
  await store.createIntent({
    environmentId,
    provisionOperationId,
    providerId: "provider",
    profileId: "profile",
    profileSnapshot: { settings: {} },
  });
  await store.transition({ environmentId, from: "requested", to: "provisioning" });
});

async function reopen() {
  await closeOpenClawStateDatabaseAsync();
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
}

it("retains allocation identity before enrollment, through failed teardown and until row pruning", async () => {
  expect(await record()).toMatchObject({
    state: "provisioning",
    leaseId: null,
    nodeSetupId: null,
    resourceReceipt: receipt,
  });
  await reopen();
  expect(store.get(environmentId)?.resourceReceipt).toEqual(receipt);
  const beforeRetry = store.get(environmentId);
  nowMs += 100;
  expect(
    await record({
      ...receipt,
      identity: { diskId: "disk-original", machineId: "machine-original" },
    }),
  ).toEqual(beforeRetry);
  await store.adoptProvisionCleanupFailure({
    environmentId,
    leaseId: receipt.leaseId,
    lastError: "bootstrap failed",
  });
  const terminal = await store.transition({
    environmentId,
    from: "destroying",
    to: "failed",
    patch: { leaseId: null, sshEndpoint: null },
  });
  expect(terminal.resourceReceipt).toEqual(receipt);
  await reopen();
  expect(store.get(environmentId)).toEqual(terminal);
  expect(
    await store.pruneTerminalEnvironments({ nowMs: nowMs + 7 * 24 * 60 * 60 * 1_000 - 1 }),
  ).toBe(0);
  expect(store.get(environmentId)?.resourceReceipt).toEqual(receipt);
  expect(await store.pruneTerminalEnvironments({ nowMs: nowMs + 7 * 24 * 60 * 60 * 1_000 })).toBe(
    1,
  );
  await reopen();
  expect(store.get(environmentId)).toBeUndefined();
});

it("rejects changed operations, resource identities and future leases without mutating the row", async () => {
  const original = await record();
  await expect(record(receipt, "different-operation")).rejects.toThrow(
    "provision operation changed",
  );
  await expect(
    record({ ...receipt, identity: { ...receipt.identity, diskId: "replacement" } }),
  ).rejects.toThrow("resource receipt is immutable");
  await expect(record({ ...receipt, leaseId: "replacement" })).rejects.toThrow(
    "resource receipt is immutable",
  );
  await expect(
    store.adoptProvisionCleanupFailure({
      environmentId,
      leaseId: "replacement",
      lastError: "failure",
    }),
  ).rejects.toThrow("resource receipt lease changed");
  await expect(
    store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: workerReadyPatch("replacement", "node"),
    }),
  ).rejects.toThrow("resource receipt does not match");
  expect(store.get(environmentId)).toEqual(original);
  await reopen();
  expect(store.get(environmentId)).toEqual(original);
});

it("checks an already persisted lease and live caller authority before admitting a receipt", async () => {
  const original = await store.transition({
    environmentId,
    from: "provisioning",
    to: "ready",
    patch: workerReadyPatch(receipt.leaseId, "node"),
  });
  await expect(record({ ...receipt, leaseId: "replacement" })).rejects.toThrow(
    "resource receipt lease changed",
  );
  let active = true;
  const pending = record(receipt, provisionOperationId, () => {
    if (!active) {
      throw new Error("provision owner retired");
    }
  });
  active = false;
  await expect(pending).rejects.toThrow("provision owner retired");
  expect(store.get(environmentId)).toEqual(original);
  await reopen();
  expect(store.get(environmentId)).toEqual(original);
  expect((await record()).resourceReceipt).toEqual(receipt);
});

it.each([
  { version: 2, leaseId: receipt.leaseId, identity: receipt.identity },
  { ...receipt, identity: { diskId: 42 } },
  { ...receipt, leaseId: "different-durable-lease" },
])(
  "refuses corrupt retained receipt bytes instead of treating them as legacy absence: %j",
  async (corrupt) => {
    await store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: workerReadyPatch(receipt.leaseId, "node"),
    });
    const pathname = database.path;
    await closeOpenClawStateDatabaseAsync();
    const encoded = JSON.stringify(corrupt);
    using offline = openNodeSqliteDatabase(pathname);
    offline
      .prepare("UPDATE worker_environments SET resource_receipt_json = ? WHERE environment_id = ?")
      .run(encoded, environmentId);
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    await expect(createWorkerEnvironmentStore({ database })).rejects.toThrow(
      /resource (receipt|identity)/,
    );
    await closeOpenClawStateDatabaseAsync();
    expect(
      offline
        .prepare("SELECT resource_receipt_json FROM worker_environments WHERE environment_id = ?")
        .get(environmentId),
    ).toEqual({ resource_receipt_json: encoded });
  },
);
