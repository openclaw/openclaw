import { afterEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { withinTest } from "../../test/helpers/promise.js";
import {
  getBoundDeviceBootstrapContext,
  issueDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "../infra/device-bootstrap.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import * as deviceTokens from "../infra/device-pairing-tokens.js";
import { DevicePairingAuthorityRefusedError } from "../infra/device-pairing-worker.js";
import * as pairing from "../infra/device-pairing.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import { connectOk, installGatewayTestHooks, rpcReq, startServer } from "./test-helpers.js";

let started: Awaited<ReturnType<typeof startServer>>;
const sockets = new Set<WebSocket>();
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    started = await startServer("secret");
  },
  cleanup: async () => {
    await started.server.close();
    started.envSnapshot.restore();
  },
});
afterEach(() => {
  for (const ws of sockets) {
    ws.close();
  }
  sockets.clear();
});

async function connectDevice(device: { identityPath: string; token: string }) {
  const ws = await openTrackedWs(started.port);
  sockets.add(ws);
  await connectOk(ws, {
    skipDefaultAuth: true,
    deviceToken: device.token,
    deviceIdentityPath: device.identityPath,
    scopes: ["operator.pairing"],
  });
  return ws;
}

async function seedRepair(deviceId: string) {
  const publicKey = "synthetic-repair-key";
  await pairing.requestDevicePairing({ deviceId, publicKey, role: "operator" });
  const { token } = await issueDeviceBootstrapToken();
  const credential = { token, deviceId, publicKey };
  expect(
    await verifyDeviceBootstrapToken({ ...credential, role: "node", scopes: [] }),
  ).toMatchObject({
    ok: true,
  });
  return credential;
}

async function snapshot(credential: Awaited<ReturnType<typeof seedRepair>>) {
  return {
    pairing: await pairing.listDevicePairing(),
    bootstrap: await getBoundDeviceBootstrapContext(credential),
  };
}

describe("gateway device.pair.clear final authority", () => {
  test("preserves paired repairs and bootstrap state when a non-admin mixed-role device clears", async () => {
    const loaded = loadDeviceIdentity("clear-mixed-role");
    const request = await pairing.requestDevicePairing({
      deviceId: loaded.identity.deviceId,
      publicKey: loaded.publicKey,
      role: "operator",
      roles: ["operator", "node"],
      scopes: ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    const approved = await approveDevicePairing(request.request.requestId, {
      callerScopes: ["operator.admin"],
    });
    if (approved?.status !== "approved" || !approved.device.tokens?.operator?.token) {
      throw new Error("expected mixed-role pairing");
    }
    const ws = await connectDevice({
      identityPath: loaded.identityPath,
      token: approved.device.tokens.operator.token,
    });
    const credential = await seedRepair(loaded.identity.deviceId);
    const before = await snapshot(credential);
    expect(before.bootstrap).not.toBeNull();

    const result = await rpcReq(ws, "device.pair.clear", { pending: true });

    expect(result).toMatchObject({ ok: false, error: { message: "device pairing clear denied" } });
    expect(await snapshot(credential)).toEqual(before);
  });

  test("refuses the queued clear after another client revokes its caller", async ({ signal }) => {
    const device = await issueOperatorToken({
      name: "clear-revoked-while-queued",
      approvedScopes: ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    const ws = await connectDevice(device);
    const adminWs = await openTrackedWs(started.port);
    sockets.add(adminWs);
    await connectOk(adminWs, { token: "secret" });
    const credential = await seedRepair(device.deviceId);
    const before = await snapshot(credential);
    const locked = createDeferredCore();
    const release = createDeferredCore();
    const revokeQueued = createDeferredCore();
    const clearQueued = createDeferredCore();
    let clearWork: ReturnType<typeof pairing.clearDevicePairing> | undefined;
    const clear = pairing.clearDevicePairing;
    const revoke = deviceTokens.revokeDeviceToken;
    // These observers forward to the real owners; the existing lock controls queue order.
    const observedClear = vi.spyOn(pairing, "clearDevicePairing").mockImplementation((...args) => {
      clearWork = clear(...args);
      clearQueued.resolve();
      return clearWork;
    });
    const observedRevoke = vi
      .spyOn(deviceTokens, "revokeDeviceToken")
      .mockImplementation((...args) => {
        const work = revoke(...args);
        revokeQueued.resolve();
        return work;
      });
    const holding = withDevicePairingLock(async () => {
      locked.resolve();
      await release.promise;
    });
    let revoking: ReturnType<typeof rpcReq> | undefined;
    try {
      await withinTest(locked.promise, signal);
      revoking = rpcReq(adminWs, "device.token.revoke", {
        deviceId: device.deviceId,
        role: "operator",
      });
      await withinTest(revokeQueued.promise, signal);
      ws.send(
        JSON.stringify({
          type: "req",
          id: "queued-clear",
          method: "device.pair.clear",
          params: { pending: true },
        }),
      );
      await withinTest(clearQueued.promise, signal);
      release.resolve();
      expect(await withinTest(revoking, signal)).toMatchObject({ ok: true });
      await expect(withinTest(clearWork!, signal)).rejects.toThrow(
        DevicePairingAuthorityRefusedError,
      );
      const after = await snapshot(credential);
      expect(after.pairing.pending).toEqual(before.pairing.pending);
      expect(after.pairing.paired.map((entry) => entry.deviceId)).toEqual(
        before.pairing.paired.map((entry) => entry.deviceId),
      );
      expect(
        after.pairing.paired.find((entry) => entry.deviceId === device.deviceId)?.tokens?.operator
          ?.revokedAtMs,
      ).toBeTypeOf("number");
      expect(before.bootstrap).not.toBeNull();
      expect(after.bootstrap).toEqual(before.bootstrap);
    } finally {
      release.resolve();
      await Promise.allSettled([holding, revoking, clearWork]);
      observedClear.mockRestore();
      observedRevoke.mockRestore();
    }
  });
});
