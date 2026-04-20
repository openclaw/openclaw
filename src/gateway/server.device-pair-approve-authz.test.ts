import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  getPairedDevice,
  getPendingDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway device.pair.approve caller scope guard", () => {
  test("rejects approving device scopes above the caller session scopes", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issueOperatorToken({
      name: "approve-attacker",
      approvedScopes: ["operator.admin"],
      tokenScopes: ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    const approverIdentity = loadDeviceIdentity("approve-attacker");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestDevicePairing({
        deviceId: approverIdentity.identity.deviceId,
        publicKey: approverIdentity.publicKey,
        role: "operator",
        scopes: ["operator.admin"],
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
      });

      pairingWs = await openTrackedWs(started.port);
      await connectOk(pairingWs, {
        skipDefaultAuth: true,
        deviceToken: approver.token,
        deviceIdentityPath: approver.identityPath,
        scopes: ["operator.pairing"],
      });

      const approve = await rpcReq(pairingWs, "device.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(false);
      expect(approve.error?.message).toBe("missing scope: operator.admin");

      const paired = await getPairedDevice(approverIdentity.identity.deviceId);
      expect(paired).not.toBeNull();
      expect(paired?.approvedScopes).toEqual(["operator.admin"]);
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("rejects approving another device from a non-admin paired-device session", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issueOperatorToken({
      name: "approve-cross-device-attacker",
      approvedScopes: ["operator.admin"],
      tokenScopes: ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    const pending = loadDeviceIdentity("approve-cross-device-target");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestDevicePairing({
        deviceId: pending.identity.deviceId,
        publicKey: pending.publicKey,
        role: "operator",
        scopes: ["operator.pairing"],
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
      });

      pairingWs = await openTrackedWs(started.port);
      await connectOk(pairingWs, {
        skipDefaultAuth: true,
        deviceToken: approver.token,
        deviceIdentityPath: approver.identityPath,
        scopes: ["operator.pairing"],
      });

      const approve = await rpcReq(pairingWs, "device.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(false);
      expect(approve.error?.message).toBe("device pairing approval denied");

      const paired = await getPairedDevice(pending.identity.deviceId);
      expect(paired).toBeNull();
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("rejects rejecting another device from a non-admin paired-device session", async () => {
    const started = await startServerWithClient("secret");
    const attacker = await issueOperatorToken({
      name: "reject-cross-device-attacker",
      approvedScopes: ["operator.admin"],
      tokenScopes: ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    const pending = loadDeviceIdentity("reject-cross-device-target");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestDevicePairing({
        deviceId: pending.identity.deviceId,
        publicKey: pending.publicKey,
        role: "operator",
        scopes: ["operator.pairing"],
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
      });

      pairingWs = await openTrackedWs(started.port);
      await connectOk(pairingWs, {
        skipDefaultAuth: true,
        deviceToken: attacker.token,
        deviceIdentityPath: attacker.identityPath,
        scopes: ["operator.pairing"],
      });

      const reject = await rpcReq(pairingWs, "device.pair.reject", {
        requestId: request.request.requestId,
      });
      expect(reject.ok).toBe(false);
      expect(reject.error?.message).toBe("device pairing rejection denied");

      const stillPending = await getPendingDevicePairing(request.request.requestId);
      expect(stillPending).not.toBeNull();
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
