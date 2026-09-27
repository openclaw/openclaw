import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createWorkerEnvironmentStore } from "./store.js";

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
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      ...args: Parameters<typeof actual.createSqliteWorkerOperationAdmission>
    ) =>
      new Proxy(actual.createSqliteWorkerOperationAdmission(...args), {
        get(target, key, receiver) {
          return (key === "committed" && delivery.hideReceipt) ||
            (key === "settlement" && delivery.hideSettlement)
            ? undefined
            : Reflect.get(target, key, receiver);
        },
      }),
  };
});
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      context: Parameters<typeof actual.runOpenClawStateWorkerOperation>[0],
      operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
      options: Parameters<typeof actual.runOpenClawStateWorkerOperation>[2],
    ) =>
      actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              if (command.type === "workerEnvironments.createIntent") {
                delivery.intentWrites += 1;
              }
              if (command.type === "workerEnvironments.revokeEnvironmentCredential") {
                delivery.revocationWrites += 1;
              }
              const result = await scope
                .execute(command, executeOptions)
                .catch((error: unknown) => {
                  if (
                    command.type === "workerEnvironments.revokeEnvironmentCredential" &&
                    delivery.loseRevocationFailure
                  ) {
                    delivery.loseRevocationFailure = false;
                    delivery.hideReceipt = true;
                    delivery.hideSettlement = true;
                    throw delivery.resultFailure;
                  }
                  throw error;
                });
              if (command.type === "workerEnvironments.createIntent" && delivery.loseIntentResult) {
                delivery.loseIntentResult = false;
                delivery.hideReceipt = true;
                delivery.hideSettlement = true;
                throw delivery.resultFailure;
              }
              if (
                command.type === "workerEnvironments.revokeEnvironmentCredential" &&
                delivery.loseRevocationResult
              ) {
                const recovery = delivery.loseRevocationResult;
                delivery.loseRevocationResult = undefined;
                delivery.hideReceipt = recovery !== "receipt";
                delivery.hideSettlement = recovery === "unknown";
                throw delivery.resultFailure;
              }
              return result;
            },
          }),
        options,
      ),
  };
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
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it.each(["ready", "next mutation"] as const)(
  "recovers a settled write through another live facade's %s after readback fails",
  async (retry) => {
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: tempDirs.make("environment-recovery-") },
    });
    const first = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
    const survivor = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
    const publications: string[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("all" in change && change.scope === "worker-environments") {
        publications.push(survivor.get("worker-recovery")!.environmentId);
      }
    });
    try {
      delivery.loseIntentResult = true;
      delivery.failReadback = true;
      await expect(
        first.createIntent({
          environmentId: "worker-recovery",
          providerId: "fake-provider",
          profileId: "test-profile",
          profileSnapshot: { settings: {} },
          provisionOperationId: "provision:worker-recovery",
        }),
      ).rejects.toMatchObject({
        errors: [delivery.resultFailure, delivery.readFailure],
        cause: delivery.readFailure,
      });
      expect(() => survivor.get("worker-recovery")).toThrow("unsettled mutation");
      expect(publications).toEqual([]);
      await first.close();
      delivery.hideReceipt = false;
      delivery.hideSettlement = false;
      if (retry === "ready") {
        await survivor.ready();
      } else {
        await survivor.revokeEnvironmentCredential("worker-recovery");
      }
      expect(survivor.get("worker-recovery")).toMatchObject({
        state: "requested",
        environmentId: "worker-recovery",
      });
      expect(delivery.intentWrites).toBe(1);
      expect(
        database.db.prepare("SELECT count(*) AS count FROM worker_environments").get(),
      ).toEqual({ count: 1 });
      expect(delivery.readbackIds).toEqual([["worker-recovery"], ["worker-recovery"]]);
      expect(publications).toEqual(["worker-recovery"]);
      await survivor.ready();
      expect(delivery.readbackIds).toHaveLength(2);
    } finally {
      unsubscribe();
      await Promise.all([first.close(), survivor.close()]);
    }
  },
);

