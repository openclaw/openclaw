import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { getPairedDevice, listDevicePairing, requestDevicePairing } from "./device-pairing.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-ingress-pairing-" });
let baseDir = "";
const read = ["operator.read"];
const readWrite = ["operator.read", "operator.write"];
const paired = () => getPairedDevice("device-1", baseDir);
const pending = async () => (await listDevicePairing(baseDir)).pending;
const expectScopes = async (approvedScopes: string[]) =>
  expect((await paired())?.approvedScopes).toEqual(approvedScopes);
const expectPending = async (requestId: string, fields: object) =>
  expect(await pending()).toContainEqual(expect.objectContaining({ requestId, ...fields }));

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
  const initial = await requestOperator(read);
  await approveProxy(initial.request.requestId, read, approvedVia);
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
      const initial = await requestOperator(readWrite);
      await expect(
        approveProxy(initial.request.requestId, read, approvedVia),
      ).resolves.toMatchObject({ status: "approved", requestId: initial.request.requestId });
      expect(await paired()).toMatchObject({ approvedScopes: read, approvedVia });
      const upgrade = await requestOperator(readWrite);
      await expect(
        approveProxy(upgrade.request.requestId, readWrite, approvedVia),
      ).resolves.toMatchObject({ status: "approved", requestId: upgrade.request.requestId });
      expect(await pending()).toEqual([]);
      await expectScopes(readWrite);
    },
  );

  test.each(["trusted-proxy", "remote-ingress"] as const)(
    "refuses %s auto-approval when the pending key mismatches the paired device",
    async (approvedVia) => {
      await setupProxyDevice(approvedVia);
      const repair = await requestPairing({
        publicKey: "public-key-1-rotated",
        role: "operator",
        scopes: readWrite,
      });
      await expect(
        approveProxy(repair.request.requestId, readWrite, approvedVia),
      ).resolves.toBeNull();
      await expectPending(repair.request.requestId, { isRepair: true });
      await expectScopes(read);
    },
  );

  test("refuses non-trusted-proxy auto-approval for a known device even with a matching key", async () => {
    await setupProxyDevice();
    const upgrade = await requestOperator(readWrite);
    await expect(
      approveDevicePairing(
        upgrade.request.requestId,
        {
          callerScopes: readWrite,
          approvedVia: "silent",
          autoApproveNewDeviceScopes: readWrite,
        },
        baseDir,
      ),
    ).resolves.toBeNull();
    await expectScopes(read);
  });

  test.each(["trusted-proxy", "remote-ingress"] as const)(
    "refuses %s auto-approval for a merged node and operator request",
    async (approvedVia) => {
      await requestPairing({ role: "node", scopes: [] });
      const browser = await requestOperator(read);
      expect(browser.request.roles).toEqual(["node", "operator"]);
      await expect(approveProxy(browser.request.requestId, read, approvedVia)).resolves.toBeNull();
      await expect(paired()).resolves.toBeNull();
      await expectPending(browser.request.requestId, { roles: ["node", "operator"] });
    },
  );
});
