import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Base64Url } from "../../infra/crypto-digest.js";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  ensureDevicePairSetupBootstrapToken,
  verifyDeviceBootstrapToken,
} from "../../infra/device-bootstrap.js";
import { decodePairingSetupCode } from "../../pairing/setup-code.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../../shared/device-bootstrap-profile.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

const delivery = vi.hoisted(() => ({
  afterResult: undefined as ((command: string) => Promise<void>) | undefined,
}));
// mock-isolation: Intercept worker result delivery; the shared helper preserves real exports.
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  const { interceptWorkerExecution } = await import("./store.test-support.js");
  return interceptWorkerExecution(actual, (scope) => async (command, executeOptions) => {
    const result = await scope.execute(command, executeOptions);
    await delivery.afterResult?.(command.type);
    return result;
  });
});

const BOOTSTRAP_RECEIPT = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.1",
  protocolFeatures: ["workspace-sync-v1", "model-proxy-v1"],
};
const environmentId = "worker-enrollment";
const deviceId = "cloud-device-1";

describe("worker environment node enrollment store", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let managers: ReturnType<typeof createWorkerNodeEnrollmentManager>[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-node-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    managers = [];
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
    await store.createIntent({
      environmentId,
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:worker-enrollment",
    });
    await store.transition({ environmentId, from: "requested", to: "provisioning" });
  });

  afterEach(async () => {
    delivery.afterResult = undefined;
    for (const manager of managers) {
      manager.stop();
    }
    await closeOpenClawStateDatabaseByPathAsync(database.path);
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  afterAll(closeStateDatabaseForTest);

  function createManager() {
    const manager = createWorkerNodeEnrollmentManager({
      store,
      getConfig: () => ({
        gateway: {
          publicOrigin: "https://gateway.example.test",
          auth: { mode: "token", token: "gateway-token" },
        },
      }),
      resolveAvailability: async () => ({ available: false }),
      prepareArtifact: async () => ({
        tarballPath: path.join(root, "node-runtime.tgz"),
        tarballSha256: "a".repeat(64),
        tarballBytes: 1,
        openclawVersion: "2026.8.1",
        buildId: "gateway-source-build",
        enabledPluginIds: [],
      }),
      transfer: createWorkerBootstrapArtifactTransferService(),
    });
    managers.push(manager);
    return manager;
  }

  async function beginConnect(manager = createManager()) {
    const enrollment = await manager.begin(
      expectDefined(store.get(environmentId), "worker environment"),
    );
    if (enrollment.mode !== "connect") {
      throw new Error("expected a connecting cloud worker enrollment");
    }
    const { bootstrapToken: token } = decodePairingSetupCode(enrollment.setupCode);
    return {
      manager,
      enrollment,
      token,
      verification: {
        baseDir: root,
        token,
        deviceId,
        publicKey: "cloud-public-key-1",
        role: "node",
        scopes: [],
      },
    };
  }

  async function ensureSetupId() {
    return expectDefined(
      (await store.ensureNodeEnrollment(environmentId)).nodeSetupId,
      "worker node enrollment setup id",
    );
  }

  function consume(
    connection: Awaited<ReturnType<typeof beginConnect>>,
    overrides: Partial<Parameters<typeof consumeDeviceBootstrapTokenWithSetupCompletion>[0]> = {},
  ) {
    return consumeDeviceBootstrapTokenWithSetupCompletion({
      baseDir: root,
      token: connection.token,
      deviceId: connection.verification.deviceId,
      completedAtMs: Date.now(),
      admitsCloudWorkerSetup: connection.manager.admitsNodeSetupCompletion,
      ...overrides,
    });
  }

  it.each(["closed invocation", "fresh manager"] as const)(
    "refuses first-device redemption with a %s and no live binding",
    async (kind) => {
      const connection = await beginConnect();
      const { manager, enrollment, verification } = connection;
      const verify = () =>
        expect(verifyDeviceBootstrapToken(verification)).resolves.toEqual({ ok: true });
      if (kind === "closed invocation") {
        await verify();
        manager.close(enrollment);
      } else {
        manager.stop();
      }
      const authority = kind === "fresh manager" ? createManager() : manager;
      if (kind === "fresh manager") {
        await verify();
      }
      await expect(
        consume(connection, { admitsCloudWorkerSetup: authority.admitsNodeSetupCompletion }),
      ).resolves.toBeNull();
      expect(store.get(environmentId)?.nodeDeviceId).toBeNull();
    },
  );

  function holdResult(type: string) {
    const reached = createDeferredCore();
    const release = createDeferredCore();
    let held = false;
    delivery.afterResult = async (command) => {
      if (command === type && !held) {
        held = true;
        reached.resolve();
        await release.promise;
      }
    };
    return { reached, release };
  }

  async function observeEnsure(onCall: (count: number) => void) {
    const bootstrap = await import("../../infra/device-bootstrap.js");
    const ensure = bootstrap.ensureDevicePairSetupBootstrapToken;
    let calls = 0;
    return vi
      .spyOn(bootstrap, "ensureDevicePairSetupBootstrapToken")
      .mockImplementation((params) => {
        const pending = ensure(params);
        onCall(++calls);
        return pending;
      });
  }

  it("does not revoke a replacement bearer when a superseded ensure returns late", async () => {
    const manager = createManager();
    const { reached: firstIssued, release: releaseFirst } = holdResult("bootstrap.ensure");
    const replacementQueued = createDeferredCore();
    const ensureSpy = await observeEnsure((count) => {
      if (count === 2) {
        replacementQueued.resolve();
      }
    });
    const first = beginConnect(manager);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    let replacement: ReturnType<typeof beginConnect> | undefined;
    try {
      await firstIssued.promise;
      replacement = beginConnect(manager);
      await replacementQueued.promise;
      releaseFirst.resolve();
      await rejected;
      const current = await replacement;

      expect(current.enrollment.signal?.aborted).toBe(false);
      await expect(verifyDeviceBootstrapToken(current.verification)).resolves.toEqual({ ok: true });
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, replacement, rejected]);
      delivery.afterResult = undefined;
      ensureSpy.mockRestore();
    }
  });

  it("refuses a queued old bearer while its replacement has not adopted a credential", async () => {
    const first = await beginConnect();
    const { reached: verified, release: releaseVerification } = holdResult("bootstrap.verify");
    const replacementQueued = createDeferredCore();
    const ensureSpy = await observeEnsure(() => replacementQueued.resolve());
    const verification = verifyDeviceBootstrapToken(first.verification);
    let consumption: ReturnType<typeof consumeDeviceBootstrapTokenWithSetupCompletion> | undefined;
    let replacement: ReturnType<typeof beginConnect> | undefined;
    try {
      await verified.promise;
      consumption = consume(first);
      first.manager.close(first.enrollment);
      replacement = beginConnect(first.manager);
      await replacementQueued.promise;
      releaseVerification.resolve();

      await expect(verification).resolves.toEqual({ ok: true });
      await expect(consumption).resolves.toBeNull();
      const current = await replacement;
      expect(store.get(environmentId)?.nodeDeviceId).toBeNull();
      expect(current.token).not.toBe(first.token);
      expect(current.enrollment.setupId).toBe(first.enrollment.setupId);
      await expect(verifyDeviceBootstrapToken(current.verification)).resolves.toEqual({ ok: true });
    } finally {
      releaseVerification.resolve();
      await Promise.allSettled([verification, consumption, replacement]);
      delivery.afterResult = undefined;
      ensureSpy.mockRestore();
    }
  });

  it("adopts the surviving bearer after restart only for its exact credential digest", async () => {
    const first = await beginConnect();
    first.manager.stop();
    const replacement = await beginConnect();
    expect(replacement.token).toBe(first.token);
    expect(replacement.enrollment.setupId).toBe(first.enrollment.setupId);
    const owner = expectDefined(store.get(environmentId), "worker environment");
    const fact = {
      environmentId: owner.environmentId,
      setupId: replacement.enrollment.setupId,
      provisionOperationId: owner.provisionOperationId,
      ownerEpoch: owner.ownerEpoch,
      credentialDigest: sha256Base64Url(replacement.token),
    };
    expect(replacement.manager.admitsNodeSetupCompletion(fact)).toBe(true);
    expect(
      replacement.manager.admitsNodeSetupCompletion({
        ...fact,
        credentialDigest: sha256Base64Url("different-bootstrap-credential"),
      }),
    ).toBe(false);
    await expect(verifyDeviceBootstrapToken(replacement.verification)).resolves.toEqual({
      ok: true,
    });
    await expect(consume(replacement)).resolves.toMatchObject({ completion: { deviceId } });
    expect(store.get(environmentId)?.nodeDeviceId).toBe(deviceId);
  });

  it("binds the first device only while its enrollment is live and preserves its closed retry", async () => {
    const connection = await beginConnect();
    const { manager, enrollment, verification } = connection;
    await expect(verifyDeviceBootstrapToken(verification)).resolves.toEqual({ ok: true });
    const completedAtMs = Date.now();
    await expect(consume(connection, { completedAtMs })).resolves.toMatchObject({
      completion: { deviceId },
    });
    expect(store.get(environmentId)).toMatchObject({
      nodeSetupId: enrollment.setupId,
      nodeDeviceId: deviceId,
    });
    manager.close(enrollment);

    await expect(verifyDeviceBootstrapToken(verification)).resolves.toEqual({ ok: true });
    await expect(
      consume(connection, { completedAtMs, admitsCloudWorkerSetup: undefined }),
    ).resolves.toMatchObject({
      completion: { deviceId: verification.deviceId, deliveryState: "uncertain" },
    });
  });

  it("rechecks enrollment authority at commit after first-device admission", async () => {
    const connection = await beginConnect();
    const { manager, enrollment, verification } = connection;
    await expect(verifyDeviceBootstrapToken(verification)).resolves.toEqual({ ok: true });
    let admissions = 0;

    await expect(
      consume(connection, {
        admitsCloudWorkerSetup: (fact) => {
          if (++admissions === 2) {
            manager.close(enrollment);
          }
          return manager.admitsNodeSetupCompletion(fact);
        },
      }),
    ).resolves.toBeNull();
    expect(admissions).toBe(2);
    expect(store.get(environmentId)?.nodeDeviceId).toBeNull();
    await expect(verifyDeviceBootstrapToken(verification)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
  });

  async function seedEnrollmentState(
    state: "ready" | "draining" | "destroyed",
    boundDeviceId: string | null,
  ): Promise<string> {
    const id = await ensureSetupId();
    const ssh = boundDeviceId === null;
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
        boundDeviceId,
        "lease-enrollment",
        ssh ? "worker.example.test" : null,
        ssh ? 22 : null,
        ssh ? "openclaw" : null,
        ssh ? "ssh-ed25519 AAAA" : null,
        ssh ? JSON.stringify({ source: "file", provider: "worker-keys", id: "/test-key" }) : null,
        BOOTSTRAP_RECEIPT.bundleHash,
        BOOTSTRAP_RECEIPT.openclawVersion,
        JSON.stringify(BOOTSTRAP_RECEIPT.protocolFeatures),
        "[]",
        id,
      );
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
    return id;
  }

  it.each(["lost pairing result", "delayed inventory result"] as const)(
    "binds setup completion to the exact environment identity across restart (%s)",
    async (mode) => {
      expect(store.hasPendingNodeEnrollmentSetup("", deviceId)).toBe(false);
      expect(store.hasPendingNodeEnrollmentSetup("missing-setup", deviceId)).toBe(false);
      const pending = await store.ensureNodeEnrollment(environmentId);
      const setupId = expectDefined(pending.nodeSetupId, "worker node enrollment setup id");
      expect(setupId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(pending.nodeDeviceId).toBeNull();
      expect((await store.ensureNodeEnrollment(environmentId)).nodeSetupId).toBe(setupId);
      expect(store.hasPendingNodeEnrollmentSetup(setupId, deviceId)).toBe(true);
      expect(store.hasNodeEnrollmentOwner(deviceId)).toBe(false);
      const inventoryVersion = store.inventoryVersion();

      const connection = await beginConnect();
      const { verification } = connection;
      await expect(verifyDeviceBootstrapToken(verification)).resolves.toEqual({ ok: true });
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
            environmentId,
            state: "provisioning",
            error: "Captured before pairing",
          });
          await inventoryCommitted.promise;
        }
        const consumed = consume(connection, { completedAtMs: 10 });
        if (mode === "lost pairing result") {
          await expect(consumed).rejects.toBe(resultFailure);
        } else {
          await consumed;
        }
        releaseInventory.resolve();
        await inventoryResult;

        expect(store.get(environmentId)).toMatchObject({
          nodeSetupId: setupId,
          nodeDeviceId: deviceId,
        });
        expect(store.hasPendingNodeEnrollmentSetup(setupId, deviceId)).toBe(true);
        expect(store.hasPendingNodeEnrollmentSetup(setupId, "different-cloud-device")).toBe(false);
        expect(store.inventoryVersion()).toBeGreaterThan(inventoryVersion);
        expect(store.hasNodeEnrollmentOwner(deviceId)).toBe(true);
        expect(store.hasNodeEnrollmentOwner("different-cloud-device")).toBe(false);
      } finally {
        releaseInventory.resolve();
        await inventoryResult?.catch(() => {});
        delivery.afterResult = undefined;
      }
    },
  );

  it("rejects a destroy-requested provisioning setup", async () => {
    const id = await ensureSetupId();
    expect(store.hasPendingNodeEnrollmentSetup(id, "cloud-device-canceled")).toBe(true);
    const issued = await ensureDevicePairSetupBootstrapToken({
      baseDir: root,
      setupId: id,
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

    await store.requestDestroy({ environmentId, state: "provisioning" });

    expect(store.hasPendingNodeEnrollmentSetup(id, "cloud-device-canceled")).toBe(false);
    await expect(
      consumeDeviceBootstrapTokenWithSetupCompletion({
        baseDir: root,
        token: issued.token,
        deviceId: "cloud-device-canceled",
        completedAtMs: 10,
      }),
    ).rejects.toThrow("Cloud worker setup completion owner is no longer pending");
    expect(store.get(environmentId)?.nodeDeviceId).toBeNull();
  });

  it("rejects first setup-device binding when ready", async () => {
    const setupId = await seedEnrollmentState("ready", null);
    expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-first")).toBe(false);
  });

  it.each(["draining", "destroyed"] as const)(
    "rejects a bound setup device in %s",
    async (state) => {
      const setupId = await seedEnrollmentState(state, "cloud-device-bound");

      expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-bound")).toBe(false);
      expect(store.hasNodeEnrollmentOwner("cloud-device-bound")).toBe(state === "draining");
    },
  );
});
