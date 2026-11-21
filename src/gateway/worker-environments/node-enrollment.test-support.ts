import { expect } from "vitest";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  ensureDevicePairSetupBootstrapToken,
  verifyDeviceBootstrapToken,
} from "../../infra/device-bootstrap.js";
import { CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../../shared/device-bootstrap-profile.js";
import type { WorkerEnvironmentStore } from "./store.js";

/** Lifecycle fixtures admit their exact setup through the real pairing worker. */
export async function completeWorkerNodeSetupForTest(params: {
  baseDir: string;
  store: WorkerEnvironmentStore;
  setupId: string;
  deviceId: string;
  completedAtMs: number;
}): Promise<void> {
  const record = params.store.list().find((entry) => entry.nodeSetupId === params.setupId);
  if (!record) {
    throw new Error("Expected an environment owning the fixture setup");
  }
  const issued = await ensureDevicePairSetupBootstrapToken({
    baseDir: params.baseDir,
    setupId: params.setupId,
    profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  });
  if (issued.status !== "pending") {
    throw new Error("Expected a pending fixture setup");
  }
  await expect(
    verifyDeviceBootstrapToken({
      baseDir: params.baseDir,
      token: issued.token,
      deviceId: params.deviceId,
      publicKey: `fixture-public-key:${params.deviceId}`,
      role: "node",
      scopes: [],
    }),
  ).resolves.toEqual({ ok: true });
  await expect(
    consumeDeviceBootstrapTokenWithSetupCompletion({
      baseDir: params.baseDir,
      token: issued.token,
      deviceId: params.deviceId,
      completedAtMs: params.completedAtMs,
      admitsCloudWorkerSetup: (fact) =>
        fact.environmentId === record.environmentId &&
        fact.setupId === params.setupId &&
        fact.provisionOperationId === record.provisionOperationId &&
        fact.ownerEpoch === record.ownerEpoch,
    }),
  ).resolves.toMatchObject({
    completion: { setupId: params.setupId, deviceId: params.deviceId },
  });
}
