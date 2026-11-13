import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { deviceProfileEnrollHandler } from "../gateway/server-methods/device-profile-enrollment.js";
import type { GatewayClient } from "../gateway/server-methods/types.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import { dispatchProfile } from "../gateway/server/client-fixtures.test-support.js";
import { createOperatorWsClient } from "../gateway/server/ws-connection/authenticated-request-dispatch.test-support.js";
import {
  ensureCanonicalLocalUserProfile,
  mergeCanonicalUserProfiles,
} from "../state/user-profile-writes.js";
import { useProfileDatabase } from "../state/user-profiles-fixture.test-support.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import {
  resolveNodePairingGeneration,
  resolveAuthenticatedDeviceTokenIdentity,
} from "./device-pairing-identity.js";
import { rotateDeviceToken, revokeDeviceToken } from "./device-pairing-tokens.js";
import { getPairedDevice, requestDevicePairing } from "./device-pairing.js";
import { enrollDeviceProfile } from "./device-profile-enrollment.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

const { options } = useProfileDatabase("device-profile-enrollment-");
let baseDir: string;
const syntheticPublicKey = Buffer.alloc(32, 7).toString("base64url");
beforeEach(async () => {
  baseDir = path.dirname(options.path);
  options.path = path.join(baseDir, "state", "openclaw.sqlite");
  vi.stubEnv("OPENCLAW_STATE_DIR", baseDir);
  const request = await requestDevice(["operator", "node"]);
  await approveDevicePairing(
    request.request.requestId,
    { callerScopes: ["operator.admin"] },
    baseDir,
  );
});
afterEach(() => vi.unstubAllEnvs());

function requestDevice(roles = ["operator"]) {
  return requestDevicePairing(
    { deviceId: "device", publicKey: syntheticPublicKey, roles, scopes: ["operator.read"] },
    baseDir,
  );
}

async function readOperatorGrant() {
  const device = await getPairedDevice("device", baseDir);
  if (!device?.tokens?.operator) {
    throw new Error("Missing operator fixture");
  }
  const identity = resolveAuthenticatedDeviceTokenIdentity(device, {
    role: "operator",
    publicKey: device.publicKey,
    token: device.tokens.operator.token,
    scopes: device.tokens.operator.scopes,
  });
  if (!identity) {
    throw new Error("Missing approved operator fixture");
  }
  return identity;
}
it("enrolls through the RPC without leaking cross-device credentials or admitting synthetic callers", async () => {
  const client: GatewayClient = createOperatorWsClient();
  client.internal = { authenticatedOperator: true, operatorRoleActor: { kind: "system" } };
  client.authenticatedUserProfile = dispatchProfile(GATEWAY_OWNER_PROFILE_ID);
  const context = {
    ...createGatewayRequestContext(makeContextParams()),
    getRuntimeConfig: () => ({}),
  };
  const invoke = async (params: Record<string, unknown>) => {
    const respond = vi.fn();
    await deviceProfileEnrollHandler({
      req: { type: "req", id: "enrollment", method: "device.profile.enroll", params },
      params,
      client,
      context,
      respond,
      isWebchatConnect: () => false,
    });
    return respond;
  };
  const enrollmentId = randomUUID();
  client.internal.syntheticClient = true;
  expect(await invoke({ deviceId: "device", enrollmentId })).toHaveBeenCalledWith(
    false,
    undefined,
    expect.anything(),
  );
  delete client.internal.syntheticClient;
  const cross = await invoke({ deviceId: "device", enrollmentId, name: "Local Person" });
  expect(cross).toHaveBeenCalledWith(
    true,
    { deviceId: "device", profileId: expect.any(String) },
    undefined,
  );
  const profileId = (await getPairedDevice("device", baseDir))?.operatorProfileId;
  expect(profileId).toBeTruthy();
  client.connect.device = {
    id: "device",
    publicKey: syntheticPublicKey,
    signature: "synthetic-signature",
    signedAt: 1,
    nonce: "synthetic-nonce",
  };
  expect(await invoke({ profileId })).toHaveBeenCalledWith(
    true,
    {
      deviceId: "device",
      profileId,
      operatorToken: { token: expect.any(String), scopes: ["operator.read"] },
    },
    undefined,
  );
});

const local = () => ensureCanonicalLocalUserProfile({ enrollmentId: randomUUID() }, options);

