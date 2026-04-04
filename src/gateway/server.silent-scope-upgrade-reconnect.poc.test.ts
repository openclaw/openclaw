import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import * as devicePairingModule from "../infra/device-pairing.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { issueOperatorToken, openTrackedWs } from "./device-authz.test-helpers.js";
import { connectReq, installGatewayTestHooks, startServerWithClient } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway silent scope-upgrade reconnect", () => {
  test("does not silently widen a read-scoped paired device to admin on shared-auth reconnect", async () => {
    const started = await startServerWithClient("secret");
    const paired = await issueOperatorToken({
      name: "silent-scope-upgrade-reconnect-poc",
      approvedScopes: ["operator.read"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let sharedAuthReconnectWs: WebSocket | undefined;
    let postAttemptDeviceTokenWs: WebSocket | undefined;

    try {
      sharedAuthReconnectWs = await openTrackedWs(started.port);
      const sharedAuthUpgradeAttempt = await connectReq(sharedAuthReconnectWs, {
        token: "secret",
        deviceIdentityPath: paired.identityPath,
        scopes: ["operator.admin"],
      });
      expect(sharedAuthUpgradeAttempt.ok).toBe(false);
      expect(sharedAuthUpgradeAttempt.error?.message).toBe("pairing required");

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending).toHaveLength(1);
      expect(
        (sharedAuthUpgradeAttempt.error?.details as { requestId?: unknown; code?: string })
          ?.requestId,
      ).toBe(pending.pending[0]?.requestId);

      const afterUpgradeAttempt = await getPairedDevice(paired.deviceId);
      expect(afterUpgradeAttempt?.approvedScopes).toEqual(["operator.read"]);
      expect(afterUpgradeAttempt?.tokens?.operator?.scopes).toEqual(["operator.read"]);
      expect(afterUpgradeAttempt?.tokens?.operator?.token).toBe(paired.token);

      postAttemptDeviceTokenWs = await openTrackedWs(started.port);
      const afterUpgrade = await connectReq(postAttemptDeviceTokenWs, {
        skipDefaultAuth: true,
        deviceToken: paired.token,
        deviceIdentityPath: paired.identityPath,
        scopes: ["operator.admin"],
      });
      expect(afterUpgrade.ok).toBe(false);
    } finally {
      sharedAuthReconnectWs?.close();
      postAttemptDeviceTokenWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("does not let backend reconnect bypass the paired scope baseline", async () => {
    const started = await startServerWithClient("secret");
    const paired = await issueOperatorToken({
      name: "backend-scope-upgrade-reconnect-poc",
      approvedScopes: ["operator.read"],
      clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientMode: GATEWAY_CLIENT_MODES.BACKEND,
    });

    let backendReconnectWs: WebSocket | undefined;

    try {
      backendReconnectWs = await openTrackedWs(started.port);
      const reconnectAttempt = await connectReq(backendReconnectWs, {
        token: "secret",
        deviceIdentityPath: paired.identityPath,
        client: {
          id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          version: "1.0.0",
          platform: "node",
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        role: "operator",
        scopes: ["operator.admin"],
      });
      expect(reconnectAttempt.ok).toBe(false);
      expect(reconnectAttempt.error?.message).toBe("pairing required");

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending).toHaveLength(1);
      expect(
        (reconnectAttempt.error?.details as { requestId?: unknown; code?: string })?.requestId,
      ).toBe(pending.pending[0]?.requestId);

      const afterAttempt = await getPairedDevice(paired.deviceId);
      expect(afterAttempt?.approvedScopes).toEqual(["operator.read"]);
      expect(afterAttempt?.tokens?.operator?.scopes).toEqual(["operator.read"]);
      expect(afterAttempt?.tokens?.operator?.token).toBe(paired.token);
    } finally {
      backendReconnectWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
