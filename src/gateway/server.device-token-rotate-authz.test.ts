import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import * as deviceTokens from "../infra/device-pairing-tokens.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
  pairDeviceIdentity,
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
import {
  acknowledgeNodeInvokeRequestForTest,
  getConnectedNodeIdForTest,
} from "./test-helpers.node-invoke.js";

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
async function openDevice(
  device: { identityPath: string; token: string },
  scopes = ["operator.pairing"],
) {
  return openClient({
    skipDefaultAuth: true,
    deviceToken: device.token,
    deviceIdentityPath: device.identityPath,
    scopes,
  });
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
  const revoke = await rpcReq<{ revokedAtMs?: number }>(ws, "device.token.revoke", {
    deviceId: device.deviceId,
    role: "node",
  });
  expect(revoke.ok).toBe(true);
  expect(revoke.payload?.revokedAtMs).toBeTypeOf("number");
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
async function connectApprovedNode(params: {
  port: number;
  name: string;
  onInvoke: (payload: unknown) => void;
}): Promise<GatewayClient> {
  const paired = await pairDeviceIdentity({
    name: params.name,
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
  });

  let readyResolve: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const client = new GatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    connectChallengeTimeoutMs: 2_000,
    token: "secret",
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientVersion: "1.0.0",
    platform: "linux",
    mode: GATEWAY_CLIENT_MODES.NODE,
    scopes: [],
    commands: ["system.run"],
    deviceIdentity: paired.identity,
    onHelloOk: () => readyResolve?.(),
    onEvent: (event) =>
      acknowledgeNodeInvokeRequestForTest({
        client,
        event,
        onInvoke: params.onInvoke,
      }),
  });
  client.start();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout waiting for node hello")), 5_000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
  return client;
}

