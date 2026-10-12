import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import {
  isPairedDeviceTokenIdentityCurrent,
  resolveNodePairingState,
  resolveAuthenticatedDeviceTokenIdentity,
} from "./device-pairing-identity.js";
import type { PairedDevice } from "./device-pairing.types.js";

function createPairedOperator(): PairedDevice {
  return {
    deviceId: "paired-device",
    publicKey: "synthetic-device-key",
    roles: ["operator", "node"],
    approvedScopes: ["operator.admin"],
    tokens: {
      operator: {
        token: "synthetic-operator-token",
        role: "operator",
        scopes: ["operator.admin"],
        createdAtMs: 1,
      },
      node: { token: "synthetic-node-token", role: "node", scopes: [], createdAtMs: 1 },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

test("captures only the device key and token actually accepted at handshake", () => {
  const device = createPairedOperator();
  const authenticated = {
    role: "operator",
    publicKey: device.publicKey,
    token: device.tokens!.operator!.token,
    scopes: ["operator.write"],
  };
  const original = resolveAuthenticatedDeviceTokenIdentity(device, authenticated);
  expect(original).not.toBeNull();
  expect(Object.isFrozen(original)).toBe(true);
  expect(
    resolveAuthenticatedDeviceTokenIdentity(device, { ...authenticated, publicKey: "foreign-key" }),
  ).toBeNull();
  device.tokens!.operator!.token = "replacement-token";
  expect(resolveAuthenticatedDeviceTokenIdentity(device, authenticated)).toBeNull();
});

test("keeps original operator scopes without exporting bearer credentials or unrelated approval changes", () => {
  const device = createPairedOperator();
  const identity = expectDefined(
    resolveAuthenticatedDeviceTokenIdentity(device, {
      role: "operator",
      publicKey: device.publicKey,
      token: device.tokens!.operator!.token,
      scopes: ["operator.admin"],
    }),
    "operator identity",
  );
  const node = resolveNodePairingState(device);
  expect(identity).toEqual({
    deviceId: "paired-device",
    key: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(isPairedDeviceTokenIdentityCurrent(device, "operator", identity, ["operator.write"])).toBe(
    true,
  );
  device.displayName = "Renamed device";
  device.approvedAtMs = 2;
  device.tokens = {
    ...device.tokens,
    node: { token: "replacement-node-token", role: "node", scopes: [], createdAtMs: 2 },
  };
  expect(isPairedDeviceTokenIdentityCurrent(device, "operator", identity, ["operator.admin"])).toBe(
    true,
  );
  expect(resolveNodePairingState(device)).not.toEqual(node);
});

test.each([
  "removed device",
  "different device",
  "replaced key",
  "recreated device",
  "removed approved role",
  "removed token",
  "revoked token",
  "rotated token",
  "recreated token",
  "mismatched token role",
] as const)("rejects an original operator source after %s", (change) => {
  let device: PairedDevice | null = createPairedOperator();
  const identity = expectDefined(
    resolveAuthenticatedDeviceTokenIdentity(device, {
      role: "operator",
      publicKey: device.publicKey,
      token: device.tokens!.operator!.token,
      scopes: ["operator.admin"],
    }),
    "operator identity",
  );
  const token = expectDefined(device.tokens?.operator, "operator token");
  switch (change) {
    case "removed device":
      device = null;
      break;
    case "different device":
      device.deviceId = "other-device";
      break;
    case "replaced key":
      device.publicKey = "replacement-key";
      break;
    case "recreated device":
      device.createdAtMs = 2;
      break;
    case "removed approved role":
      device.roles = ["node"];
      break;
    case "removed token":
      delete device.tokens?.operator;
      break;
    case "revoked token":
      token.revokedAtMs = 2;
      break;
    case "rotated token":
      token.token = "replacement-token";
      token.rotatedAtMs = 2;
      break;
    case "recreated token":
      token.createdAtMs = 2;
      break;
    case "mismatched token role":
      token.role = "node";
      break;
  }
  expect(isPairedDeviceTokenIdentityCurrent(device, "operator", identity, ["operator.admin"])).toBe(
    false,
  );
});

test.each(["token scopes", "approval baseline", "missing approval baseline"] as const)(
  "rejects scope re-admission after narrowing %s even when the token identity is unchanged",
  (change) => {
    const device = createPairedOperator();
    const identity = expectDefined(
      resolveAuthenticatedDeviceTokenIdentity(device, {
        role: "operator",
        publicKey: device.publicKey,
        token: device.tokens!.operator!.token,
        scopes: ["operator.admin"],
      }),
      "operator identity",
    );
    if (change === "token scopes") {
      expectDefined(device.tokens?.operator, "operator token").scopes = ["operator.read"];
    } else if (change === "approval baseline") {
      device.approvedScopes = ["operator.read"];
    } else {
      delete device.approvedScopes;
    }
    expect(
      isPairedDeviceTokenIdentityCurrent(device, "operator", identity, ["operator.admin"]),
    ).toBe(false);
    if (change !== "token scopes") {
      // Live verification rejects an over-scoped token even for a narrower request.
      expect(
        isPairedDeviceTokenIdentityCurrent(device, "operator", identity, ["operator.read"]),
      ).toBe(false);
    }
  },
);

test("node connection identity is unaffected by an unrelated operator-token upgrade", () => {
  const device = createPairedOperator();
  const original = resolveNodePairingState(device);
  expect(original).not.toBeNull();
  expectDefined(device.tokens?.operator, "operator token").token = "replacement-operator-token";
  device.approvedAtMs = 2;
  expect(resolveNodePairingState(device)).toEqual(original);
});
