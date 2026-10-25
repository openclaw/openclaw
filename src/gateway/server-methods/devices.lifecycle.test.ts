import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainNodePendingWork, enqueueNodePendingWork } from "../node-pending-work.js";
import { captureNodeWakeLifecycle, releaseNodeWakeLifecycle } from "../node-wake-state.js";
import { getNodeWakeStateSnapshot, seedNodeWakeState } from "../node-wake-state.test-support.js";
import { registerGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { bindDeviceWorkerReconciliation } from "../worker-environments/device-provider.js";
import {
  mocks,
  createClient,
  createDeviceClient,
  createOptions,
  expectDeviceSuccess,
  mockRotateOperatorTokenSuccess,
  expectDeviceError,
  captureSecurityEvents,
  resetDeviceHandlerTestState,
  invokeDevice,
  expectPrivate,
} from "./devices.test-support.js";

const { pairing, tokens } = mocks;
const emptyNodeSurface = { caps: [], commands: [], permissions: undefined };

function expectInvalidationBeforeReply(opts: Parameters<typeof invokeDevice>[0], reason: string) {
  vi.mocked(opts.respond).mockImplementation(() => {
    expect(opts.context.invalidateClientsForDevice).toHaveBeenCalledWith("device-1", {
      role: "operator",
      reason,
    });
    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
  });
}

function nodeRemovalOptions(
  method: string,
  deviceId = "device-1",
  client: Parameters<typeof createOptions>[2] = createDeviceClient(
    ["operator.admin"],
    "admin-device",
  ),
) {
  const revoking = method === "device.token.revoke";
  if (revoking) {
    tokens.revokeDeviceToken.mockResolvedValue({
      ok: true,
      entry: { role: "node", revokedAtMs: 456 },
    });
  } else {
    pairing.removePairedDevice.mockResolvedValue({ deviceId: deviceId.trim() });
  }
  return createOptions(method, { deviceId, ...(revoking ? { role: "node" } : {}) }, client);
}

beforeEach(resetDeviceHandlerTestState);

it.each(
  ["rotate", "revoke"].flatMap((operation) =>
    ["ownership", "role", "service"].map((denial) => ({ operation, denial })),
  ),
)("preserves $operation $denial denial ordering and privacy", async ({ operation, denial }) => {
  const method = `device.token.${operation}`;
  const deviceId = denial === "ownership" ? " device-2 " : " device-1 ";
  const role = denial === "service" ? " operator " : " node ";
  const reason =
    denial === "ownership"
      ? "device-ownership-mismatch"
      : denial === "role"
        ? "role-management-requires-admin"
        : "caller-missing-scope";
  const wording = operation === "rotate" ? "rotation" : "revocation";
  const order: string[] = [];
  const events: Extract<DiagnosticEventPayload, { type: "security.event" }>[] = [];
  const trusted: boolean[] = [];
  const mutation = operation === "rotate" ? tokens.rotateDeviceToken : tokens.revokeDeviceToken;
  if (denial === "service") {
    mutation.mockImplementationOnce(async () => {
      order.push("service");
      return { ok: false, reason: "caller-missing-scope", scope: "operator.admin" };
    });
  }
  const opts = createOptions(
    method,
    { deviceId, role },
    createDeviceClient(["operator.pairing"], " device-1 "),
  );
  vi.mocked(opts.context.logGateway.warn).mockImplementation(() => void order.push("warn"));
  vi.mocked(opts.respond).mockImplementation(() => void order.push("respond"));
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (event.type === "security.event") {
      order.push("event");
      events.push(event);
      trusted.push(metadata.trusted);
    }
  });
  try {
    await invokeDevice(opts);
  } finally {
    stop();
  }
  expect(order).toEqual([...(denial === "service" ? ["service"] : []), "warn", "event", "respond"]);
  if (denial === "service") {
    expect(mutation).toHaveBeenCalledWith(
      expect.objectContaining({ callerScopes: ["operator.pairing"] }),
    );
  } else {
    expect(mutation).not.toHaveBeenCalled();
  }
  expect(opts.respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
    code: "INVALID_REQUEST",
    message: `device token ${wording} denied`,
  });
  expect(trusted).toEqual([true]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "security.event",
    category: "auth",
    action: `device.token.${wording}_denied`,
    outcome: "denied",
    severity: "medium",
    reason,
    actor: {
      kind: "operator",
      role: "operator",
      deviceIdHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u),
    },
    target: { kind: "device", idHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u) },
    policy: { id: "gateway.device-token", decision: "deny", reason },
    control: { id: method, family: "auth" },
    attributes: { role: role.trim() },
  });
  expectPrivate(events, ["device-1", "device-2", "operator.admin"]);
  expect(opts.context.logGateway.info).not.toHaveBeenCalled();
  expect(opts.context.broadcast).not.toHaveBeenCalled();
  expect(opts.context.invalidateClientsForDevice).not.toHaveBeenCalled();
  expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
  expect(opts.context.nodeRegistry.updateSurface).not.toHaveBeenCalled();
});

