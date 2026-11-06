import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  createExecApprovalIosPushDelivery,
  createPluginApprovalIosPushDelivery,
} from "./exec-approval-ios-push.js";

const mocks = vi.hoisted(() => ({
  pairing: vi.fn(),
  registrations: vi.fn(),
  directAuth: vi.fn(),
  relayConfig: vi.fn(),
  execAlert: vi.fn(),
  execWake: vi.fn(),
  pluginAlert: vi.fn(),
  pluginWake: vi.fn(),
}));

const registrationDefaults = {
  topic: "ai.openclaw.ios.test",
  environment: "sandbox",
  updatedAtMs: 1,
};
const directAuthConfig = { teamId: "team", keyId: "key", privateKey: "private-key" };

function apnsRegistration(nodeId = "ios-device-1") {
  return { nodeId, transport: "direct", token: "apns-token", ...registrationDefaults };
}

function relayApnsRegistration(nodeId = "ios-device-1") {
  return {
    ...registrationDefaults,
    nodeId,
    transport: "relay",
    relayHandle: `relay-${nodeId}`,
    sendGrant: `grant-${nodeId}`,
    installationId: `installation-${nodeId}`,
    distribution: "official",
    relayOrigin: "https://relay.example.test",
  };
}

function successfulApnsPushResult() {
  return { ok: true, status: 200 };
}

function approvalRequest(id: string): ExecApprovalRequest {
  return {
    id,
    request: { command: "echo ok", host: "gateway", allowedDecisions: ["allow-once"] },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}

function pluginApprovalRequest(id: string): PluginApprovalRequest {
  return {
    id,
    request: {
      title: "Install plugin update",
      description: "Allow the plugin to update its managed package.",
      detail: '{"package":"@openclaw/example","token":"review-only"}',
    },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}

const approvalScopes = ["operator.approvals", "operator.read"];

function pairedIosOperator(
  scopes = approvalScopes,
  deviceId = "ios-device-1",
  approvedScopes?: string[],
) {
  return {
    deviceId,
    platform: "iOS 18",
    role: "operator",
    roles: ["operator"],
    approvedScopes,
    tokens: {
      operator: { token: "operator-token", role: "operator", scopes, createdAtMs: 1 },
    },
  };
}

function mockPairedIosOperators(...paired: ReturnType<typeof pairedIosOperator>[]) {
  mocks.pairing.mockResolvedValue({ pending: [], paired });
}

function mockPairedIosOperator(scopes = approvalScopes) {
  mockPairedIosOperators(pairedIosOperator(scopes));
}

async function expectRejectedRequest(
  id: string,
  options?: Parameters<ReturnType<typeof createExecApprovalIosPushDelivery>["handleRequested"]>[1],
) {
  const delivery = createExecApprovalIosPushDelivery({ log: {} });
  expect(await delivery.handleRequested(approvalRequest(id), options)).toBe(false);
  expect(mocks.registrations).not.toHaveBeenCalled();
  expect(mocks.execAlert).not.toHaveBeenCalled();
}

function expectPluginAlert(expected: Record<string, unknown>) {
  expect(mocks.pluginAlert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(expected));
}

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => ({ gateway: {} }),
}));

vi.mock("../infra/device-pairing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing.js")>()),
  listDevicePairing: mocks.pairing,
}));

vi.mock("../infra/device-identity-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-identity-async.js")>()),
  loadOrCreateProcessDeviceIdentityAsync: () => ({ deviceId: "gateway-device-1" }),
}));