it("publishes the association, replaces only operator credentials, and makes repeats idempotent", async () => {
  const profile = await local();
  const before = await getPairedDevice("device", baseDir);
  const replaced = vi.fn();
  const enroll = async (profileId: string) =>
    enrollDeviceProfile(
      { deviceId: "device", profileId, expectedOperator: await readOperatorGrant() },
      { baseDir, assertCurrent: () => {}, onTokensReplaced: replaced },
    );
  const result = await enroll(profile.id);
  const stored = await getPairedDevice("device", baseDir);
  expect(stored?.operatorProfileId).toBe(profile.id);
  expect(result.operatorToken.token).not.toBe(before?.tokens?.operator?.token);
  expect(result.operatorToken.scopes).toEqual(["operator.read"]);
  expect(stored?.tokens?.node).toEqual(before?.tokens?.node);
  expect(replaced).toHaveBeenCalledExactlyOnceWith("device", ["operator"]);
  const repeated = await enroll(profile.id);
  expect(repeated.replaced).toBe(false);
  // Persisted JSON omits absent lifecycle fields; the committed credential is authoritative.
  expect(repeated.operatorToken).toEqual(stored?.tokens?.operator);
  expect(repeated.operatorToken.token).toBe(result.operatorToken.token);
  expect(replaced).toHaveBeenCalledTimes(1);
  const next = await local();
  const changed = await enroll(next.id);
  expect(changed.operatorToken.token).not.toBe(result.operatorToken.token);
  expect((await getPairedDevice("device", baseDir))?.tokens?.node).toEqual(before?.tokens?.node);
});

it("rolls back enrollment when requester authority ends before commit", async () => {
  const profile = await local();
  const expectedOperator = await readOperatorGrant();
  const before = await getPairedDevice("device", baseDir);
  let committing = false;
  const observer = probe.admission(workerAdmission, (request, grant, admit) => {
    committing = request.stage === "commit";
    admit(request, grant);
  });
  try {
    await expect(
      enrollDeviceProfile(
        { deviceId: "device", profileId: profile.id, expectedOperator },
        {
          baseDir,
          assertCurrent: () => {
            if (committing) {
              throw new Error("Synthetic requester revoked");
            }
          },
        },
      ),
    ).rejects.toThrow("Synthetic requester revoked");
    expect(committing).toBe(true);
    expect(await getPairedDevice("device", baseDir)).toEqual(before);
  } finally {
    observer.mockRestore();
  }
});

it("refuses stale grants, revoked operators, missing/merged profiles, and SharedOwner", async () => {
  const profile = await local();
  const stale = await readOperatorGrant();
  await rotateDeviceToken({ deviceId: "device", role: "operator", baseDir });
  const enroll = (profileId: string, expectedOperator = stale) =>
    enrollDeviceProfile(
      { deviceId: "device", profileId, expectedOperator },
      { baseDir, assertCurrent: () => {} },
    );
  await expect(enroll(profile.id)).rejects.toThrow();
  const current = await readOperatorGrant();
  await expect(enroll(GATEWAY_OWNER_PROFILE_ID, current)).rejects.toThrow();
  await expect(enroll("missing-profile", current)).rejects.toThrow();
  const target = await local();
  await mergeCanonicalUserProfiles(profile.id, target.id, options);
  await expect(enroll(profile.id, current)).rejects.toThrow();
  await revokeDeviceToken({ deviceId: "device", role: "operator", baseDir });
  await expect(enroll(target.id, current)).rejects.toThrow();
  expect((await getPairedDevice("device", baseDir))?.operatorProfileId).toBeUndefined();
});

it("publishes the selected person with pairing approval while leaving the node sibling intact", async () => {
  const person = await ensureCanonicalLocalUserProfile(
    { enrollmentId: randomUUID(), name: "Pairing Person" },
    options,
  );
  const before = await getPairedDevice("device", baseDir);
  const request = await requestDevice();
  const approved = await approveDevicePairing(
    request.request.requestId,
    { callerScopes: ["operator.admin"], operatorProfileId: person.id },
    baseDir,
  );
  expect(approved).toMatchObject({ status: "approved", device: { operatorProfileId: person.id } });
  const after = await getPairedDevice("device", baseDir);
  expect(after?.operatorProfileId).toBe(person.id);
  expect(after?.tokens?.operator?.token).not.toBe(before?.tokens?.operator?.token);
  expect(after?.tokens?.node).toEqual(before?.tokens?.node);
  expect(resolveNodePairingGeneration(after)).toEqual(resolveNodePairingGeneration(before));
  for (const profileId of [GATEWAY_OWNER_PROFILE_ID, "missing-person"]) {
    const pending = await requestDevice();
    await expect(
      approveDevicePairing(
        pending.request.requestId,
        { callerScopes: ["operator.admin"], operatorProfileId: profileId },
        baseDir,
      ),
    ).rejects.toThrow();
    expect(await getPairedDevice("device", baseDir)).toEqual(after);
  }
});