it.each(
  ["device.pair.remove", "device.token.revoke"].flatMap((method) =>
    [false, true].map((callerRetired) => ({ method, callerRetired })),
  ),
)(
  "finishes $method teardown when callerRetired=$callerRetired",
  async ({ method, callerRetired }) => {
    const revoking = method === "device.token.revoke";
    const nodeId = "device-1";
    const opts = nodeRemovalOptions(
      method,
      ` ${nodeId} `,
      revoking ? createDeviceClient(["operator.admin"], "admin-device") : createDeviceClient(),
    );
    await seedNodeWakeState(nodeId);
    enqueueNodePendingWork({ nodeId, type: "location.request" });
    const wake = captureNodeWakeLifecycle(nodeId);
    const client = Object.assign(expectDefined(opts.client, "removal caller"), {
      invalidated: false,
      socket: { close: vi.fn() },
    });
    const removed = { deviceId: "device-1", removedAtMs: 123 };
    const mutation = revoking ? tokens.revokeDeviceToken : pairing.removePairedDevice;
    mutation.mockImplementationOnce(async () => {
      client.invalidated = callerRetired;
      return revoking ? { ok: true, entry: { role: "node", revokedAtMs: 456 } } : removed;
    });
    const policyResponse = registerGatewayPolicyResponse(method, client, opts.respond);
    const order: string[] = [];
    const workerEnvironmentService = {};
    bindDeviceWorkerReconciliation(workerEnvironmentService, async (id) => {
      expect(id).toBe(nodeId);
      order.push("environment");
      return ["environment-1"];
    });
    const reconcileActive = vi.fn(async () => {
      order.push("placement");
    });
    Object.assign(opts.context, {
      workerEnvironmentService,
      workerPlacementDispatchService: { reconcileActive },
      invalidateClientsForDevice: vi.fn(() => order.push("invalidate")),
      disconnectClientsForDevice: vi.fn(() => order.push("disconnect")),
    });
    vi.mocked(opts.respond).mockImplementation(() => void order.push("respond"));
    try {
      const removal = invokeDevice(opts);
      if (callerRetired) {
        await expect(removal).rejects.toThrow("client authorization is no longer active");
        expect(opts.respond).not.toHaveBeenCalled();
      } else {
        await removal;
        expectDeviceSuccess(
          opts,
          revoking ? { deviceId: "device-1", role: "node", revokedAtMs: 456 } : removed,
        );
      }
      if (!revoking) {
        expect(pairing.removePairedDevice).toHaveBeenCalledWith(` ${nodeId} `);
      }
      expect(reconcileActive).toHaveBeenCalledWith("environment-1");
      expect(getNodeWakeStateSnapshot(nodeId)).toBeUndefined();
      expect(wake.aborted).toBe(true);
      expect(drainNodePendingWork(nodeId).items.map(({ id }) => id)).toEqual(["baseline-status"]);
      expect(opts.context.nodeRegistry.updateSurface).toHaveBeenCalledWith(
        nodeId,
        emptyNodeSurface,
      );
      expect(opts.context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
        ...(revoking ? { role: "node" } : {}),
        reason: revoking ? "device-token-revoked" : "device-pair-removed",
      });
      expect(order).toEqual([
        "invalidate",
        "environment",
        "placement",
        ...(callerRetired ? [] : ["respond"]),
        "disconnect",
      ]);
    } finally {
      policyResponse?.finish();
    }
  },
);

it.each(["device.pair.remove", "device.token.revoke"])(
  "tears down revoked clients when worker cleanup fails in %s",
  async (method) => {
    const opts = nodeRemovalOptions(
      method,
      "device-1",
      createClient(["operator.admin"], "admin-device"),
    );
    const workerEnvironmentService = {};
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failure = new Error("worker credential write failed");
    bindDeviceWorkerReconciliation(workerEnvironmentService, async () => {
      entered.resolve();
      await release.promise;
      throw failure;
    });
    Object.assign(opts.context, { workerEnvironmentService });
    const mutation = invokeDevice(opts);
    try {
      await entered.promise;
      // Authority must end while cleanup is still pending on another owner.
      expect(opts.context.invalidateClientsForDevice).toHaveBeenCalledWith("device-1", {
        reason: method === "device.pair.remove" ? "device-pair-removed" : "device-token-revoked",
        ...(method === "device.token.revoke" ? { role: "node" } : {}),
      });
      expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
      release.resolve();
      await expect(mutation).rejects.toThrow(failure);
      expect(opts.context.disconnectClientsForDevice).toHaveBeenCalled();
      expect(opts.context.nodeRegistry.updateSurface).toHaveBeenCalledWith(
        "device-1",
        emptyNodeSurface,
      );
      expect(opts.respond).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.resolve(mutation).catch(() => {});
    }
  },
);

