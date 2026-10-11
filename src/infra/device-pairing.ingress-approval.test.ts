import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { getPairedDevice, listDevicePairing, requestDevicePairing } from "./device-pairing.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-ingress-pairing-" });
let baseDir = "";

function requestPairing(request: Partial<Parameters<typeof requestDevicePairing>[0]>) {
  return requestDevicePairing(
    { deviceId: "device-1", publicKey: "public-key-1", ...request },
    baseDir,
  );
}

function requestOperator(scopes: string[]) {
  return requestPairing({ role: "operator", scopes });
}

async function approveProxy(
  requestId: string,
  scopes: string[],
  approvedVia: "trusted-proxy" | "remote-ingress" = "trusted-proxy",
) {
  return approveDevicePairing(
    requestId,
    { callerScopes: scopes, approvedVia, autoApproveNewDeviceScopes: scopes },
    baseDir,
  );
}

async function setupProxyDevice(approvedVia: "trusted-proxy" | "remote-ingress" = "trusted-proxy") {
  const initial = await requestOperator(["operator.read"]);
  await approveProxy(initial.request.requestId, ["operator.read"], approvedVia);
}

describe("device pairing ingress approval", () => {
  beforeAll(async () => {
    baseDir = await suiteRootTracker.setup();
  });

  beforeEach(() => {
    persistDevicePairingStoreState({ pendingById: {}, pairedByDeviceId: {} }, baseDir, "both");
  });

  afterAll(async () => {
    await closeStateDatabaseForTest();
    await suiteRootTracker.cleanup();
  });

  test.each(["trusted-proxy", "remote-ingress"] as const)(
    "caps %s grants and upgrades same-key re-requests",
    async (approvedVia) => {
      const initial = await requestOperator(["operator.read", "operator.write"]);
      await expect(
        approveProxy(initial.request.requestId, ["operator.read"], approvedVia),
      ).resolves.toMatchObject({ status: "approved", requestId: initial.request.requestId });
      expect(await getPairedDevice("device-1", baseDir)).toMatchObject({
        approvedScopes: ["operator.read"],
        approvedVia,
      });
      const upgrade = await requestOperator(["operator.read", "operator.write"]);
      await expect(
        approveProxy(upgrade.request.requestId, ["operator.read", "operator.write"], approvedVia),
      ).resolves.toMatchObject({ status: "approved", requestId: upgrade.request.requestId });
      expect((await listDevicePairing(baseDir)).pending).toEqual([]);
      expect((await getPairedDevice("device-1", baseDir))?.approvedScopes).toEqual([
        "operator.read",
        "operator.write",
      ]);
    },
  );

  test.each(["trusted-proxy", "remote-ingress"] as const)(
    "refuses %s auto-approval when the pending key mismatches the paired device",
    async (approvedVia) => {
      await setupProxyDevice(approvedVia);
      const repair = await requestPairing({
        publicKey: "public-key-1-rotated",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      });
      await expect(
        approveProxy(repair.request.requestId, ["operator.read", "operator.write"], approvedVia),
      ).resolves.toBeNull();
      expect((await listDevicePairing(baseDir)).pending).toContainEqual(
        expect.objectContaining({ requestId: repair.request.requestId, isRepair: true }),
      );
      expect((await getPairedDevice("device-1", baseDir))?.approvedScopes).toEqual([
        "operator.read",
      ]);
    },
  );

  test("refuses non-trusted-proxy auto-approval for a known device even with a matching key", async () => {
    await setupProxyDevice();
    const upgrade = await requestOperator(["operator.read", "operator.write"]);
    await expect(
      approveDevicePairing(
        upgrade.request.requestId,
        {
          callerScopes: ["operator.read", "operator.write"],
          approvedVia: "silent",
          autoApproveNewDeviceScopes: ["operator.read", "operator.write"],
        },
        baseDir,
      ),
    ).resolves.toBeNull();
    expect((await getPairedDevice("device-1", baseDir))?.approvedScopes).toEqual(["operator.read"]);
  });

  test.each(["trusted-proxy", "remote-ingress"] as const)(
    "refuses %s auto-approval for a merged node and operator request",
    async (approvedVia) => {
      await requestPairing({ role: "node", scopes: [] });
      const browser = await requestOperator(["operator.read"]);
      expect(browser.request.roles).toEqual(["node", "operator"]);
      await expect(
        approveProxy(browser.request.requestId, ["operator.read"], approvedVia),
      ).resolves.toBeNull();
      await expect(getPairedDevice("device-1", baseDir)).resolves.toBeNull();
      expect((await listDevicePairing(baseDir)).pending).toContainEqual(
        expect.objectContaining({
          requestId: browser.request.requestId,
          roles: ["node", "operator"],
        }),
      );
    },
  );
});
