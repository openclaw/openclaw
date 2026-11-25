import { setImmediate as yieldMacrotask } from "node:timers/promises";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import * as deviceTokens from "../infra/device-pairing-tokens.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
  resolveDeviceIdentityPath,
} from "./device-authz.test-helpers.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import {
  connectOk,
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServer,
} from "./test-helpers.js";

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

async function openWs() {
  const ws = await openTrackedWs(started.port);
  sockets.add(ws);
  return ws;
}
async function openClient(options?: Parameters<typeof connectOk>[1]) {
  const ws = await openWs();
  await connectOk(ws, options);
  return ws;
}
function deviceAuth(
  device: { identityPath: string; token?: string },
  scopes = ["operator.pairing"],
) {
  return {
    skipDefaultAuth: true,
    deviceToken: device.token,
    deviceIdentityPath: device.identityPath,
    scopes,
  };
}
function openDevice(device: { identityPath: string; token: string }, scopes?: string[]) {
  return openClient(deviceAuth(device, scopes));
}
function tokenRpc(
  ws: WebSocket,
  operation: "rotate" | "revoke",
  deviceId: string,
  params: { role?: string; scopes?: string[] } = {},
) {
  return rpcReq<{ token?: string; rotatedAtMs?: number; revokedAtMs?: number }>(
    ws,
    `device.token.${operation}`,
    { deviceId, role: "operator", ...params },
  );
}
function sendRequest(ws: WebSocket, id: string, method: string, params: unknown) {
  ws.send(JSON.stringify({ type: "req", id, method, params }));
}
function observeResponses(ws: WebSocket) {
  const frames: {
    id: string;
    ok: boolean;
    payload?: { token?: string; tokenDelivery?: string };
  }[] = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(rawDataToString(data));
    if (frame.type === "res") {
      frames.push(frame);
    }
  });
  const closed = new Promise<number>((resolve) => {
    ws.once("close", resolve);
  });
  return { frames, closed };
}
function issueOperator(name: string, tokenScopes?: string[]) {
  return issueOperatorToken({
    name,
    approvedScopes: ["operator.admin"],
    tokenScopes,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
}
async function issueMixedRolePairingScopedDevice(
  name: string,
  opts?: { platform?: string; nodeScopes?: string[] },
) {
  const loaded = loadDeviceIdentity(name);
  const request = await requestDevicePairing({
    deviceId: loaded.identity.deviceId,
    publicKey: loaded.publicKey,
    role: "operator",
    roles: ["operator", "node"],
    scopes: ["operator.pairing", ...(opts?.nodeScopes ?? [])],
    ...(opts?.platform ? { platform: opts.platform } : {}),
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
  const approved = await approveDevicePairing(request.request.requestId, {
    callerScopes: ["operator.pairing"],
  });
  expect(approved?.status).toBe("approved");
  if (approved?.status !== "approved") {
    throw new Error("expected mixed-role device approval");
  }
  const token = approved.device.tokens?.operator?.token;
  if (!token) {
    throw new Error(`expected operator token for paired device ${loaded.identity.deviceId}`);
  }
  expect(approved.device.tokens?.node?.token).toBeTypeOf("string");
  return { ...loaded, deviceId: loaded.identity.deviceId, token };
}
async function createRevokedNode(name: string, opts?: { platform?: string }) {
  const device = await issueMixedRolePairingScopedDevice(name, opts);
  const ws = await openClient({ token: "secret" });
  expect(await tokenRpc(ws, "revoke", device.deviceId, { role: "node" })).toMatchObject({
    ok: true,
    payload: { revokedAtMs: expect.any(Number) },
  });
  const revokedNodeToken = (await getPairedDevice(device.deviceId))?.tokens?.node;
  expect(revokedNodeToken?.revokedAtMs).toBeTypeOf("number");
  if (!revokedNodeToken) {
    throw new Error("expected revoked node token");
  }
  return { device, revokedNodeToken };
}
function expectNodeTokenStillRevoked(
  paired: Awaited<ReturnType<typeof getPairedDevice>>,
  token: Awaited<ReturnType<typeof createRevokedNode>>["revokedNodeToken"],
) {
  expect(paired?.tokens?.node?.token).toBe(token.token);
  expect(paired?.tokens?.node?.revokedAtMs).toBe(token.revokedAtMs);
}
async function expectLocalNodeReconnectDenied(
  device: Awaited<ReturnType<typeof issueMixedRolePairingScopedDevice>>,
  metadataMismatch = false,
) {
  await expect(
    connectGatewayClient({
      url: `ws://127.0.0.1:${started.port}`,
      token: "secret",
      role: "node",
      clientName: metadataMismatch
        ? GATEWAY_CLIENT_NAMES.MACOS_APP
        : GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: metadataMismatch
        ? "node-token-metadata-mismatch"
        : "node-token-removal-denied",
      clientVersion: "1.0.0",
      platform: metadataMismatch ? "macos" : "linux",
      mode: metadataMismatch ? GATEWAY_CLIENT_MODES.UI : GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: ["system.run"],
      deviceIdentity: device.identity,
      timeoutMessage: "timeout waiting for revoked node reconnect",
    }),
  ).rejects.toThrow(
    metadataMismatch ? "device metadata change pending approval" : "role upgrade pending approval",
  );
}
describe("gateway device.token.rotate/revoke ownership guard (IDOR)", () => {
  test("rejects a device-token caller rotating or revoking another device's token", async () => {
    const deviceA = await issueOperator("idor-device-a", ["operator.pairing"]);
    const deviceB = await issueOperator("idor-device-b", ["operator.pairing"]);
    const ws = await openDevice(deviceA);
    const rotate = await tokenRpc(ws, "rotate", deviceB.deviceId, {
      scopes: ["operator.pairing"],
    });
    expect(rotate).toMatchObject({ ok: false, error: { message: "device token rotation denied" } });
    expect((await getPairedDevice(deviceB.deviceId))?.tokens?.operator?.token).toBe(deviceB.token);
    expect(await tokenRpc(ws, "revoke", deviceB.deviceId)).toMatchObject({
      ok: false,
      error: { message: "device token revocation denied" },
    });
    expect(
      (await getPairedDevice(deviceB.deviceId))?.tokens?.operator?.revokedAtMs,
    ).toBeUndefined();
  });

  test.each(["device.token.rotate", "device.token.revoke", "device.pair.remove"])(
    "delivers self %s before close and fences later frames",
    async (method) => {
      const scopes = ["operator.pairing", "operator.read"];
      const device = await issueOperator(`self-${method}`, scopes);
      const before = await getPairedDevice(device.deviceId);
      const ws = await openDevice(device, scopes);
      const { frames, closed } = observeResponses(ws);
      sendRequest(ws, "mutation", method, {
        deviceId: device.deviceId,
        ...(method === "device.pair.remove" ? {} : { role: "operator" }),
      });
      sendRequest(ws, "pipelined", "device.pair.list", {});
      expect(await closed).toBe(4001);
      // Check only public response metadata: failures must never print bearer material.
      expect(frames.map(({ id, ok }) => ({ id, ok }))).toEqual([{ id: "mutation", ok: true }]);
      const after = await getPairedDevice(device.deviceId);
      if (method === "device.pair.remove") {
        expect(after).toBeNull();
      } else {
        expect(after?.approvedScopes).toEqual(before?.approvedScopes);
        expect(after?.tokens?.operator?.scopes).toEqual(scopes);
        if (method === "device.token.rotate") {
          const payload = frames[0]?.payload;
          expect(payload?.tokenDelivery).toBe("in-band");
          expect(typeof payload?.token).toBe("string");
          expect(payload?.token === device.token).toBe(false);
          expect(payload?.token === after?.tokens?.operator?.token).toBe(true);
          const replacementWs = await openWs();
          await connectOk(replacementWs, deviceAuth({ ...device, token: payload?.token }, scopes));
          replacementWs.close();
        } else {
          expect(after?.tokens?.operator?.revokedAtMs).toBeTypeOf("number");
        }
      }
      const staleWs = await openWs();
      const stale = await connectReq(staleWs, deviceAuth(device, scopes));
      expect(stale.ok).toBe(false);
      staleWs.close();
    },
  );

  test("withholds an awaited self-rotation result after another client revokes its caller", async () => {
    const device = await issueOperator("self-rotation-revoked-during-await", ["operator.pairing"]);
    const committed = createDeferredCore();
    const release = createDeferredCore();
    const finished = createDeferredCore();
    const rotate = deviceTokens.rotateDeviceToken;
    const spy = vi
      .spyOn(deviceTokens, "rotateDeviceToken")
      .mockImplementationOnce(async (params) => {
        const result = await rotate(params);
        committed.resolve();
        await release.promise;
        finished.resolve();
        return result;
      });
    const ws = await openDevice(device);
    const adminWs = await openWs();
    try {
      await connectOk(adminWs, { token: "secret" });
      const { frames, closed } = observeResponses(ws);
      sendRequest(ws, "stale-rotation", "device.token.rotate", {
        deviceId: device.deviceId,
        role: "operator",
      });
      await committed.promise;
      expect((await tokenRpc(adminWs, "revoke", device.deviceId)).ok).toBe(true);
      expect(await closed).toBe(4001);
      release.resolve();
      await finished.promise;
      await yieldMacrotask();
      await yieldMacrotask();
      expect(frames.map(({ id }) => id)).toEqual([]);
      expect((await getPairedDevice(device.deviceId))?.tokens?.operator?.revokedAtMs).toBeTypeOf(
        "number",
      );
    } finally {
      release.resolve();
      spy.mockRestore();
      ws.close();
      adminWs.close();
    }
  });

  test("allows a paired admin to rotate and revoke another device's token", async () => {
    const device = await issueOperator("idor-admin-rotate-revoke", ["operator.pairing"]);
    const caller = await issueOperator("foreign-admin-caller");
    const ws = await openDevice(caller, ["operator.admin"]);
    const rotate = await tokenRpc(ws, "rotate", device.deviceId, { scopes: ["operator.pairing"] });
    expect(rotate).toMatchObject({ ok: true, payload: { rotatedAtMs: expect.any(Number) } });
    expect(rotate.payload?.token).toBeUndefined();
    const persistedToken = (await getPairedDevice(device.deviceId))?.tokens?.operator?.token;
    if (typeof persistedToken !== "string") {
      throw new Error("expected rotated operator token to persist");
    }
    expect(persistedToken.length).toBeGreaterThan(0);
    expect(await tokenRpc(ws, "revoke", device.deviceId)).toMatchObject({
      ok: true,
      payload: { revokedAtMs: expect.any(Number) },
    });
    expect((await getPairedDevice(device.deviceId))?.tokens?.operator?.revokedAtMs).toBeTypeOf(
      "number",
    );
    expect((await rpcReq(ws, "device.pair.list", {})).ok).toBe(true);
  });

  test("rejects local node reconnect with metadata mismatch after node token revocation", async () => {
    const { device, revokedNodeToken } = await createRevokedNode(
      "same-device-node-metadata-reconnect",
      { platform: "linux" },
    );
    expect((await getPairedDevice(device.deviceId))?.platform).toBe("linux");
    await expectLocalNodeReconnectDenied(device, true);
    const paired = await getPairedDevice(device.deviceId);
    expect(paired?.platform).toBe("linux");
    expectNodeTokenStillRevoked(paired, revokedNodeToken);
  });

  test("rejects self-removal before local node reconnect after node token revocation", async () => {
    const { device, revokedNodeToken } = await createRevokedNode(
      "same-device-node-remove-reconnect",
    );
    const ws = await openDevice(device);
    const remove = await rpcReq(ws, "device.pair.remove", { deviceId: device.deviceId });
    expect(remove).toMatchObject({
      ok: false,
      error: { message: "device pairing removal denied" },
    });
    await expectLocalNodeReconnectDenied(device);
    expectNodeTokenStillRevoked(await getPairedDevice(device.deviceId), revokedNodeToken);
  });
});

describe("gateway device.token.rotate/revoke caller scope guard", () => {
  test.each(["rotate", "revoke"] as const)(
    "requires admin to %s an approved scoped node token",
    async (command) => {
      const device = await issueMixedRolePairingScopedDevice(`scoped-node-${command}`, {
        nodeScopes: ["node.exec"],
      });
      const before = await getPairedDevice(device.deviceId);
      const nodeToken = before?.tokens?.node;
      expect(nodeToken?.scopes).toEqual(["node.exec"]);
      await openClient({
        ...deviceAuth({ ...device, token: nodeToken?.token }, ["node.exec"]),
        role: "node",
      });
      for (const auth of [
        deviceAuth(device),
        {
          token: "secret",
          deviceIdentityPath: resolveDeviceIdentityPath(`scoped-node-caller-${command}`),
        },
      ]) {
        const ws = await openClient({ ...auth, scopes: ["operator.pairing"] });
        const denied = await tokenRpc(ws, command, device.deviceId, { role: " node " });
        expect(denied.ok).toBe(false);
        const unchanged = await getPairedDevice(device.deviceId);
        expect(unchanged?.tokens?.node?.token === nodeToken?.token).toBe(true);
        expect(unchanged?.tokens?.node?.revokedAtMs).toBeUndefined();
      }

      const adminWs = await openClient({ token: "secret", scopes: ["operator.admin"] });
      if (command === "rotate") {
        const outsideBaseline = await tokenRpc(adminWs, "rotate", device.deviceId, {
          role: "node",
          scopes: ["node.other"],
        });
        expect(outsideBaseline.ok).toBe(false);
        const unchanged = await getPairedDevice(device.deviceId);
        expect(unchanged?.tokens?.node?.token === nodeToken?.token).toBe(true);
      }
      const allowed = await tokenRpc(adminWs, command, device.deviceId, { role: " node " });
      expect(allowed.ok).toBe(true);
      expect(allowed.payload?.token).toBeUndefined();
      const after = await getPairedDevice(device.deviceId);
      expect(after?.tokens?.node?.scopes).toEqual(["node.exec"]);
      expect(after?.approvedScopes).toEqual(before?.approvedScopes);
      expect(after?.tokens?.operator?.token === before?.tokens?.operator?.token).toBe(true);
      if (command === "rotate") {
        expect(after?.tokens?.node?.token === nodeToken?.token).toBe(false);
        expect(after?.tokens?.node?.rotatedAtMs).toBeTypeOf("number");
      } else {
        expect(after?.tokens?.node?.revokedAtMs).toBeTypeOf("number");
      }
    },
  );

  test("rejects shared-token callers managing a whitespace-padded role above their session scopes", async () => {
    const role = " operator ";
    const target = await issueOperator(`shared-pairing-target-${role.length}`);
    const ws = await openClient({
      token: "secret",
      scopes: ["operator.pairing"],
      deviceIdentityPath: resolveDeviceIdentityPath(`shared-pairing-caller-${role.length}`),
    });
    const rotate = await tokenRpc(ws, "rotate", target.deviceId, { role });
    expect(rotate).toMatchObject({ ok: false, error: { message: "device token rotation denied" } });
    const afterRotate = await getPairedDevice(target.deviceId);
    expect(afterRotate?.tokens?.operator?.token).toBe(target.token);
    expect(afterRotate?.tokens?.operator?.revokedAtMs).toBeUndefined();
    const revoke = await tokenRpc(ws, "revoke", target.deviceId, { role });
    expect(revoke).toMatchObject({
      ok: false,
      error: { message: "device token revocation denied" },
    });
    const afterRevoke = await getPairedDevice(target.deviceId);
    expect(afterRevoke?.tokens?.operator?.token).toBe(target.token);
    expect(afterRevoke?.tokens?.operator?.revokedAtMs).toBeUndefined();
  });

  test("rejects rotating an admin-approved device token above the caller session scopes", async () => {
    const attacker = await issueOperator("rotate-attacker", ["operator.pairing"]);
    const ws = await openDevice(attacker);
    const rotate = await tokenRpc(ws, "rotate", attacker.deviceId, {
      scopes: ["operator.admin"],
    });
    expect(rotate).toMatchObject({ ok: false, error: { message: "device token rotation denied" } });
    const paired = await getPairedDevice(attacker.deviceId);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);
    expect(paired?.tokens?.operator?.token).toBe(attacker.token);
  });
});
