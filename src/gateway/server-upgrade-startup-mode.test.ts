import { expect, it } from "vitest";
import { isGatewayRestrictedUpgradeStartup } from "./server-upgrade-startup-mode.js";

it("keeps maintenance and copied-state canary explicit and separate from ordinary startup", () => {
  expect(isGatewayRestrictedUpgradeStartup({})).toBe(false);
  expect(isGatewayRestrictedUpgradeStartup({ upgradeMaintenance: false })).toBe(false);
  expect(isGatewayRestrictedUpgradeStartup({ updateCanary: false })).toBe(false);
  expect(isGatewayRestrictedUpgradeStartup({ updateCanary: true })).toBe(true);
  expect(isGatewayRestrictedUpgradeStartup({ upgradeMaintenance: true })).toBe(true);
  expect(isGatewayRestrictedUpgradeStartup({ upgradeMaintenance: { owner: "native" } })).toBe(true);
});
