import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/io.js";
import { devicePairSetupHandlers } from "../gateway/server-methods/device-pair-setup.js";
import type { GatewayClient } from "../gateway/server-methods/types.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import { dispatchProfile } from "../gateway/server/client-fixtures.test-support.js";
import { createOperatorWsClient } from "../gateway/server/ws-connection/authenticated-request-dispatch.test-support.js";
import { issueGatewayConnectDeviceTokens } from "../gateway/server/ws-connection/connect-device-tokens.js";
import type { AuthenticatedGatewayConnect } from "../gateway/server/ws-connection/message-handler-types.js";
import { decodePairingSetupCode } from "../pairing/setup-code.js";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE as mobile,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE as nodeOnly,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE as voice,
  isMobilePairingSetupBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import { listProfiles } from "../state/user-profile-reads.js";
import {
  ensureCanonicalLocalUserProfile,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { useProfileDatabase } from "../state/user-profiles-fixture.test-support.js";
import {
  getBoundDeviceBootstrapContext,
  issueDevicePairSetupBootstrapToken,
  ensureDevicePairSetupBootstrapToken,
  revokeDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "./device-bootstrap.js";
import { approveBootstrapDevicePairing } from "./device-pairing-approval.js";
import type { DeviceBootstrapApprovalOptions } from "./device-pairing-core.types.js";
import { ensureDeviceToken, rotateDeviceToken } from "./device-pairing-tokens.js";
import { getPairedDevice, requestDevicePairing } from "./device-pairing.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

const { options } = useProfileDatabase("bootstrap-person-");
let baseDir: string;
beforeEach(() => {
  baseDir = path.dirname(options.path);
  options.path = path.join(baseDir, "state", "openclaw.sqlite");
  vi.stubEnv("OPENCLAW_STATE_DIR", baseDir);
  setRuntimeConfigSnapshot({});
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});
const applyReaderConfig = () =>
  setRuntimeConfigSnapshot({
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
        },
      },
    },
  });

const local = () => ensureCanonicalLocalUserProfile({ enrollmentId: randomUUID() }, options);
async function issuedPerson(profileId?: string) {
  const issued = await issueDevicePairSetupBootstrapToken({
    baseDir,
    profile: { ...mobile, ...(profileId !== undefined ? { operatorProfileId: profileId } : {}) },
  });
  const source = {
    token: issued.token,
    deviceId: "mobile-device",
    publicKey: "synthetic-mobile-key",
  };
  expect(
    await verifyDeviceBootstrapToken({ ...source, baseDir, role: "node", scopes: [] }),
  ).toEqual({ ok: true });
  const bound = await getBoundDeviceBootstrapContext({ ...source, baseDir });
  if (!bound) {
    throw new Error("Expected exact bootstrap fixture source");
  }
  const request = await requestDevicePairing(
    {
      deviceId: source.deviceId,
      publicKey: source.publicKey,
      role: "node",
      roles: ["node", "operator"],
      scopes: bound.profile.scopes,
    },
    baseDir,
  );
  return { source, profile: bound.profile, requestId: request.request.requestId };
}

function approveHandoff(
  handoff: Awaited<ReturnType<typeof issuedPerson>>,
  approvalOptions: DeviceBootstrapApprovalOptions = {},
) {
  return approveBootstrapDevicePairing(
    handoff.requestId,
    handoff.profile,
    { bootstrapSource: handoff.source, ...approvalOptions },
    baseDir,
  );
}

it("retains the exact person and named-role scope ceiling for node-first operator grants", async () => {
  applyReaderConfig();
  const person = await local();
  const handoff = await issuedPerson(person.id);
  expect(handoff.profile).toMatchObject({
    operatorProfileId: person.id,
    scopes: ["operator.read"],
  });
  expect(isMobilePairingSetupBootstrapProfile(handoff.profile)).toBe(true);
  expect(await approveHandoff(handoff)).toMatchObject({ status: "approved" });
  const paired = await getPairedDevice("mobile-device", baseDir);
  expect(paired?.operatorProfileId).toBe(person.id);
  expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  expect(paired?.tokens?.node?.scopes).toEqual([]);
  const node = paired?.tokens?.node;
  expect(
    await ensureDeviceToken({
      deviceId: "mobile-device",
      role: "operator",
      scopes: ["operator.read"],
    }),
  ).toMatchObject({ token: paired?.tokens?.operator?.token });
  await rotateDeviceToken({
    deviceId: "mobile-device",
    role: "operator",
    scopes: ["operator.read"],
    baseDir,
  });
  expect((await getPairedDevice("mobile-device", baseDir))?.tokens?.node).toEqual(node);
  expect((await getPairedDevice("mobile-device", baseDir))?.operatorProfileId).toBe(person.id);
});