it("publishes permanent revocation once across committed, rolled-back and unknown worker outcomes", async () => {
  const database = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("environment-revocation-recovery-") },
  });
  const first = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
  const survivor = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
  const environmentId = "worker-revocation-recovery";
  await first.createIntent({
    environmentId,
    providerId: "fake-provider",
    profileId: "test-profile",
    profileSnapshot: { settings: {} },
    provisionOperationId: "provision:worker-revocation-recovery",
  });
  await first.transition({ environmentId, from: "requested", to: "provisioning" });
  const ready = await first.transition({
    environmentId,
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: "lease-revocation-recovery",
      nodeDeviceId: "device-revocation-recovery",
      sharedHost: false,
      bootstrapReceipt: {
        bundleHash: "a".repeat(64),
        openclawVersion: "test",
        protocolFeatures: [],
      },
      credential: {
        credentialHash: "b".repeat(43),
        sessionId: null,
        rpcSetVersion: 1,
        expiresAtMs: 2_000,
      },
    },
  });
  const firstNotifications: string[] = [];
  const survivorNotifications: string[] = [];
  first.onCredentialRevoked((id) => firstNotifications.push(id));
  survivor.onCredentialRevoked((id) => survivorNotifications.push(id));
  const revoke = () =>
    first.revokeEnvironmentCredential(environmentId, { fenceWorkspaceTransfers: true });
  const showNativeConfirmation = () => {
    delivery.hideReceipt = false;
    delivery.hideSettlement = false;
  };
  try {
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

    delivery.loseRevocationResult = "settlement";
    await expect(revoke()).rejects.toBe(delivery.resultFailure);
    expect(survivor.getCredential(environmentId)).toBeUndefined();
    expect(survivorNotifications).toEqual([environmentId]);
    showNativeConfirmation();

    // A committed no-op still carries the explicit permanent transfer-fencing request.
    delivery.loseRevocationResult = "receipt";
    await expect(revoke()).rejects.toBe(delivery.resultFailure);
    expect(survivorNotifications).toEqual([environmentId, environmentId]);

    delivery.loseRevocationResult = "unknown";
    await expect(revoke()).rejects.toBe(delivery.resultFailure);
    expect(survivorNotifications).toEqual([environmentId, environmentId, environmentId]);
    expect(firstNotifications).toEqual(survivorNotifications);
    expect(survivor.getCredential(environmentId)).toBeUndefined();
    showNativeConfirmation();

    // Restore authority so lost readback must fence a real revocation, not an absent credential.
    await first.renewCredential({
      environmentId,
      expectedOwnerEpoch: ready.ownerEpoch,
      credentialHash: "c".repeat(43),
      sessionId: null,
      rpcSetVersion: 1,
      expiresAtMs: 2_000,
    });
    expect(survivor.getCredential(environmentId)).toBeDefined();
    delivery.loseRevocationResult = "unknown";
    delivery.failReadback = true;
    await expect(revoke()).rejects.toMatchObject({
      errors: [delivery.resultFailure, delivery.readFailure],
      cause: delivery.readFailure,
    });
    expect(() => survivor.getCredential(environmentId)).toThrow("unsettled mutation");
    expect(survivorNotifications).toHaveLength(3);
    await first.close();
    showNativeConfirmation();
    await survivor.ready();
    expect(survivorNotifications).toEqual([
      environmentId,
      environmentId,
      environmentId,
      environmentId,
    ]);
    expect(firstNotifications).toHaveLength(3);
    expect(survivor.getCredential(environmentId)).toBeUndefined();
    await survivor.ready();
    expect(survivorNotifications).toHaveLength(4);
    expect(delivery.revocationWrites).toBe(6);
  } finally {
    showNativeConfirmation();
    await Promise.all([first.close(), survivor.close()]);
  }
});
