import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Base64Url } from "../../infra/crypto-digest.js";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  verifyDeviceBootstrapToken,
} from "../../infra/device-bootstrap.js";
import { decodePairingSetupCode } from "../../pairing/setup-code.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import {
  createEnvironmentStoreFixture,
  writePlacementEnvironmentFixture,
} from "./placement-test-fixtures.js";
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

  function seedEnrollmentState(
    state: "ready" | "draining" | "destroyed",
    boundDeviceId: string | null,
  ): string {
    const nodeSetupId = "state-setup";
    const { sshEndpoint, bootstrapReceipt } = createEnvironmentStoreFixture({
      getStore: () => store,
      getDatabase: () => database,
      now: () => 1_000,
    });
    writePlacementEnvironmentFixture(database, {
      environmentId: "state-enrollment",
      state,
      ownerEpoch: 1,
      attachedSessionIds: [],
      nodeSetupId,
      nodeDeviceId: boundDeviceId,
      bootstrapReceipt,
      ...(boundDeviceId ? {} : { sshEndpoint }),
    });
    return nodeSetupId;
  }

  it.each(["lost pairing result", "delayed inventory result"] as const)(
    "binds setup completion to the exact environment identity across restart (%s)",
    async (mode) => {
      expect(store.hasPendingNodeEnrollmentSetup("", deviceId)).toBe(false);
      const pending = await store.ensureNodeEnrollment(environmentId);
      const setupId = expectDefined(pending.nodeSetupId, "worker node enrollment setup id");
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
        expect(store.inventoryVersion()).toBeGreaterThan(inventoryVersion);
        expect(store.hasNodeEnrollmentOwner(deviceId)).toBe(true);
      } finally {
        releaseInventory.resolve();
        await inventoryResult?.catch(() => {});
        delivery.afterResult = undefined;
      }
    },
  );

  it("rejects first setup-device binding when ready", async () => {
    const setupId = seedEnrollmentState("ready", null);
    expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-first")).toBe(false);
  });

  it.each(["draining", "destroyed"] as const)(
    "rejects a bound setup device in %s",
    async (state) => {
      const setupId = seedEnrollmentState(state, "cloud-device-bound");

      expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-bound")).toBe(false);
      expect(store.hasNodeEnrollmentOwner("cloud-device-bound")).toBe(state === "draining");
    },
  );
});
