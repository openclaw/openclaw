import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { workerReadyPatch } from "./store.test-support.js";

const delivery = vi.hoisted(() => ({
  loseIntentResult: false,
  hideReceipt: false,
  hideSettlement: false,
  loseRevocationResult: undefined as "receipt" | "settlement" | "unknown" | undefined,
  loseRevocationFailure: false,
  failReadback: false,
  intentWrites: 0,
  revocationWrites: 0,
  readbackIds: [] as string[][],
  resultFailure: new Error("synthetic result delivery failure"),
  readFailure: new Error("synthetic inventory readback failure"),
}));
vi.mock("../../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/sqlite-worker-operation-admission.js")>();
  const originals = new WeakMap<
    Parameters<typeof actual.observeSqliteWorkerCommittedFacts>[0],
    Parameters<typeof actual.observeSqliteWorkerCommittedFacts>[0]
  >();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      ...args: Parameters<typeof actual.createSqliteWorkerOperationAdmission>
    ) => {
      const original = actual.createSqliteWorkerOperationAdmission(...args);
      const proxy = new Proxy(original, {
        get(target, key, receiver) {
          return (key === "committed" && delivery.hideReceipt) ||
            (key === "settlement" && delivery.hideSettlement)
            ? undefined
            : Reflect.get(target, key, receiver);
        },
      });
      originals.set(proxy, original);
      return proxy;
    },
    observeSqliteWorkerCommittedFacts: (
      admission: Parameters<typeof actual.observeSqliteWorkerCommittedFacts>[0],
      observer: Parameters<typeof actual.observeSqliteWorkerCommittedFacts>[1],
    ) =>
      actual.observeSqliteWorkerCommittedFacts(originals.get(admission) ?? admission, (receipt) => {
        if (!delivery.loseIntentResult && !delivery.loseRevocationResult) {
          observer(receipt);
        }
      }),
  };
});
// mock-isolation: Inject receipt/result failures while the shared helper preserves real exports.
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  const { interceptWorkerExecution } = await import("./store.test-support.js");
  return interceptWorkerExecution(actual, (scope) => async (command, executeOptions) => {
    const creating = command.type === "workerEnvironments.createIntent";
    const revoking = command.type === "workerEnvironments.revokeEnvironmentCredential";
    if (creating) {
      delivery.intentWrites += 1;
    }
    if (revoking) {
      delivery.revocationWrites += 1;
    }
    const result = await scope.execute(command, executeOptions).catch((error: unknown) => {
      if (revoking && delivery.loseRevocationFailure) {
        delivery.loseRevocationFailure = false;
        delivery.hideReceipt = true;
        delivery.hideSettlement = true;
        throw delivery.resultFailure;
      }
      throw error;
    });
    if (creating && delivery.loseIntentResult) {
      delivery.loseIntentResult = false;
      delivery.hideReceipt = true;
      delivery.hideSettlement = true;
      throw delivery.resultFailure;
    }
    if (revoking && delivery.loseRevocationResult) {
      const recovery = delivery.loseRevocationResult;
      delivery.loseRevocationResult = undefined;
      delivery.hideReceipt = recovery !== "receipt";
      delivery.hideSettlement = recovery === "unknown";
      throw delivery.resultFailure;
    }
    return result;
  });
});
vi.mock("../../state/openclaw-state-db-readonly.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-state-db-readonly.js")>();
  return {
    ...actual,
    executeExistingOpenClawStateRead: (
      ...args: Parameters<typeof actual.executeExistingOpenClawStateRead>
    ) => {
      const command = args[1];
      if (command.type === "workerEnvironments.snapshot" && command.ids) {
        delivery.readbackIds.push([...command.ids]);
        if (delivery.failReadback) {
          delivery.failReadback = false;
          throw delivery.readFailure;
        }
      }
      return actual.executeExistingOpenClawStateRead(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    delivery.hideReceipt = false;
    delivery.hideSettlement = false;
    delivery.loseRevocationResult = undefined;
    delivery.loseRevocationFailure = false;
    delivery.loseIntentResult = false;
    delivery.failReadback = false;
    delivery.intentWrites = 0;
    delivery.revocationWrites = 0;
    delivery.readbackIds = [];
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

let database: ReturnType<typeof openOpenClawStateDatabase>;
let first: Awaited<ReturnType<typeof createWorkerEnvironmentStore>>;
let survivor: typeof first;
const stores: (typeof first)[] = [];
async function openStore() {
  const store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
  stores.push(store);
  return store;
}
const createIntent = (environmentId: string) =>
  first.createIntent({
    environmentId,
    providerId: "fake-provider",
    profileId: "test-profile",
    profileSnapshot: { settings: {} },
    provisionOperationId: `provision:${environmentId}`,
  });
const showNativeConfirmation = () => {
  delivery.hideReceipt = false;
  delivery.hideSettlement = false;
};
beforeEach(async () => {
  database = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("environment-recovery-") },
  });
  first = await openStore();
  survivor = await openStore();
});

