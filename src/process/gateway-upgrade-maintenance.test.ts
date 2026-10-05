import { afterEach, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  beginGatewayUpgradeMaintenance,
  getGatewayUpgradeMaintenanceBinding,
  isGatewaySubordinateWorkAdmissionClosed,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
  tryBeginGatewayRestartStartupRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
  type GatewayUpgradeMaintenanceOwner,
} from "./gateway-work-admission.js";

let retainedOwner: GatewayUpgradeMaintenanceOwner | undefined;
afterEach(async () => {
  resetGatewayWorkAdmission();
  if (retainedOwner && getGatewayUpgradeMaintenanceBinding()) {
    retainedOwner.assertCurrent = () => {};
    retainedOwner.verifyCommitIntent = async () => {};
    await beginGatewayUpgradeMaintenance(retainedOwner).commit();
  }
  retainedOwner = undefined;
  resetGatewayWorkAdmission();
});
function owner(): GatewayUpgradeMaintenanceOwner {
  return (retainedOwner = {
    binding: {
      protocol: 1,
      runId: "run",
      planDigest: "a".repeat(64),
      targetArtifactId: "target",
      installationKey: "/install",
      stateRootKey: "/state",
    },
    assertCurrent: () => {},
    verifyCommitIntent: async () => {},
  });
}

it("retains maintenance exclusion through suspension release and lifecycle reset", async () => {
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  const authority = owner();
  const maintenance = beginGatewayUpgradeMaintenance(authority);
  expect(suspension?.release()).toBe(true);
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
  expect(tryBeginGatewayRestartStartupRootWorkAdmission()).toBeNull();
  resetGatewayWorkAdmission();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  await expect(maintenance.commit()).rejects.toThrow("authority changed");
  await beginGatewayUpgradeMaintenance(authority).commit();
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
});

it("does not admit maintenance over unsettled work or another owner", () => {
  const root = tryBeginGatewayRootWorkAdmission();
  const authority = owner();
  expect(() => beginGatewayUpgradeMaintenance(authority)).toThrow("settled business work");
  root?.release();
  beginGatewayUpgradeMaintenance(authority);
  expect(() => beginGatewayUpgradeMaintenance({ ...authority })).toThrow("another executor");
});

it("checks live authority after durable verification and leaves lost custody closed", async () => {
  const verified = createDeferredCore();
  let current = true;
  const authority = owner();
  authority.assertCurrent = () => {
    if (!current) {
      throw new Error("executor lost");
    }
  };
  authority.verifyCommitIntent = () => verified.promise;
  const committing = beginGatewayUpgradeMaintenance(authority).commit();
  current = false;
  verified.resolve();
  await expect(committing).rejects.toThrow("executor lost");
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
});

it("reset cannot release an in-flight verified commit", async () => {
  const verified = createDeferredCore();
  const authority = owner();
  authority.verifyCommitIntent = () => verified.promise;
  const committing = beginGatewayUpgradeMaintenance(authority).commit();
  resetGatewayWorkAdmission();
  verified.resolve();
  await expect(committing).rejects.toThrow("authority changed");
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
});

it("commit cannot bypass an independent prepared suspension", async () => {
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  await beginGatewayUpgradeMaintenance(owner()).commit();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(suspension?.release()).toBe(true);
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
});

it("failed activation closes new admission even after executor loss and accepted work", async () => {
  const authority = owner();
  const maintenance = beginGatewayUpgradeMaintenance(authority);
  await maintenance.commit();
  const accepted = tryBeginGatewayRootWorkAdmission();
  expect(accepted).not.toBeNull();
  authority.assertCurrent = () => {
    throw new Error("executor lost");
  };
  maintenance.failClosed();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
  resetGatewayWorkAdmission();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  accepted?.release();
});