// mock-isolation: Exercise approval routing with synthetic APNs registrations and no network delivery.
vi.mock("../infra/push-apns.js", () => ({
  loadApnsRegistrations: mocks.registrations,
  resolveApnsAuthConfigFromEnv: mocks.directAuth,
  resolveApnsRelayConfigFromEnv: mocks.relayConfig,
  sendApnsExecApprovalAlert: mocks.execAlert,
  sendApnsExecApprovalResolvedWake: mocks.execWake,
  sendApnsPluginApprovalAlert: mocks.pluginAlert,
  sendApnsPluginApprovalResolvedWake: mocks.pluginWake,
  clearApnsRegistrationIfCurrent: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

describe("createExecApprovalIosPushDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pairing.mockResolvedValue({ pending: [], paired: [] });
    mocks.registrations.mockImplementation(async (nodeIds: readonly string[]) =>
      nodeIds.map((nodeId) => ({ nodeId, registration: apnsRegistration(nodeId) })),
    );
    mocks.directAuth.mockResolvedValue({ ok: true, value: directAuthConfig });
    mocks.relayConfig.mockReturnValue({ ok: false, error: "unused" });
    mocks.execAlert.mockResolvedValue(successfulApnsPushResult());
    mocks.execWake.mockResolvedValue(successfulApnsPushResult());
    mocks.pluginAlert.mockResolvedValue(successfulApnsPushResult());
    mocks.pluginWake.mockResolvedValue(successfulApnsPushResult());
  });

  it("does not target iOS devices whose active operator token lacks operator.approvals", async () => {
    mockPairedIosOperators(pairedIosOperator(["operator.read"], undefined, ["operator.approvals"]));

    await expectRejectedRequest("approval-1");
  });

  it("does not target approval-only iOS devices that cannot validate gateway ownership", async () => {
    mockPairedIosOperator(["operator.approvals"]);

    await expectRejectedRequest("approval-no-read");
  });

  it("does not target iOS devices rejected by the approval visibility filter", async () => {
    mockPairedIosOperator();
    const isTargetVisible = vi.fn(() => false);

    await expectRejectedRequest("approval-filtered", { isTargetVisible });
    expect(isTargetVisible).toHaveBeenCalledWith({
      deviceId: "ios-device-1",
      scopes: ["operator.approvals", "operator.read"],
    });
  });

  it("does not treat iOS as a live approval route when every push fails", async () => {
    const warn = vi.fn();
    mockPairedIosOperator();
    mocks.execAlert.mockResolvedValue({
      ...successfulApnsPushResult(),
      ok: false,
      status: 410,
      reason: "Unregistered",
    });

    const delivery = createExecApprovalIosPushDelivery({ log: { warn } });

    expect(await delivery.handleRequested(approvalRequest("approval-dead-route"))).toBe(false);
    expect(mocks.execAlert).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "exec approvals: iOS request push failed node=ios-device-1 status=410 reason=Unregistered",
    );
    expect(warn).toHaveBeenCalledWith(
      "exec approvals: iOS request push reached no devices approvalId=approval-dead-route attempted=1",
    );
  });

  it("waits for request delivery to finish before sending cleanup pushes", async () => {
    mockPairedIosOperator();
    const requestedPush = createDeferred<ReturnType<typeof successfulApnsPushResult>>();
    mocks.execAlert.mockReturnValue(requestedPush.promise);

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const requested = delivery.handleRequested(approvalRequest("approval-ordered-cleanup"));
    const resolved = delivery.handleResolved({ id: "approval-ordered-cleanup" });

    await Promise.resolve();
    expect(mocks.execWake).not.toHaveBeenCalled();

    requestedPush.resolve(successfulApnsPushResult());
    await requested;
    await resolved;

    expect(mocks.execWake).toHaveBeenCalledTimes(1);
    expect(mocks.pairing).toHaveBeenCalledTimes(1);
    expect(mocks.registrations).toHaveBeenLastCalledWith(["ios-device-1"]);
  });

  it("skips cleanup pushes when the original request target set is unknown", async () => {
    const debug = vi.fn();
    const delivery = createExecApprovalIosPushDelivery({ log: { debug } });

    await delivery.handleResolved({ id: "approval-missing-targets" });

    expect(debug).toHaveBeenCalledWith(
      "exec approvals: iOS cleanup push skipped approvalId=approval-missing-targets reason=missing-targets",
    );
    expect(mocks.pairing).not.toHaveBeenCalled();
    expect(mocks.registrations).not.toHaveBeenCalled();
    expect(mocks.execWake).not.toHaveBeenCalled();
  });

  describe("createPluginApprovalIosPushDelivery", () => {
    it("targets only paired iOS operators with approval and read scopes", async () => {
      mockPairedIosOperators(
        pairedIosOperator(approvalScopes, "ios-approved"),
        pairedIosOperator(["operator.read"], "ios-read-only"),
      );

      const delivery = createPluginApprovalIosPushDelivery({ log: {} });
      const accepted = await delivery.handleRequested(pluginApprovalRequest("plugin:direct"));

      expect(accepted).toBe(true);
      expect(mocks.registrations).toHaveBeenCalledWith(["ios-approved"]);
      expectPluginAlert({
        nodeId: "ios-approved",
        approvalId: "plugin:direct",
        gatewayDeviceId: "gateway-device-1",
        title: "Install plugin update",
        description: "Allow the plugin to update its managed package.",
      });
      expect(mocks.pluginAlert.mock.calls[0]?.[0]).not.toHaveProperty("detail");
    });

    it("uses the shared relay delivery plan for plugin alerts", async () => {
      const relayConfig = { baseUrl: "https://relay.example.test", timeoutMs: 10_000 };
      mockPairedIosOperator();
      mocks.registrations.mockResolvedValue([
        { nodeId: "ios-device-1", registration: relayApnsRegistration() },
      ]);
      mocks.relayConfig.mockReturnValue({ ok: true, value: relayConfig });

      const delivery = createPluginApprovalIosPushDelivery({ log: {} });
      const accepted = await delivery.handleRequested(pluginApprovalRequest("plugin:relay"));

      expect(accepted).toBe(true);
      expectPluginAlert({
        registration: expect.objectContaining({ transport: "relay" }),
        relayConfig,
        approvalId: "plugin:relay",
      });
      expect(mocks.directAuth).not.toHaveBeenCalled();
    });

    it("sends plugin cleanup wakes for resolved and expired requests", async () => {
      mockPairedIosOperator();
      const delivery = createPluginApprovalIosPushDelivery({ log: {} });
      const resolvedRequest = pluginApprovalRequest("plugin:resolved");
      const expiredRequest = pluginApprovalRequest("plugin:expired");

      await delivery.handleRequested(resolvedRequest);
      await delivery.handleRequested(expiredRequest);
      await delivery.handleResolved({ id: resolvedRequest.id });
      await delivery.handleExpired(expiredRequest);

      expect(mocks.pluginWake.mock.calls).toEqual([
        [expect.objectContaining({ approvalId: "plugin:resolved" })],
        [expect.objectContaining({ approvalId: "plugin:expired" })],
      ]);
    });
  });
});