it("reloads the durable write in a new inventory after failed readback closes the old one", async () => {
  delivery.loseIntentResult = true;
  delivery.failReadback = true;
  await expect(createIntent("worker-recovery")).rejects.toBe(delivery.resultFailure);
  expect(() => survivor.get("worker-recovery")).toThrow("inventory has closed");
  await Promise.all([first.close(), survivor.close()]);
  showNativeConfirmation();
  const reloaded = await openStore();
  expect(reloaded.get("worker-recovery")).toMatchObject({
    state: "requested",
    environmentId: "worker-recovery",
  });
  await reloaded.close();
  expect(delivery.intentWrites).toBe(1);
  expect(database.db.prepare("SELECT count(*) AS count FROM worker_environments").get()).toEqual({
    count: 1,
  });
  expect(delivery.readbackIds).toEqual([["worker-recovery"]]);
});

it("publishes permanent revocation once across committed, rolled-back and unknown worker outcomes", async () => {
  const environmentId = "worker-revocation-recovery";
  await createIntent(environmentId);
  await first.transition({ environmentId, from: "requested", to: "provisioning" });
  await first.transition({
    environmentId,
    from: "provisioning",
    to: "ready",
    patch: workerReadyPatch("lease-revocation-recovery", "device-revocation-recovery"),
  });
  const firstNotifications: string[] = [];
  const survivorNotifications: string[] = [];
  first.onCredentialRevoked((id) => firstNotifications.push(id));
  survivor.onCredentialRevoked((id) => survivorNotifications.push(id));
  const revoke = () =>
    first.revokeEnvironmentCredential(environmentId, { fenceWorkspaceTransfers: true });
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.exec(`CREATE TABLE revocation_commit_guard (
        environment_id TEXT REFERENCES worker_environment_credentials(environment_id) DEFERRABLE INITIALLY DEFERRED
      )`);
      db.prepare("INSERT INTO revocation_commit_guard(environment_id) VALUES (?)").run(
        environmentId,
      );
    },
    { database },
  );
  await expect(revoke()).rejects.toThrow(/FOREIGN KEY/i);
  expect(firstNotifications).toEqual([]);
  expect(survivorNotifications).toEqual([]);
  expect(survivor.getCredential(environmentId)).toBeDefined();
  expect(delivery.readbackIds).toEqual([]);

  // Lost rollback confirmation is unknown; a still-present credential forbids a fence event.
  delivery.loseRevocationFailure = true;
  await expect(revoke()).rejects.toBe(delivery.resultFailure);
  expect(survivor.getCredential(environmentId)).toBeDefined();
  expect(survivorNotifications).toEqual([]);
  showNativeConfirmation();
  runOpenClawStateWriteTransaction(({ db }) => db.exec("DROP TABLE revocation_commit_guard"), {
    database,
  });

  // Committed no-ops still carry explicit permanent transfer-fencing requests.
  for (const [index, outcome] of (["settlement", "receipt", "unknown"] as const).entries()) {
    delivery.loseRevocationResult = outcome;
    await expect(revoke()).rejects.toBe(delivery.resultFailure);
    expect(survivor.getCredential(environmentId)).toBeUndefined();
    expect(survivorNotifications).toEqual(Array.from({ length: index + 1 }, () => environmentId));
    if (outcome === "settlement") {
      showNativeConfirmation();
    }
  }
  expect(firstNotifications).toEqual(survivorNotifications);
  expect(survivor.getCredential(environmentId)).toBeUndefined();
  showNativeConfirmation();

  expect(delivery.revocationWrites).toBe(5);
});
