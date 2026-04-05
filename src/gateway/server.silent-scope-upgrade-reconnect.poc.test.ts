import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import * as devicePairingModule from "../infra/device-pairing.js";
import { getPairedDevice, LOCAL_SILENT_OPERATOR_SCOPES } from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import {
  connectOk,
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway silent scope-upgrade reconnect", () => {
  test("first local shared-auth pairing keeps the session alive but bounds the issued device token", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-local-first-pair-bounded");
    let ws: WebSocket | undefined;

    try {
      ws = await openTrackedWs(started.port);
      const res = await connectReq(ws, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
      });
      expect(res.ok).toBe(true);

      const payload = res.payload as
        | {
            type?: string;
            auth?: { deviceToken?: string; scopes?: string[] };
            snapshot?: {
              configPath?: string;
              stateDir?: string;
              authMode?: string;
            };
          }
        | undefined;
      expect(payload?.type).toBe("hello-ok");
      expect(payload?.auth?.scopes).toEqual([...LOCAL_SILENT_OPERATOR_SCOPES]);
      expect(typeof payload?.auth?.deviceToken).toBe("string");
      expect(typeof payload?.snapshot?.configPath).toBe("string");
      expect((payload?.snapshot?.configPath ?? "").length).toBeGreaterThan(0);
      expect(typeof payload?.snapshot?.stateDir).toBe("string");
      expect((payload?.snapshot?.stateDir ?? "").length).toBeGreaterThan(0);
      expect(payload?.snapshot?.authMode).toBe("token");

      const paired = await getPairedDevice(loaded.identity.deviceId);
      expect(paired?.approvedScopes).toEqual([...LOCAL_SILENT_OPERATOR_SCOPES]);
      expect(paired?.tokens?.operator?.scopes).toEqual([...LOCAL_SILENT_OPERATOR_SCOPES]);
    } finally {
      ws?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("does not silently widen a read-scoped paired device to admin on shared-auth reconnect", async () => {
    const started = await startServerWithClient("secret");
    const paired = await issueOperatorToken({
      name: "silent-scope-upgrade-reconnect-poc",
      approvedScopes: ["operator.read"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let watcherWs: WebSocket | undefined;
    let sharedAuthReconnectWs: WebSocket | undefined;
    let postAttemptDeviceTokenWs: WebSocket | undefined;

    try {
      watcherWs = await openTrackedWs(started.port);
      await connectOk(watcherWs, { scopes: ["operator.admin"] });
      const requestedEvent = onceMessage(
        watcherWs,
        (obj) => obj.type === "event" && obj.event === "device.pair.requested",
      );
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
      const requested = (await requestedEvent) as {
        payload?: { requestId?: string; deviceId?: string; scopes?: string[] };
      };
      expect(requested.payload?.requestId).toBe(pending.pending[0]?.requestId);
      expect(requested.payload?.deviceId).toBe(paired.deviceId);
      expect(requested.payload?.scopes).toEqual(["operator.admin"]);

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
      watcherWs?.close();
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

    let watcherWs: WebSocket | undefined;
    let backendReconnectWs: WebSocket | undefined;

    try {
      watcherWs = await openTrackedWs(started.port);
      await connectOk(watcherWs, { scopes: ["operator.admin"] });
      const requestedEvent = onceMessage(
        watcherWs,
        (obj) => obj.type === "event" && obj.event === "device.pair.requested",
      );

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

      const requested = (await requestedEvent) as {
        payload?: { requestId?: string; deviceId?: string; scopes?: string[] };
      };
      expect(requested.payload?.requestId).toBe(pending.pending[0]?.requestId);
      expect(requested.payload?.deviceId).toBe(paired.deviceId);
      expect(requested.payload?.scopes).toEqual(["operator.admin"]);

      const afterAttempt = await getPairedDevice(paired.deviceId);
      expect(afterAttempt?.approvedScopes).toEqual(["operator.read"]);
      expect(afterAttempt?.tokens?.operator?.scopes).toEqual(["operator.read"]);
      expect(afterAttempt?.tokens?.operator?.token).toBe(paired.token);
    } finally {
      watcherWs?.close();
      backendReconnectWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("accepts local silent reconnect when pairing was concurrently approved", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-reconnect-race");
    let ws: WebSocket | undefined;

    const approveOriginal = devicePairingModule.approveSilentLocalOperatorDevicePairing;
    let simulatedRace = false;
    const forwardApprove = async (requestId: string) => await approveOriginal(requestId);
    const approveSpy = vi
      .spyOn(devicePairingModule, "approveSilentLocalOperatorDevicePairing")
      .mockImplementation(async (requestId: string) => {
        if (simulatedRace) {
          return await forwardApprove(requestId);
        }
        simulatedRace = true;
        await forwardApprove(requestId);
        return null;
      });

    try {
      ws = await openTrackedWs(started.port);
      const res = await connectReq(ws, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
      });
      expect(res.ok).toBe(true);

      const paired = await getPairedDevice(loaded.identity.deviceId);
      expect(paired?.publicKey).toBe(loaded.publicKey);
      expect(paired?.tokens?.operator?.token).toBeTruthy();
    } finally {
      approveSpy.mockRestore();
      ws?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("does not rebroadcast a deleted silent pairing request after a concurrent rejection", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-reconnect-reject-race");
    let ws: WebSocket | undefined;

    const approveSpy = vi
      .spyOn(devicePairingModule, "approveSilentLocalOperatorDevicePairing")
      .mockImplementation(async (requestId: string) => {
        await devicePairingModule.rejectDevicePairing(requestId);
        return null;
      });

    try {
      await connectOk(started.ws, { scopes: ["operator.pairing"], device: null });
      const requestedEvent = onceMessage(
        started.ws,
        (obj) => obj.type === "event" && obj.event === "device.pair.requested",
        300,
      );
      const requestedEventTimeout = expect(requestedEvent).rejects.toThrow("timeout");

      ws = await openTrackedWs(started.port);
      const res = await connectReq(ws, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("pairing required");
      expect(
        (res.error?.details as { requestId?: unknown; code?: string } | undefined)?.requestId,
      ).toBeUndefined();
      await requestedEventTimeout;

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending).toEqual([]);
    } finally {
      approveSpy.mockRestore();
      ws?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("returns the replacement pending request id when a silent request is superseded", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-reconnect-supersede-race");
    let ws: WebSocket | undefined;
    let replacementRequestId = "";

    const approveSpy = vi
      .spyOn(devicePairingModule, "approveSilentLocalOperatorDevicePairing")
      .mockImplementation(async (_requestId: string) => {
        const replacement = await devicePairingModule.requestDevicePairing({
          deviceId: loaded.identity.deviceId,
          publicKey: loaded.publicKey,
          role: "operator",
          scopes: ["operator.read"],
          clientId: GATEWAY_CLIENT_NAMES.TEST,
          clientMode: GATEWAY_CLIENT_MODES.TEST,
          silent: false,
        });
        replacementRequestId = replacement.request.requestId;
        return null;
      });

    try {
      ws = await openTrackedWs(started.port);
      const res = await connectReq(ws, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("pairing required");
      expect(replacementRequestId).toBeTruthy();
      expect(
        (res.error?.details as { requestId?: unknown; code?: string } | undefined)?.requestId,
      ).toBe(replacementRequestId);

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending.map((entry) => entry.requestId)).toContain(replacementRequestId);
    } finally {
      approveSpy.mockRestore();
      ws?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
