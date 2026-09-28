import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  ensureDevicePairSetupBootstrapToken,
  verifyDeviceBootstrapToken,
} from "../../infra/device-bootstrap.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../../shared/device-bootstrap-profile.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

const delivery = vi.hoisted(() => ({
  afterResult: undefined as ((command: string) => Promise<void>) | undefined,
}));
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
              const result = await scope.execute(command, executeOptions);
              await delivery.afterResult?.(command.type);
              return result;
            },
          }),
        options,
      ),
  };
});

const BOOTSTRAP_RECEIPT = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.1",
  protocolFeatures: ["workspace-sync-v1", "model-proxy-v1"],
};

describe("worker environment node enrollment store", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-node-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
    await store.createIntent({
      environmentId: "worker-enrollment",
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:worker-enrollment",
    });
  });

  afterEach(async () => {
    delivery.afterResult = undefined;
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedEnrollmentState(state: string, deviceId: string | null): Promise<string> {
    await store.transition({
      environmentId: "worker-enrollment",
      from: "requested",
      to: "provisioning",
    });
    const setupId = expectDefined(
      (await store.ensureNodeEnrollment("worker-enrollment")).nodeSetupId,
      "worker node enrollment setup id",
    );
    const leased = !["requested", "provisioning", "failed"].includes(state);
    const ssh = leased && deviceId === null;
    const receipt = leased && state !== "bootstrapping";
    database.db
      .prepare(
        `UPDATE worker_environments SET state = ?, node_device_id = ?, lease_id = ?,
          ssh_host = ?, ssh_port = ?, ssh_user = ?, ssh_host_key = ?, ssh_key_ref_json = ?,
          bootstrap_bundle_hash = ?, bootstrap_openclaw_version = ?,
          bootstrap_protocol_features_json = ?, attached_session_ids_json = ?
         WHERE node_setup_id = ?`,
      )
      .run(
        state,
        deviceId,
        leased ? "lease-enrollment" : null,
        ssh ? "worker.example.test" : null,
        ssh ? 22 : null,
        ssh ? "openclaw" : null,
        ssh ? "ssh-ed25519 AAAA" : null,
        ssh ? JSON.stringify({ source: "file", provider: "worker-keys", id: "/test-key" }) : null,
        receipt ? BOOTSTRAP_RECEIPT.bundleHash : null,
        receipt ? BOOTSTRAP_RECEIPT.openclawVersion : null,
        receipt ? JSON.stringify(BOOTSTRAP_RECEIPT.protocolFeatures) : null,
        JSON.stringify(state === "attached" ? ["session-enrollment"] : []),
        setupId,
      );
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
    return setupId;
  }

  it.each(["ordinary", "lost pairing result", "delayed inventory result"] as const)(
    "binds setup completion to the exact environment identity across restart (%s)",
    async (mode) => {
      expect(store.hasPendingNodeEnrollmentSetup("", "cloud-device-1")).toBe(false);
      expect(store.hasPendingNodeEnrollmentSetup("missing-setup", "cloud-device-1")).toBe(false);
      await store.transition({
        environmentId: "worker-enrollment",
        from: "requested",
        to: "provisioning",
      });
      const pending = await store.ensureNodeEnrollment("worker-enrollment");
      const setupId = expectDefined(pending.nodeSetupId, "worker node enrollment setup id");
      expect(setupId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(pending.nodeDeviceId).toBeNull();
      expect((await store.ensureNodeEnrollment("worker-enrollment")).nodeSetupId).toBe(setupId);
      expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-1")).toBe(true);
      expect(store.hasNodeEnrollmentOwner("cloud-device-1")).toBe(false);
      const inventoryVersion = store.inventoryVersion();

      const issued = await ensureDevicePairSetupBootstrapToken({
        baseDir: root,
        setupId,
        profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      });
      if (issued.status !== "pending") {
        throw new Error("expected pending cloud worker setup");
      }
      await verifyDeviceBootstrapToken({
        baseDir: root,
        token: issued.token,
        deviceId: "cloud-device-1",
        publicKey: "cloud-public-key-1",
        role: "node",
        scopes: [],
      });
      const resultFailure = new Error("Pairing result delivery was lost");
      const inventoryCommitted = createDeferredCore();
      const releaseInventory = createDeferredCore();
      let inventoryResult: Promise<unknown> | undefined;
      delivery.afterResult = async (command) => {
        if (command === "bootstrap.consume" && mode === "lost pairing result") {
          throw resultFailure;
        }
        if (command === "workerEnvironments.recordError") {
          inventoryCommitted.resolve();
          await releaseInventory.promise;
        }
      };
      try {
        if (mode === "delayed inventory result") {
          inventoryResult = store.recordError({
            environmentId: "worker-enrollment",
            state: "provisioning",
            error: "Captured before pairing",
          });
          await inventoryCommitted.promise;
        }
        const consumed = consumeDeviceBootstrapTokenWithSetupCompletion({
          baseDir: root,
          token: issued.token,
          deviceId: "cloud-device-1",
          completedAtMs: 10,
        });
        if (mode === "lost pairing result") {
          await expect(consumed).rejects.toBe(resultFailure);
        } else {
          await consumed;
        }
        releaseInventory.resolve();
        await inventoryResult;

        expect(store.get("worker-enrollment")).toMatchObject({
          nodeSetupId: setupId,
          nodeDeviceId: "cloud-device-1",
        });
        expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-1")).toBe(true);
        expect(store.hasPendingNodeEnrollmentSetup(setupId, "different-cloud-device")).toBe(false);
        expect(store.inventoryVersion()).toBeGreaterThan(inventoryVersion);
        expect(store.hasNodeEnrollmentOwner("cloud-device-1")).toBe(true);
        expect(store.hasNodeEnrollmentOwner("different-cloud-device")).toBe(false);
      } finally {
        releaseInventory.resolve();
        await inventoryResult?.catch(() => {});
        delivery.afterResult = undefined;
      }
    },
  );

  it("rejects a destroy-requested provisioning setup", async () => {
    await store.transition({
      environmentId: "worker-enrollment",
      from: "requested",
      to: "provisioning",
    });
    const setupId = expectDefined(
      (await store.ensureNodeEnrollment("worker-enrollment")).nodeSetupId,
      "worker node enrollment setup id",
    );
    expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-canceled")).toBe(true);
    const issued = await ensureDevicePairSetupBootstrapToken({
      baseDir: root,
      setupId,
      profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    if (issued.status !== "pending") {
      throw new Error("expected pending cloud worker setup");
    }
    await verifyDeviceBootstrapToken({
      baseDir: root,
      token: issued.token,
      deviceId: "cloud-device-canceled",
      publicKey: "cloud-public-key-canceled",
      role: "node",
      scopes: [],
    });

    await store.requestDestroy({ environmentId: "worker-enrollment", state: "provisioning" });

    expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-canceled")).toBe(false);
    await expect(
      consumeDeviceBootstrapTokenWithSetupCompletion({
        baseDir: root,
        token: issued.token,
        deviceId: "cloud-device-canceled",
        completedAtMs: 10,
      }),
    ).rejects.toThrow("Cloud worker setup completion owner is no longer pending");
    expect(store.get("worker-enrollment")?.nodeDeviceId).toBeNull();
  });

  it.each(["provisioning", "ready", "idle", "attached"])(
    "admits only the exact already-bound setup device in %s",
    async (state) => {
      const setupId = await seedEnrollmentState(state, "cloud-device-bound");

      expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-bound")).toBe(true);
      expect(store.hasNodeEnrollmentOwner("cloud-device-bound")).toBe(true);
      expect(store.hasPendingNodeEnrollmentSetup(setupId, "different-cloud-device")).toBe(false);
      expect(store.hasPendingNodeEnrollmentSetup("missing-setup", "cloud-device-bound")).toBe(
        false,
      );
    },
  );

  it.each(["provisioning", "bootstrapping", "ready", "idle", "attached"])(
    "allows first setup-device binding in %s only when provisioning",
    async (state) => {
      const setupId = await seedEnrollmentState(state, null);

      expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-first")).toBe(
        state === "provisioning",
      );
    },
  );

  it.each(["requested", "draining", "destroying", "destroyed", "failed", "orphaned"])(
    "rejects an already-bound setup device in %s",
    async (state) => {
      const setupId = await seedEnrollmentState(state, "cloud-device-bound");

      expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-bound")).toBe(false);
      expect(store.hasNodeEnrollmentOwner("cloud-device-bound")).toBe(
        state === "requested" || state === "draining" || state === "destroying",
      );
    },
  );

  it("persists a credential-bound node receipt without SSH metadata", async () => {
    await store.transition({
      environmentId: "worker-enrollment",
      from: "requested",
      to: "provisioning",
    });
    const ready = await store.transition({
      environmentId: "worker-enrollment",
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "device-lease-1",
        nodeDeviceId: "device-1",
        sshEndpoint: null,
        sharedHost: true,
        bootstrapReceipt: { ...BOOTSTRAP_RECEIPT, installKind: "bundle" },
        credential: {
          credentialHash: hashWorkerCredential("worker-credential-fixture"),
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: 11_000,
        },
      },
    });

    expect(ready).toMatchObject({
      state: "ready",
      leaseId: "device-lease-1",
      nodeDeviceId: "device-1",
      sshEndpoint: null,
      bootstrapReceipt: {
        ...BOOTSTRAP_RECEIPT,
        protocolFeatures: ["model-proxy-v1", "workspace-sync-v1"],
        installKind: "bundle",
      },
      sharedHost: true,
      ownerEpoch: 1,
    });
    expect(store.hasNodeEnrollmentOwner("device-1")).toBe(false);
    expect(
      database.db
        .prepare(
          "SELECT node_device_id, ssh_host, ssh_host_key FROM worker_environments WHERE environment_id = ?",
        )
        .get("worker-enrollment"),
    ).toEqual({ node_device_id: "device-1", ssh_host: null, ssh_host_key: null });
  });
});