async function waitForMacrotasks() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("gateway device.token.rotate/revoke ownership guard (IDOR)", () => {
  test("rejects a device-token caller rotating or revoking another device's token", async () => {
    const deviceA = await issueOperator("idor-device-a", ["operator.pairing"]);
    const deviceB = await issueOperator("idor-device-b", ["operator.pairing"]);
    const ws = await openDevice(deviceA);
    const rotate = await rpcReq(ws, "device.token.rotate", {
      deviceId: deviceB.deviceId,
      role: "operator",
      scopes: ["operator.pairing"],
    });
    expect(rotate.ok).toBe(false);
    expect(rotate.error?.message).toBe("device token rotation denied");
    expect((await getPairedDevice(deviceB.deviceId))?.tokens?.operator?.token).toBe(deviceB.token);
    const revoke = await rpcReq(ws, "device.token.revoke", {
      deviceId: deviceB.deviceId,
      role: "operator",
    });
    expect(revoke.ok).toBe(false);
    expect(revoke.error?.message).toBe("device token revocation denied");
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
      const ws = await openWs();
      await connectOk(ws, {
        skipDefaultAuth: true,
        deviceToken: device.token,
        deviceIdentityPath: device.identityPath,
        scopes,
      });
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
      ws.send(
        JSON.stringify({
          type: "req",
          id: "mutation",
          method,
          params: {
            deviceId: device.deviceId,
            ...(method === "device.pair.remove" ? {} : { role: "operator" }),
          },
        }),
      );
      ws.send(
        JSON.stringify({ type: "req", id: "pipelined", method: "device.pair.list", params: {} }),
      );
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
          await connectOk(replacementWs, {
            skipDefaultAuth: true,
            deviceToken: payload?.token,
            deviceIdentityPath: device.identityPath,
            scopes,
          });
          replacementWs.close();
        } else {
          expect(after?.tokens?.operator?.revokedAtMs).toBeTypeOf("number");
        }
      }
      const staleWs = await openWs();
      const stale = await connectReq(staleWs, {
        skipDefaultAuth: true,
        deviceToken: device.token,
        deviceIdentityPath: device.identityPath,
        scopes,
      });
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
      const responses: string[] = [];
      ws.on("message", (data) => {
        const frame = JSON.parse(rawDataToString(data));
        if (frame.type === "res") {
          responses.push(frame.id);
        }
      });
      const closed = new Promise<number>((resolve) => {
        ws.once("close", resolve);
      });
      ws.send(
        JSON.stringify({
          type: "req",
          id: "stale-rotation",
          method: "device.token.rotate",
          params: {
            deviceId: device.deviceId,
            role: "operator",
          },
        }),
      );
      await committed.promise;
      const revoke = await rpcReq(adminWs, "device.token.revoke", {
        deviceId: device.deviceId,
        role: "operator",
      });
      expect(revoke.ok).toBe(true);
      expect(await closed).toBe(4001);
      release.resolve();
      await finished.promise;
      await waitForMacrotasks();
      expect(responses).toEqual([]);
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
    const rotate = await rpcReq<{ rotatedAtMs?: number; token?: string }>(
      ws,
      "device.token.rotate",
      {
        deviceId: device.deviceId,
        role: "operator",
        scopes: ["operator.pairing"],
      },
    );
    expect(rotate.ok).toBe(true);
    expect(rotate.payload?.rotatedAtMs).toBeTypeOf("number");
    expect(rotate.payload?.token).toBeUndefined();
    const persistedToken = (await getPairedDevice(device.deviceId))?.tokens?.operator?.token;
    if (typeof persistedToken !== "string") {
      throw new Error("expected rotated operator token to persist");
    }
    expect(persistedToken.length).toBeGreaterThan(0);
    const revoke = await rpcReq<{ revokedAtMs?: number }>(ws, "device.token.revoke", {
      deviceId: device.deviceId,
      role: "operator",
    });
    expect(revoke.ok).toBe(true);
    expect(revoke.payload?.revokedAtMs).toBeTypeOf("number");
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
    expect(remove.ok).toBe(false);
    expect(remove.error?.message).toBe("device pairing removal denied");
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
      const nodeWs = await openWs();
      await connectOk(nodeWs, {
        skipDefaultAuth: true,
        deviceToken: nodeToken?.token,
        deviceIdentityPath: device.identityPath,
        role: "node",
        scopes: ["node.exec"],
      });
      for (const auth of [
        {
          skipDefaultAuth: true,
          deviceToken: device.token,
          deviceIdentityPath: device.identityPath,
        },
        {
          token: "secret",
          deviceIdentityPath: resolveDeviceIdentityPath(`scoped-node-caller-${command}`),
        },
      ]) {
        const ws = await openWs();
        await connectOk(ws, { ...auth, scopes: ["operator.pairing"] });
        const denied = await rpcReq(ws, `device.token.${command}`, {
          deviceId: device.deviceId,
          role: " node ",
        });
        expect(denied.ok).toBe(false);
        const unchanged = await getPairedDevice(device.deviceId);
        expect(unchanged?.tokens?.node?.token === nodeToken?.token).toBe(true);
        expect(unchanged?.tokens?.node?.revokedAtMs).toBeUndefined();
      }

      const adminWs = await openWs();
      await connectOk(adminWs, { token: "secret", scopes: ["operator.admin"] });
      if (command === "rotate") {
        const outsideBaseline = await rpcReq(adminWs, "device.token.rotate", {
          deviceId: device.deviceId,
          role: "node",
          scopes: ["node.other"],
        });
        expect(outsideBaseline.ok).toBe(false);
        const unchanged = await getPairedDevice(device.deviceId);
        expect(unchanged?.tokens?.node?.token === nodeToken?.token).toBe(true);
      }
      const allowed = await rpcReq<{ token?: string }>(adminWs, `device.token.${command}`, {
        deviceId: device.deviceId,
        role: " node ",
      });
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
    const rotate = await rpcReq(ws, "device.token.rotate", { deviceId: target.deviceId, role });
    expect(rotate.ok).toBe(false);
    expect(rotate.error?.message).toBe("device token rotation denied");
    const afterRotate = await getPairedDevice(target.deviceId);
    expect(afterRotate?.tokens?.operator?.token).toBe(target.token);
    expect(afterRotate?.tokens?.operator?.revokedAtMs).toBeUndefined();
    const revoke = await rpcReq(ws, "device.token.revoke", { deviceId: target.deviceId, role });
    expect(revoke.ok).toBe(false);
    expect(revoke.error?.message).toBe("device token revocation denied");
    const afterRevoke = await getPairedDevice(target.deviceId);
    expect(afterRevoke?.tokens?.operator?.token).toBe(target.token);
    expect(afterRevoke?.tokens?.operator?.revokedAtMs).toBeUndefined();
  });

  test("rejects rotating an admin-approved device token above the caller session scopes", async () => {
    const attacker = await issueOperator("rotate-attacker", ["operator.pairing"]);
    const ws = await openDevice(attacker);
    const rotate = await rpcReq(ws, "device.token.rotate", {
      deviceId: attacker.deviceId,
      role: "operator",
      scopes: ["operator.admin"],
    });
    expect(rotate.ok).toBe(false);
    expect(rotate.error?.message).toBe("device token rotation denied");
    const paired = await getPairedDevice(attacker.deviceId);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);
  });
  test("blocks the pairing-token to admin-node-invoke escalation chain", async () => {
    const attacker = await issueOperator("rotate-rce-attacker", ["operator.pairing"]);
    let sawInvoke = false;
    let pairingWs: WebSocket | undefined;
    let nodeClient: GatewayClient | undefined;
    try {
      const adminWs = await openClient({ token: "secret" });
      nodeClient = await connectApprovedNode({
        port: started.port,
        name: "rotate-rce-node",
        onInvoke: () => {
          sawInvoke = true;
        },
      });
      await getConnectedNodeIdForTest(adminWs);
      pairingWs = await openDevice(attacker);
      const rotate = await rpcReq(pairingWs, "device.token.rotate", {
        deviceId: attacker.deviceId,
        role: "operator",
        scopes: ["operator.admin"],
      });
      expect(rotate.ok).toBe(false);
      expect(rotate.error?.message).toBe("device token rotation denied");
      await waitForMacrotasks();
      expect(sawInvoke).toBe(false);
      const paired = await getPairedDevice(attacker.deviceId);
      expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
      expect(paired?.tokens?.operator?.token).toBe(attacker.token);
    } finally {
      pairingWs?.close();
      nodeClient?.stop();
    }
  });
});