it("narrows only the operator sibling when a new person-bound handoff has a reduced named-role ceiling", async () => {
  const person = await local();
  const original = await issuedPerson(person.id);
  await approveHandoff(original);
  const before = await getPairedDevice("mobile-device", baseDir);
  applyReaderConfig();
  const narrowed = await issuedPerson(person.id);
  const state: AuthenticatedGatewayConnect = {
    authPolicy: { generation: "synthetic-policy", grantGeneration: "synthetic-grant" },
    resolvedAuth: { mode: "token", allowTailscale: false },
    minProtocol: 4,
    maxProtocol: 4,
    usesLegacyNodeProtocol: false,
    role: "node",
    scopes: [],
    hasRequestedScopes: true,
    isControlUi: false,
    isBrowserOperatorUi: false,
    isWebchat: false,
    isNativeAppUi: true,
    startupPending: false,
    device: {
      id: narrowed.source.deviceId,
      publicKey: narrowed.source.publicKey,
      signature: "synthetic-signature",
      signedAt: 1,
      nonce: "synthetic-nonce",
    },
    devicePublicKey: narrowed.source.publicKey,
    deviceAuthPayloadVersion: "v3",
    hasTokenAuth: false,
    hasPasswordAuth: false,
    bootstrapTokenCandidate: narrowed.source.token,
    authResult: { ok: true, method: "bootstrap-token" },
    authMethod: "bootstrap-token",
    pairingLocality: "remote",
    sessionUsesSharedGatewayAuth: false,
    issuedBootstrapProfile: narrowed.profile,
    handoffBootstrapProfile: narrowed.profile,
    trustedProxyAuthOk: false,
    controlUiPairingKind: null,
    skipLocalBackendSelfPairing: false,
    rejectUnauthorized: () => {},
  };
  const result = await issueGatewayConnectDeviceTokens({
    state,
    scopes: [],
    hasApprovedDeviceBaseline: true,
    isIssuanceCurrent: () => true,
  });
  expect(result.bootstrapDeviceTokens.find((token) => token.role === "operator")?.scopes).toEqual([
    "operator.read",
  ]);
  const after = await getPairedDevice("mobile-device", baseDir);
  expect(after?.tokens?.operator?.token).not.toBe(before?.tokens?.operator?.token);
  expect(after?.tokens?.node).toEqual(before?.tokens?.node);
  await revokeDeviceBootstrapToken({ baseDir, token: narrowed.source.token });
  await expect(
    issueGatewayConnectDeviceTokens({
      state,
      scopes: [],
      hasApprovedDeviceBaseline: true,
      isIssuanceCurrent: () => true,
    }),
  ).rejects.toThrow("source");
});

it("keeps legacy unbound setup grants unbound", async () => {
  const handoff = await issuedPerson();
  expect(handoff.profile.operatorProfileId).toBeUndefined();
  expect(
    await approveBootstrapDevicePairing(handoff.requestId, handoff.profile, {}, baseDir),
  ).toMatchObject({ status: "approved" });
  expect((await getPairedDevice("mobile-device", baseDir))?.operatorProfileId).toBeUndefined();
});

it("keys setup retries by exact selected person and rejects missing, merged, SharedOwner or unattended choices", async () => {
  const person = await local();
  const other = await local();
  const setup = {
    baseDir,
    setupId: "person-retry",
    profile: { ...mobile, operatorProfileId: person.id },
  };
  expect(await ensureDevicePairSetupBootstrapToken(setup)).toEqual(
    await ensureDevicePairSetupBootstrapToken(setup),
  );
  await expect(
    ensureDevicePairSetupBootstrapToken({
      ...setup,
      profile: { ...mobile, operatorProfileId: other.id },
    }),
  ).rejects.toThrow("changed");
  for (const id of [GATEWAY_OWNER_PROFILE_ID, "missing-person"]) {
    await expect(
      issueDevicePairSetupBootstrapToken({
        baseDir,
        profile: { ...mobile, operatorProfileId: id },
      }),
    ).rejects.toThrow();
  }
  for (const profile of [nodeOnly, voice]) {
    await expect(
      issueDevicePairSetupBootstrapToken({
        baseDir,
        profile: { ...profile, operatorProfileId: person.id },
      }),
    ).rejects.toThrow("attended");
  }
  await mergeCanonicalUserProfiles(person.id, other.id, options);
  await expect(issueDevicePairSetupBootstrapToken(setup)).rejects.toThrow();
});

