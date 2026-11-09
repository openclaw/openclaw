import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import { getPairedDevice, listDevicePairing, requestDevicePairing } from "./device-pairing.js";

const DEVICE_ID = "device-cli";
const PUBLIC_KEY = "public-key-cli";
const broadScopes = ["operator.admin", "operator.pairing", "operator.read", "operator.write"];
const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-device-pairing-churn-" });
let baseDir: string;

function requestOperator(scopes: string[]) {
  return requestDevicePairing(
    { deviceId: DEVICE_ID, publicKey: PUBLIC_KEY, role: "operator", scopes },
    baseDir,
  );
}
function approve(requestId: string, callerScopes: string[]) {
  return approveDevicePairing(requestId, { callerScopes }, baseDir);
}
async function approveInitial(scopes: string[]) {
  const { request } = await requestOperator(scopes);
  await approve(request.requestId, scopes);
}
async function expectGrant(scopes: string[], exact = true) {
  expect(await getPairedDevice(DEVICE_ID, baseDir)).toMatchObject({
    publicKey: PUBLIC_KEY,
    approvedScopes: exact ? scopes : expect.arrayContaining(scopes),
    tokens: { operator: { scopes: normalizeDeviceAuthScopes(scopes) } },
  });
}

describe("device pairing requestId churn", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });
  beforeEach(async () => {
    baseDir = await suiteRootTracker.make("case");
  });
  afterAll(async () => {
    await closeStateDatabaseForTest();
    await suiteRootTracker.cleanup();
  });

  test("supersedes a stale read repair when devices approve reconnects with broader scopes", async () => {
    await approveInitial(["operator.pairing"]);
    await expectGrant(["operator.pairing"]);
    const readRepair = await requestOperator(["operator.read"]);
    expect(readRepair.request).toMatchObject({ isRepair: true, scopes: ["operator.read"] });
    expect((await listDevicePairing(baseDir)).pending).toHaveLength(1);

    // Approval reconnect supersedes the read repair, but a stale approval cannot widen its grant.
    const reconnect = await requestOperator(["operator.pairing", "operator.read"]);
    expect(reconnect).toMatchObject({
      created: true,
      superseded: [{ requestId: readRepair.request.requestId, deviceId: DEVICE_ID }],
    });
    expect(reconnect.request.requestId).not.toBe(readRepair.request.requestId);
    await expect(
      approve(readRepair.request.requestId, ["operator.pairing", "operator.read"]),
    ).resolves.toBeNull();
    await expectGrant(["operator.pairing"]);
    expect((await listDevicePairing(baseDir)).pending).toEqual([
      expect.objectContaining({
        requestId: reconnect.request.requestId,
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
        role: "operator",
        scopes: expect.arrayContaining(["operator.pairing", "operator.read"]),
      }),
    ]);
  });

  test.each([
    {
      label: "explicit subset",
      scopes: broadScopes,
      expected: expect.arrayContaining(broadScopes),
    },
    { label: "admin implication", scopes: ["operator.admin"], expected: ["operator.admin"] },
  ])(
    "keeps the requestId for a pairing reconnect covered by $label",
    async ({ scopes, expected }) => {
      const broad = await requestOperator(scopes);
      expect(broad.created).toBe(true);
      const reconnect = await requestOperator(["operator.pairing"]);
      expect(reconnect).toMatchObject({
        created: false,
        request: { requestId: broad.request.requestId, scopes: expected },
      });
      expect((await listDevicePairing(baseDir)).pending).toEqual([
        expect.objectContaining({ requestId: broad.request.requestId }),
      ]);
      await expect(approve(broad.request.requestId, ["operator.admin"])).resolves.toMatchObject({
        status: "approved",
      });
    },
  );

  test("supports cron-first progressive operator escalation from read to pairing to admin", async () => {
    await approveInitial(["operator.read"]);
    await expectGrant(["operator.read"]);
    const pairingRepair = await requestOperator(["operator.pairing"]);
    await expect(
      approve(pairingRepair.request.requestId, ["operator.read", "operator.pairing"]),
    ).resolves.toMatchObject({ status: "approved" });
    expect((await listDevicePairing(baseDir)).pending).toHaveLength(0);
    await expectGrant(["operator.read", "operator.pairing"], false);

    const adminRepair = await requestOperator(["operator.admin"]);
    await expect(approve(adminRepair.request.requestId, ["operator.admin"])).resolves.toMatchObject(
      { status: "approved" },
    );
    expect((await listDevicePairing(baseDir)).pending).toHaveLength(0);
    await expectGrant(["operator.admin", "operator.pairing", "operator.read"], false);
  });
});
