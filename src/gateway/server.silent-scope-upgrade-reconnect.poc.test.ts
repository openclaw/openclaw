import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import * as devicePairingModule from "../infra/device-pairing.js";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  connectOk,
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  startServerWithClient,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

function resolveDeviceIdentityPath(name: string): string {
  const root = process.env.OPENCLAW_STATE_DIR ?? process.env.HOME ?? os.tmpdir();
  return path.join(root, "test-device-identities", `${name}.json`);
}

function loadDeviceIdentity(name: string): {
  identityPath: string;
  identity: DeviceIdentity;
  publicKey: string;
} {
  const identityPath = resolveDeviceIdentityPath(name);
  const identity = loadOrCreateDeviceIdentity(identityPath);
  return {
    identityPath,
    identity,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
  };
}

async function pairReadScopedOperator(name: string): Promise<{
  deviceId: string;
  identityPath: string;
  deviceToken: string;
}> {
  const loaded = loadDeviceIdentity(name);
  const request = await requestDevicePairing({
    deviceId: loaded.identity.deviceId,
    publicKey: loaded.publicKey,
    role: "operator",
    scopes: ["operator.read"],
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
  await approveDevicePairing(request.request.requestId);

  const paired = await getPairedDevice(loaded.identity.deviceId);
  const deviceToken = paired?.tokens?.operator?.token ?? "";
  expect(deviceToken).toBeTruthy();
  expect(paired?.approvedScopes).toEqual(["operator.read"]);

  return {
    deviceId: loaded.identity.deviceId,
    identityPath: loaded.identityPath,
    deviceToken,
  };
}

async function openTrackedWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return ws;
}

describe("gateway silent scope-upgrade reconnect", () => {
  test("does not silently widen a read-scoped paired device to admin on shared-auth reconnect", async () => {
    const started = await startServerWithClient("secret");
    const paired = await pairReadScopedOperator("silent-scope-upgrade-reconnect-poc");

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
      expect(afterUpgradeAttempt?.tokens?.operator?.token).toBe(paired.deviceToken);

      postAttemptDeviceTokenWs = await openTrackedWs(started.port);
      const afterUpgrade = await connectReq(postAttemptDeviceTokenWs, {
        skipDefaultAuth: true,
        deviceToken: paired.deviceToken,
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

  test("accepts local silent reconnect when pairing was concurrently approved", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-reconnect-race");
    let ws: WebSocket | undefined;

    const approveOriginal = devicePairingModule.approveDevicePairing;
    let simulatedRace = false;
    const forwardApprove = async (requestId: string, optionsOrBaseDir?: unknown) => {
      if (optionsOrBaseDir && typeof optionsOrBaseDir === "object") {
        return await approveOriginal(
          requestId,
          optionsOrBaseDir as { callerScopes?: readonly string[] },
        );
      }
      return await approveOriginal(requestId);
    };
    const approveSpy = vi
      .spyOn(devicePairingModule, "approveDevicePairing")
      .mockImplementation(async (requestId: string, optionsOrBaseDir?: unknown) => {
        if (simulatedRace) {
          return await forwardApprove(requestId, optionsOrBaseDir);
        }
        simulatedRace = true;
        await forwardApprove(requestId, optionsOrBaseDir);
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
      .spyOn(devicePairingModule, "approveDevicePairing")
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
      await expect(requestedEvent).rejects.toThrow("timeout");

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
      .spyOn(devicePairingModule, "approveDevicePairing")
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