it("refuses revoked source authority and conflicting person reassociation without rotating siblings", async () => {
  const person = await local();
  const handoff = await issuedPerson(person.id);
  await expect(
    approveHandoff(handoff, {
      bootstrapSource: { ...handoff.source, publicKey: "wrong-synthetic-key" },
    }),
  ).rejects.toThrow("source");
  await approveHandoff(handoff);
  const before = await getPairedDevice("mobile-device", baseDir);
  const other = await local();
  const conflict = await issuedPerson(other.id);
  await expect(approveHandoff(conflict)).rejects.toThrow("replace");
  expect(await getPairedDevice("mobile-device", baseDir)).toEqual(before);
  await revokeDeviceBootstrapToken({ baseDir, token: conflict.source.token });
  await expect(approveHandoff(conflict)).rejects.toThrow("source");
});

it("checks current role and requester at worker commit, rolling back the operator and node together", async () => {
  const person = await local();
  const handoff = await issuedPerson(person.id);
  let committing = false;
  const observer = probe.admission(workerAdmission, (request, grant, admit) => {
    committing = request.stage === "commit";
    admit(request, grant);
  });
  try {
    expect(await approveHandoff(handoff, { isApprovalCurrent: () => !committing })).toMatchObject({
      status: "forbidden",
    });
    expect(await getPairedDevice("mobile-device", baseDir)).toBeNull();
  } finally {
    observer.mockRestore();
  }
  applyReaderConfig();
  await setCanonicalUserProfileRole(person.id, "reader", options);
  await expect(approveHandoff(handoff)).rejects.toThrow("role");
  expect(await getPairedDevice("mobile-device", baseDir)).toBeNull();
});

it("issues an idempotent email-less person through the actual setup RPC", async () => {
  const client: GatewayClient = createOperatorWsClient();
  client.internal = { authenticatedOperator: true, operatorRoleActor: { kind: "system" } };
  client.authenticatedUserProfile = dispatchProfile(GATEWAY_OWNER_PROFILE_ID);
  const config = {
    gateway: { auth: { mode: "token" as const, token: "synthetic-gateway-token" } },
  };
  const context = {
    ...createGatewayRequestContext(makeContextParams()),
    getRuntimeConfig: () => config,
  };
  const params = {
    enrollmentId: randomUUID(),
    name: "Local Person",
    publicUrl: "wss://gateway.example.invalid",
    includeQr: false,
  };
  const respond = vi.fn();
  const handler = devicePairSetupHandlers["device.pair.setupCode"];
  if (!handler) {
    throw new Error("Missing setup method");
  }
  const request = {
    req: { type: "req" as const, id: "personal-setup", method: "device.pair.setupCode", params },
    params,
    client,
    context,
    respond,
    isWebchatConnect: () => false,
  };
  client.internal.syntheticClient = true;
  await handler(request);
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.anything());
  delete client.internal.syntheticClient;
  respond.mockClear();
  client.connect.scopes = ["operator.read"];
  await handler(request);
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.anything());
  expect(await listProfiles(options)).toEqual([]);
  client.connect.scopes = ["operator.admin"];
  respond.mockClear();
  await handler(request);
  const [ok, payload] = respond.mock.calls[0] ?? [];
  expect(ok).toBe(true);
  if (!isRecord(payload) || typeof payload.setupCode !== "string") {
    throw new Error("Expected usable setup code");
  }
  const decoded = decodePairingSetupCode(payload.setupCode);
  const bound = {
    baseDir,
    token: decoded.bootstrapToken,
    deviceId: "setup-person",
    publicKey: "synthetic-setup-key",
  };
  await verifyDeviceBootstrapToken({ ...bound, role: "node", scopes: [] });
  const person = await ensureCanonicalLocalUserProfile(
    { enrollmentId: params.enrollmentId },
    options,
  );
  expect((await getBoundDeviceBootstrapContext(bound))?.profile.operatorProfileId).toBe(person.id);
});
