import { beforeEach, expect, it, vi } from "vitest";
import { captureNodeWakeLifecycle } from "../node-wake-state.js";
import {
  mocks,
  createClient,
  createDeviceClient,
  createOptions,
  expectDeviceSuccess,
  expectDeviceError,
  captureSecurityEvents,
  resetDeviceHandlerTestState,
  invokeDevice as invoke,
  expectPrivate,
} from "./devices.test-support.js";

const { pairing, approval } = mocks;
const hash = expect.stringMatching(/^sha256:[a-f0-9]{12}$/u);
const scopes = ["operator.pairing"];

function device(id: number, approvedAtMs = id * 100, createdAtMs = id === 1 ? 50 : 60) {
  return { deviceId: "device-" + id, publicKey: "pk-" + id, approvedAtMs, createdAtMs };
}
const pending = [
  { requestId: "req-1", deviceId: "device-1", publicKey: "pk-1", ts: 100 },
  { requestId: "req-2", deviceId: "device-2", publicKey: "pk-2", ts: 200 },
];
const paired = [device(1), device(2)];
beforeEach(resetDeviceHandlerTestState);

it.each([
  ["non-admin device", createDeviceClient(), true],
  ["admin device", createDeviceClient([...scopes, "operator.admin"]), false],
  [
    "shared-auth device identity",
    createClient(scopes, "device-1", { isDeviceTokenAuth: false }),
    false,
  ],
] as const)("lists the authorized devices for %s sessions", async (_name, client, ownOnly) => {
  pairing.listDevicePairing.mockResolvedValue(structuredClone({ pending, paired }));
  const opts = createOptions("device.pair.list", {}, client);
  await invoke(opts);
  expectDeviceSuccess(opts, {
    pending: ownOnly ? [pending[0]] : pending,
    paired: (ownOnly ? [paired[0]] : paired).map((entry) =>
      Object.assign({}, entry, { tokens: undefined, connected: false }),
    ),
  });
});

it("marks live device connections in the pairing list", async () => {
  pairing.listDevicePairing.mockResolvedValue({ pending: [], paired });
  const opts = createOptions("device.pair.list", {}, createClient(scopes));
  Object.assign(opts.context, { hasConnectedClientsForDevice: (id: string) => id === "device-2" });
  await invoke(opts);
  const payload = vi.mocked(opts.respond).mock.calls[0]?.[1] as {
    paired: Array<{ deviceId: string; connected: boolean }>;
  };
  expect(payload.paired.map(({ deviceId, connected }) => [deviceId, connected])).toEqual([
    ["device-1", false],
    ["device-2", true],
  ]);
});

it.each([
  ["approve", approval.approveDevicePairing, "approval"],
  ["reject", pairing.rejectDevicePairing, "rejection"],
] as const)(
  "denies %s of another device to non-admin device sessions",
  async (method, mutation, noun) => {
    pairing.getPendingDevicePairing.mockResolvedValue({ ...pending[1], ts: 100 });
    const opts = createOptions(
      "device.pair." + method,
      { requestId: "req-2" },
      createDeviceClient(),
    );
    await invoke(opts);
    expect(mutation).not.toHaveBeenCalled();
    expectDeviceError(opts, "device pairing " + noun + " denied");
  },
);

