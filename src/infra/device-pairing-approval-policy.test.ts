import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { ensureCanonicalLocalUserProfile } from "../state/user-profile-writes.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { approveBootstrapDevicePairing, approveDevicePairing } from "./device-pairing-approval.js";
import { mutatePairedDevice } from "./device-pairing-fixtures.test-support.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import {
  ensureDeviceToken,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./device-pairing-tokens.js";
import {
  getPairedDevice,
  listDevicePairing,
  removePairedDevice,
  requestDevicePairing,
  updatePairedDeviceMetadata,
} from "./device-pairing.js";

const roots = createSuiteTempRootTracker({ prefix: "openclaw-pairing-approval-policy-" });
const operator = { deviceId: "browser", role: "operator", scopes: ["operator.read"] };
const caller = { callerScopes: operator.scopes };
const profile = { roles: [operator.role], scopes: operator.scopes };
const requestOperator = (baseDir: string) =>
  requestDevicePairing({ ...operator, publicKey: "browser-key" }, baseDir);
const issueToken = (baseDir: string, generation: string, isIssuanceCurrent?: () => boolean) => {
  vi.stubEnv("OPENCLAW_STATE_DIR", baseDir);
  return ensureDeviceToken({
    ...operator,
    issuer: { kind: "shared-gateway-auth", generation },
    isIssuanceCurrent,
  });
};

async function withHeldPairingLock(work: (unlock: () => Promise<void>) => Promise<void>) {
  const gate = createEnteredGate();
  const holding = withDevicePairingLock(gate.wait);
  await gate.entered;
  const unlock = async () => {
    gate.release();
    await holding;
  };
  try {
    await work(unlock);
  } finally {
    await unlock();
  }
}

beforeAll(() => roots.setup());
afterAll(async () => {
  await closeStateDatabaseForTest();
  await roots.cleanup();
});

it("preserves the current token when a stale handshake waits for the issuance lock", async () => {
  const baseDir = await roots.make();
  const pending = await requestOperator(baseDir);
  await approveDevicePairing(pending.request.requestId, caller, baseDir);
  const original = await issueToken(baseDir, "current");
  assert(original);
  let allowed = true;
  await withHeldPairingLock(async (unlock) => {
    const issuing = issueToken(baseDir, "stale", () => allowed);
    allowed = false;
    await unlock();
    expect(Boolean(await issuing)).toBe(false);
    const current = await getPairedDevice("browser", baseDir);
    expect(current?.tokens?.operator).toMatchObject({
      token: original.token,
      issuer: { generation: "current" },
    });
  });
});

it.each(["owner", "bootstrap"] as const)("refuses stale %s approval", async (lane) => {
  const baseDir = await roots.make();
  const pending = await requestOperator(baseDir);
  let allowed = true;
  const options = { isApprovalCurrent: () => allowed };
  const approve = () =>
    lane === "bootstrap"
      ? approveBootstrapDevicePairing(pending.request.requestId, profile, options, baseDir)
      : approveDevicePairing(pending.request.requestId, { ...options, ...caller }, baseDir);
  await withHeldPairingLock(async (unlock) => {
    const approval = approve();
    allowed = false;
    await unlock();

    await expect(approval).resolves.toEqual({
      status: "forbidden",
      reason: "approval-policy-changed",
    });
    await expect(getPairedDevice("browser", baseDir)).resolves.toBeNull();
    expect((await listDevicePairing(baseDir)).pending.map((entry) => entry.requestId)).toEqual([
      pending.request.requestId,
    ]);

    allowed = true;
    await expect(approve()).resolves.toMatchObject({ status: "approved" });
  });
});

it.each(["owner", "bootstrap"] as const)(
  "preserves personal association only for the same installation through %s approval",
  async (lane) => {
    const baseDir = await roots.make();
    const pending = await requestOperator(baseDir);
    await approveDevicePairing(pending.request.requestId, caller, baseDir);
    const person = await ensureCanonicalLocalUserProfile(
      { enrollmentId: randomUUID() },
      { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } },
    );
    await mutatePairedDevice(baseDir, operator.deviceId, (device) => {
      device.operatorProfileId = person.id;
    });
    const approve = (requestId: string) =>
      lane === "bootstrap"
        ? approveBootstrapDevicePairing(requestId, profile, {}, baseDir)
        : approveDevicePairing(requestId, caller, baseDir);
    const repair = await requestOperator(baseDir);
    expect(await approve(repair.request.requestId)).toMatchObject({ status: "approved" });
    expect((await getPairedDevice(operator.deviceId, baseDir))?.operatorProfileId).toBe(person.id);
    const tokenInput = { deviceId: operator.deviceId, role: operator.role, baseDir, ...caller };
    expect(await rotateDeviceToken({ ...tokenInput, scopes: operator.scopes })).toMatchObject({
      ok: true,
    });
    expect(await revokeDeviceToken(tokenInput)).toMatchObject({ ok: true });
    const reconnectMetadata = {
      displayName: "Reconnected",
      operatorProfileId: "untrusted-profile",
    };
    await updatePairedDeviceMetadata(operator.deviceId, reconnectMetadata, baseDir);
    expect((await getPairedDevice(operator.deviceId, baseDir))?.operatorProfileId).toBe(person.id);
    const replacement = await requestDevicePairing(
      { ...operator, publicKey: "replacement-key" },
      baseDir,
    );
    expect(await approve(replacement.request.requestId)).toMatchObject({ status: "approved" });
    expect(await getPairedDevice(operator.deviceId, baseDir)).not.toHaveProperty(
      "operatorProfileId",
    );
    await removePairedDevice(operator.deviceId, baseDir);
    expect(await getPairedDevice(operator.deviceId, baseDir)).toBeNull();
  },
);
