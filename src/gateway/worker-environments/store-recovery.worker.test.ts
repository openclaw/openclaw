import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { workerReadyPatch } from "./store.test-support.js";

const delivery = vi.hoisted(() => ({
  pending: undefined as "intent" | "rollback" | "receipt" | "settlement" | "unknown" | undefined,
  confirmation: "both" as "both" | "settlement" | "none",
  failReadback: false,
  intentWrites: 0,
  revocationWrites: 0,
  resultFailure: new Error("synthetic result delivery failure"),
  readFailure: new Error("synthetic inventory readback failure"),
  loseResult(): never {
    this.confirmation =
      this.pending === "receipt" ? "both" : this.pending === "settlement" ? "settlement" : "none";
    this.pending = undefined;
    throw this.resultFailure;
  },
}));
vi.mock("../../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/sqlite-worker-operation-admission.js")>();
  const originals = new WeakMap<SqliteWorkerOperationAdmission, SqliteWorkerOperationAdmission>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (...args) => {
      const original = actual.createSqliteWorkerOperationAdmission(...args);
      const proxy = new Proxy(original, {
        get(target, key, receiver) {
          return (key === "committed" && delivery.confirmation !== "both") ||
            (key === "settlement" && delivery.confirmation === "none")
            ? undefined
            : Reflect.get(target, key, receiver);
        },
      });
      originals.set(proxy, original);
      return proxy;
    },
    observeSqliteWorkerCommittedFacts: (admission, observer) =>
      actual.observeSqliteWorkerCommittedFacts(originals.get(admission) ?? admission, (receipt) => {
        if (!delivery.pending || delivery.pending === "rollback") {
          observer(receipt);
        }
      }),
  } satisfies typeof actual;
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
      if (revoking && delivery.pending === "rollback") {
        delivery.loseResult();
      }
      throw error;
    });
    const lostRevocation =
      delivery.pending === "receipt" ||
      delivery.pending === "settlement" ||
      delivery.pending === "unknown";
    if ((creating && delivery.pending === "intent") || (revoking && lostRevocation)) {
      delivery.loseResult();
    }
    return result;
  });
});
vi.mock("../../state/openclaw-state-db-readonly.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-state-db-readonly.js")>();
  return {
    ...actual,
    executeExistingOpenClawStateRead: (...args) => {
      const command = args[1];
      if (command.type === "workerEnvironments.snapshot" && command.ids && delivery.failReadback) {
        delivery.failReadback = false;
        throw delivery.readFailure;
      }
      return actual.executeExistingOpenClawStateRead(...args);
    },
  } satisfies typeof actual;
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    delivery.confirmation = "both";
    delivery.pending = undefined;
    delivery.failReadback = false;
    delivery.intentWrites = 0;
    delivery.revocationWrites = 0;
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
  delivery.confirmation = "both";
};
beforeEach(async () => {
  database = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("environment-recovery-") },
  });
  first = await openStore();
  survivor = await openStore();
});

it("reloads the durable write in a new inventory after failed readback closes the old one", async () => {
  delivery.pending = "intent";
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

  // Lost rollback confirmation is unknown; a still-present credential forbids a fence event.
  delivery.pending = "rollback";
  await expect(revoke()).rejects.toBe(delivery.resultFailure);
  expect(survivor.getCredential(environmentId)).toBeDefined();
  expect(survivorNotifications).toEqual([]);
  showNativeConfirmation();
  runOpenClawStateWriteTransaction(({ db }) => db.exec("DROP TABLE revocation_commit_guard"), {
    database,
  });

  // Committed no-ops still carry explicit permanent transfer-fencing requests.
  for (const [index, outcome] of (["settlement", "receipt", "unknown"] as const).entries()) {
    delivery.pending = outcome;
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