it.each(["admin", "self", "shared"] as const)(
  "approves devices within %s authority and normalizes request IDs",
  async (mode) => {
    const admin = mode === "admin",
      shared = mode === "shared";
    const requestId = admin ? "req-2" : "req-1";
    const approved = {
      ...(admin ? device(2, 200, 150) : shared ? device(2, 100, 50) : device(1)),
      ...(shared ? { role: "operator", roles: ["operator"] } : {}),
    };
    if (!admin) {
      const request = {
        ...pending[0],
        deviceId: shared ? "device-2" : " device-1 ",
        ...(shared ? { role: "operator", roles: ["operator"], scopes } : {}),
      };
      pairing.getPendingDevicePairing.mockImplementation(async (id: string) =>
        id === requestId ? request : null,
      );
    }
    approval.approveDevicePairing.mockResolvedValue({
      status: "approved",
      requestId,
      device: { ...approved, ...(shared ? { approvedScopes: scopes } : {}) },
    });
    const callerScopes = admin ? ["operator.admin"] : scopes;
    const opts = createOptions(
      "device.pair.approve",
      { requestId: shared ? requestId : " \t" + requestId + "\n " },
      shared
        ? createClient(scopes, "device-1", { isDeviceTokenAuth: false })
        : createDeviceClient(callerScopes),
    );
    const events = await captureSecurityEvents(() => invoke(opts));
    if (admin) {
      expect(pairing.getPendingDevicePairing).not.toHaveBeenCalled();
    }
    if (shared) {
      expect(pairing.getPendingDevicePairing).toHaveBeenCalledWith(requestId);
    }
    expect(approval.approveDevicePairing).toHaveBeenCalledWith(requestId, { callerScopes });
    expectDeviceSuccess(opts, { requestId, device: { ...approved, tokens: undefined } });
    if (mode === "self") {
      expect(opts.context.broadcast).toHaveBeenCalledWith(
        "device.pair.resolved",
        expect.objectContaining({ requestId, deviceId: "device-1", decision: "approved" }),
        { dropIfSlow: true },
      );
    }
    if (admin) {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "device.pairing.approved",
        outcome: "success",
        severity: "low",
        actor: { kind: "operator", deviceIdHash: hash, role: "admin" },
        target: { kind: "device", idHash: hash },
        policy: { id: "gateway.device-pairing", decision: "allow" },
        control: { id: "device.pair.approve", family: "auth" },
        attributes: { role_count: 0, scope_count: 0 },
      });
      expectPrivate(events, ["device-1", "device-2", "pk-2"]);
    }
  },
);

it("retires the previous node generation before returning reapproval success", async () => {
  approval.approveDevicePairing.mockResolvedValue({
    status: "approved",
    requestId: "req-node-repair",
    nodePairingGenerationChanged: true,
    device: {
      deviceId: "node-repaired",
      publicKey: "replacement-key",
      role: "node",
      roles: ["node"],
      approvedAtMs: 200,
      createdAtMs: 100,
    },
  });
  const lifecycle = captureNodeWakeLifecycle("node-repaired");
  const opts = createOptions(
    "device.pair.approve",
    { requestId: "req-node-repair" },
    createDeviceClient(["operator.admin"]),
  );
  const { invalidateClientsForDevice: invalidate, disconnectClientsForDevice: disconnect } =
    opts.context;
  vi.mocked(opts.respond).mockImplementation(() => {
    expect(lifecycle.aborted).toBe(true);
    expect(invalidate).toHaveBeenCalledWith("node-repaired", {
      role: "node",
      reason: "device-pairing-reapproved",
    });
    expect(disconnect).not.toHaveBeenCalled();
  });
  await invoke(opts);
  await Promise.resolve();
  expect(opts.respond).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledWith("node-repaired", { role: "node" });
});

it("rejects approving node roles for the caller device without admin scope", async () => {
  pairing.getPendingDevicePairing.mockResolvedValue({
    ...pending[0],
    deviceId: " device-1 ",
    role: "node",
    roles: ["node"],
  });
  const opts = createOptions("device.pair.approve", { requestId: "req-1" }, createDeviceClient());
  const events = await captureSecurityEvents(() => invoke(opts));
  expect(approval.approveDevicePairing).not.toHaveBeenCalled();
  expectDeviceError(opts, "device pairing approval denied");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    action: "device.pairing.denied",
    outcome: "denied",
    reason: "role-management-requires-admin",
    policy: {
      id: "gateway.device-pairing",
      decision: "deny",
      reason: "role-management-requires-admin",
    },
    control: { id: "device.pair.approve", family: "auth" },
  });
  expectPrivate(events, ["device-1"]);
});

