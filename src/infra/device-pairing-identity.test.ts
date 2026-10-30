import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import {
  isPairedDeviceTokenIdentityCurrent,
  hasEffectivePairedDeviceRole,
  listEffectivePairedDeviceRoles,
  resolveNodePairingState,
  resolveAuthenticatedDeviceTokenIdentity,
} from "./device-pairing-identity.js";
import type { DeviceAuthToken, PairedDevice } from "./device-pairing.types.js";

const makeToken = (role: string, scopes: string[] = []): DeviceAuthToken => ({
  token: `synthetic-${role}-token`,
  role,
  scopes,
  createdAtMs: 1,
});
const operatorToken = (device: PairedDevice) =>
  expectDefined(device.tokens?.operator, "operator token");
const authenticate = (device: PairedDevice) => ({
  role: "operator",
  publicKey: device.publicKey,
  token: operatorToken(device).token,
  scopes: ["operator.admin"],
});
const operatorIdentity = (device: PairedDevice) =>
  expectDefined(
    resolveAuthenticatedDeviceTokenIdentity(device, authenticate(device)),
    "operator identity",
  );
const isCurrent = (
  device: PairedDevice | null,
  identity: ReturnType<typeof operatorIdentity>,
  scope = "operator.admin",
) => isPairedDeviceTokenIdentityCurrent(device, "operator", identity, [scope]);

function createPairedOperator(): PairedDevice {
  return {
    deviceId: "paired-device",
    publicKey: "synthetic-device-key",
    roles: ["operator", "node"],
    approvedScopes: ["operator.admin"],
    tokens: {
      operator: makeToken("operator", ["operator.admin"]),
      node: makeToken("node"),
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

test("captures only the device key and token actually accepted at handshake", () => {
  const device = createPairedOperator();
  const authenticated = { ...authenticate(device), scopes: ["operator.write"] };
  const original = resolveAuthenticatedDeviceTokenIdentity(device, authenticated);
  expect(original).toEqual({
    deviceId: "paired-device",
    key: "3a3c86bb905c3f65d85c8a38e22526f5e3e2bb0cb72a592f43b48922ea671a1d",
  });
  expect(Object.isFrozen(original)).toBe(true);
  expect(
    resolveAuthenticatedDeviceTokenIdentity(device, { ...authenticated, publicKey: "foreign-key" }),
  ).toBeNull();
  device.tokens!.operator!.token = "replacement-token";
  expect(resolveAuthenticatedDeviceTokenIdentity(device, authenticated)).toBeNull();
});

test("keeps original operator scopes without exporting bearer credentials or unrelated approval changes", () => {
  const device = createPairedOperator();
  const identity = operatorIdentity(device);
  const node = resolveNodePairingState(device);
  expect(isCurrent(device, identity, "operator.write")).toBe(true);
  device.displayName = "Renamed device";
  device.approvedAtMs = 2;
  device.tokens = {
    ...device.tokens,
    node: { token: "replacement-node-token", role: "node", scopes: [], createdAtMs: 2 },
  };
  expect(isCurrent(device, identity)).toBe(true);
  expect(resolveNodePairingState(device)).not.toEqual(node);
});

test.each<
  [string, { device?: Partial<PairedDevice> | null; token?: Partial<DeviceAuthToken> | null }]
>([
  ["removed device", { device: null }],
  ["different device", { device: { deviceId: "other-device" } }],
  ["replaced key", { device: { publicKey: "replacement-key" } }],
  ["recreated device", { device: { createdAtMs: 2 } }],
  ["removed approved role", { device: { roles: ["node"] } }],
  ["removed token", { token: null }],
  ["revoked token", { token: { revokedAtMs: 2 } }],
  ["rotated token", { token: { token: "replacement-token", rotatedAtMs: 2 } }],
  ["recreated token", { token: { createdAtMs: 2 } }],
  ["mismatched token role", { token: { role: "node" } }],
])("rejects an original operator source after %s", (_name, change) => {
  let device: PairedDevice | null = createPairedOperator();
  const identity = operatorIdentity(device);
  if (change.device === null) {
    device = null;
  } else {
    Object.assign(device, change.device);
    if (change.token === null) {
      delete device.tokens?.operator;
    } else if (change.token) {
      Object.assign(operatorToken(device), change.token);
    }
  }
  expect(isCurrent(device, identity)).toBe(false);
});

test.each(["token scopes", "approval baseline", "missing approval baseline"] as const)(
  "rejects scope re-admission after narrowing %s even when the token identity is unchanged",
  (change) => {
    const device = createPairedOperator();
    const identity = operatorIdentity(device);
    if (change === "token scopes") {
      operatorToken(device).scopes = ["operator.read"];
    } else if (change === "approval baseline") {
      device.approvedScopes = ["operator.read"];
    } else {
      delete device.approvedScopes;
    }
    expect(isCurrent(device, identity)).toBe(false);
    expect(resolveAuthenticatedDeviceTokenIdentity(device, authenticate(device))).toBeNull();
    if (change !== "token scopes") {
      // Live verification rejects an over-scoped token even for a narrower request.
      expect(isCurrent(device, identity, "operator.read")).toBe(false);
    }
  },
);

test("node connection identity is unaffected by an unrelated operator-token upgrade", () => {
  const device = createPairedOperator();
  const original = resolveNodePairingState(device);
  expect(original).not.toBeNull();
  operatorToken(device).token = "replacement-operator-token";
  device.approvedAtMs = 2;
  expect(resolveNodePairingState(device)).toEqual(original);
});

test("filters active token roles to the approved pairing role set", () => {
  const device = createPairedOperator();
  device.role = "operator";
  device.roles = ["operator"];
  device.tokens = { node: makeToken("node"), operator: makeToken("operator", ["operator.read"]) };

  expect(listEffectivePairedDeviceRoles(device)).toEqual(["operator"]);
  expect(hasEffectivePairedDeviceRole(device, "node")).toBe(false);
});