it.each(["unknown", "foreign", "mixed-role"] as const)(
  "rejects %s device removal",
  async (kind) => {
    if (kind === "unknown") {
      pairing.removePairedDevice.mockResolvedValue(null);
    } else if (kind === "mixed-role") {
      pairing.getPairedDevice.mockResolvedValue({
        deviceId: "device-1",
        role: "operator",
        roles: ["operator", "node"],
      });
    }
    const opts = createOptions(
      "device.pair.remove",
      { deviceId: kind === "foreign" ? "device-2" : "device-1" },
      kind === "unknown" ? null : createDeviceClient(),
    );
    await invokeDevice(opts);
    if (kind !== "unknown") {
      expect(pairing.removePairedDevice).not.toHaveBeenCalled();
    }
    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expectDeviceError(
      opts,
      kind === "unknown" ? "unknown deviceId" : "device pairing removal denied",
    );
  },
);

it.each(["shared", "self"] as const)("revokes normalized tokens for %s callers", async (mode) => {
  const shared = mode === "shared";
  const role = shared ? " operator " : "operator";
  tokens.revokeDeviceToken.mockResolvedValue({
    ok: true,
    entry: {
      role: "operator",
      revokedAtMs: 456,
      ...(shared ? { token: "raw-revoked-token", scopes: [] } : {}),
    },
  });
  const opts = createOptions(
    "device.token.revoke",
    { deviceId: " device-1 ", role },
    shared ? null : createDeviceClient(),
  );
  expectInvalidationBeforeReply(opts, "device-token-revoked");
  const events = await captureSecurityEvents(async () => {
    await invokeDevice(opts);
    await Promise.resolve();
  });
  expect(tokens.revokeDeviceToken).toHaveBeenCalledWith({
    deviceId: " device-1 ",
    role,
    callerScopes: shared ? [] : ["operator.pairing"],
  });
  expectDeviceSuccess(opts, { deviceId: "device-1", role: "operator", revokedAtMs: 456 });
  expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1", {
    role: "operator",
  });
  if (shared) {
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "security.event",
      category: "auth",
      action: "device.token.revoked",
      outcome: "success",
      severity: "high",
      target: { kind: "device", idHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u) },
      policy: { id: "gateway.device-token", decision: "allow" },
      control: { id: "device.token.revoke", family: "auth" },
      attributes: { role: "operator" },
    });
    expectPrivate(events, ["device-1", "raw-revoked-token"]);
  }
});

it.each(["shared", "self", "admin"] as const)(
  "rotates operator tokens with %s delivery authority",
  async (mode) => {
    mockRotateOperatorTokenSuccess();
    const deviceId = mode === "admin" ? "device-1" : " device-1 ";
    const role = mode === "shared" ? " operator " : "operator";
    const scopes = ["operator.pairing"];
    const client =
      mode === "shared"
        ? createClient(scopes)
        : mode === "self"
          ? createDeviceClient()
          : createDeviceClient(["operator.admin", ...scopes], "admin-device");
    const opts = createOptions("device.token.rotate", { deviceId, role, scopes }, client);
    expectInvalidationBeforeReply(opts, "device-token-rotated");
    await invokeDevice(opts);
    await Promise.resolve();
    if (mode !== "admin") {
      expect(tokens.rotateDeviceToken).toHaveBeenCalledWith({
        deviceId,
        role,
        scopes,
        callerScopes: scopes,
      });
    }
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1", {
      role: "operator",
    });
    expectDeviceSuccess(opts, {
      deviceId,
      role: "operator",
      scopes,
      rotatedAtMs: 789,
      ...(mode === "self" ? { token: "new-token" } : {}),
      tokenDelivery: mode === "self" ? "in-band" : "withheld-cross-device",
    });
  },
);

it.each(["node", "operator"] as const)("ends only %s wake ownership on rotation", async (role) => {
  if (role === "node") {
    tokens.rotateDeviceToken.mockResolvedValue({
      ok: true,
      entry: { token: "new-node-token", role, scopes: [], createdAtMs: 456, rotatedAtMs: 789 },
    });
  } else {
    mockRotateOperatorTokenSuccess();
  }
  const lifecycle = captureNodeWakeLifecycle("device-1");
  const opts = createOptions(
    "device.token.rotate",
    {
      deviceId: "device-1",
      role,
      ...(role === "operator" ? { scopes: ["operator.pairing"] } : {}),
    },
    role === "node" ? createDeviceClient(["operator.admin"], "admin-device") : null,
  );
  await invokeDevice(opts);
  expect(lifecycle.aborted).toBe(role === "node");
  if (role === "operator") {
    releaseNodeWakeLifecycle("device-1", lifecycle);
  }
});