it("denies unknown approvals from non-admin non-device sessions", async () => {
  pairing.getPendingDevicePairing.mockResolvedValue(null);
  const opts = createOptions("device.pair.approve", { requestId: "missing" }, createClient(scopes));
  await invoke(opts);
  expect(approval.approveDevicePairing).not.toHaveBeenCalled();
  expectDeviceError(opts, "device pairing approval denied");
});

it.each(["self", "admin"] as const)(
  "rejects pairing requests within %s authority",
  async (mode) => {
    const admin = mode === "admin",
      requestId = admin ? "req-2" : "req-1";
    if (!admin) {
      pairing.getPendingDevicePairing.mockImplementation(async (id: string) =>
        id === requestId ? { ...pending[0], deviceId: " device-1 " } : null,
      );
    }
    const result = {
      requestId,
      deviceId: admin ? "device-2" : "device-1",
      rejectedAtMs: admin ? 456 : 123,
    };
    pairing.rejectDevicePairing.mockResolvedValue(result);
    const opts = createOptions(
      "device.pair.reject",
      { requestId: " \t" + requestId + "\n " },
      createDeviceClient(admin ? [...scopes, "operator.admin"] : scopes),
    );
    const events = await captureSecurityEvents(() => invoke(opts));
    expect(pairing.rejectDevicePairing).toHaveBeenCalledWith(requestId);
    expectDeviceSuccess(opts, result);
    if (!admin) {
      expect(opts.context.broadcast).toHaveBeenCalledWith(
        "device.pair.resolved",
        expect.objectContaining({ requestId, deviceId: "device-1", decision: "rejected" }),
        { dropIfSlow: true },
      );
    } else {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "device.pairing.rejected",
        outcome: "success",
        severity: "low",
        actor: { kind: "operator", role: "admin" },
        target: { kind: "device", idHash: hash },
        policy: { id: "gateway.device-pairing", decision: "allow" },
        control: { id: "device.pair.reject", family: "auth" },
      });
      expectPrivate(events, ["device-1", "device-2"]);
    }
  },
);

it("renames a paired device with an operator label", async () => {
  pairing.updatePairedDeviceMetadata.mockResolvedValue(true);
  const opts = createOptions("device.pair.rename", {
    deviceId: "device-1",
    label: "  Kitchen Mac  ",
  });
  await invoke(opts);
  expect(pairing.updatePairedDeviceMetadata).toHaveBeenCalledWith("device-1", {
    operatorLabel: "Kitchen Mac",
  });
  expectDeviceSuccess(opts, { deviceId: "device-1", label: "Kitchen Mac" });
  expect(opts.context.logGateway.info).toHaveBeenCalledWith(
    "device pairing renamed device=device-1 label=Kitchen Mac",
  );
  expect(opts.context.broadcast).toHaveBeenCalledWith(
    "device.pair.changed",
    {},
    { dropIfSlow: true },
  );
});

it.each([
  ["device-2", "Not yours", true, "device pairing rename denied"],
  ["missing-device", "Ghost", false, "unknown deviceId"],
  ["device-1", "   ", false, "label required"],
  ["device-1", "x".repeat(65), false, expect.stringContaining("invalid device.pair.rename params")],
] as const)("rejects rename of %s with label %s", async (deviceId, label, own, error) => {
  pairing.updatePairedDeviceMetadata.mockResolvedValue(false);
  const opts = createOptions(
    "device.pair.rename",
    { deviceId, label },
    own ? createDeviceClient() : null,
  );
  await invoke(opts);
  if (deviceId === "missing-device") {
    expect(pairing.updatePairedDeviceMetadata).toHaveBeenCalledWith(deviceId, {
      operatorLabel: label,
    });
    expect(opts.context.broadcast).not.toHaveBeenCalled();
  } else {
    expect(pairing.updatePairedDeviceMetadata).not.toHaveBeenCalled();
  }
  expectDeviceError(opts, error);
});
