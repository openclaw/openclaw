import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
  rotateDeviceToken,
} from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
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

async function pairDevice(params: {
  name: string;
  role: "node" | "operator";
  scopes: string[];
  clientId?: string;
  clientMode?: string;
}): Promise<{
  identityPath: string;
  identity: DeviceIdentity;
}> {
  const loaded = loadDeviceIdentity(params.name);
  const request = await requestDevicePairing({
    deviceId: loaded.identity.deviceId,
    publicKey: loaded.publicKey,
    role: params.role,
    scopes: params.scopes,
    clientId: params.clientId,
    clientMode: params.clientMode,
  });
  await approveDevicePairing(request.request.requestId);
  return {
    identityPath: loaded.identityPath,
    identity: loaded.identity,
  };
}

async function issuePairingScopedTokenForAdminApprovedDevice(name: string): Promise<{
  deviceId: string;
  identityPath: string;
  pairingToken: string;
}> {
  const paired = await pairDevice({
    name,
    role: "operator",
    scopes: ["operator.admin"],
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
  const rotated = await rotateDeviceToken({
    deviceId: paired.identity.deviceId,
    role: "operator",
    scopes: ["operator.pairing"],
  });
  expect(rotated?.token).toBeTruthy();
  return {
    deviceId: paired.identity.deviceId,
    identityPath: paired.identityPath,
    pairingToken: String(rotated?.token ?? ""),
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

async function connectPairingScopedOperator(params: {
  port: number;
  identityPath: string;
  deviceToken: string;
}): Promise<WebSocket> {
  const ws = await openTrackedWs(params.port);
  await connectOk(ws, {
    skipDefaultAuth: true,
    deviceToken: params.deviceToken,
    deviceIdentityPath: params.identityPath,
    scopes: ["operator.pairing"],
  });
  return ws;
}

async function connectApprovedNode(params: {
  port: number;
  name: string;
  onInvoke: (payload: unknown) => void;
}): Promise<GatewayClient> {
  const paired = await pairDevice({
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
    connectDelayMs: 2_000,
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
    onEvent: (event) => {
      if (event.event !== "node.invoke.request") {
        return;
      }
      params.onInvoke(event.payload);
      const payload = event.payload as { id?: string; nodeId?: string };
      if (!payload.id || !payload.nodeId) {
        return;
      }
      void client.request("node.invoke.result", {
        id: payload.id,
        nodeId: payload.nodeId,
        ok: true,
        payloadJSON: JSON.stringify({ ok: true }),
      });
    },
  });
  client.start();
  await Promise.race([
    ready,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timeout waiting for node hello")), 5_000);
    }),
  ]);
  return client;
}

async function getConnectedNodeId(ws: WebSocket): Promise<string> {
  const nodes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
    ws,
    "node.list",
    {},
  );
  expect(nodes.ok).toBe(true);
  const nodeId = nodes.payload?.nodes?.find((node) => node.connected)?.nodeId ?? "";
  expect(nodeId).toBeTruthy();
  return nodeId;
}

async function waitForMacrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("gateway device.token.rotate caller scope guard", () => {
  test("rejects rotating an admin-approved device token above the caller session scopes", async () => {
    const started = await startServerWithClient("secret");
    const attacker = await issuePairingScopedTokenForAdminApprovedDevice("rotate-attacker");

    let pairingWs: WebSocket | undefined;
    try {
      pairingWs = await connectPairingScopedOperator({
        port: started.port,
        identityPath: attacker.identityPath,
        deviceToken: attacker.pairingToken,
      });

      const rotate = await rpcReq(pairingWs, "device.token.rotate", {
        deviceId: attacker.deviceId,
        role: "operator",
        scopes: ["operator.admin"],
      });
      expect(rotate.ok).toBe(false);
      expect(rotate.error?.message).toBe("missing scope: operator.admin");

      const paired = await getPairedDevice(attacker.deviceId);
      expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
      expect(paired?.approvedScopes).toEqual(["operator.admin"]);
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("blocks the pairing-token to admin-node-invoke escalation chain", async () => {
    const started = await startServerWithClient("secret");
    const attacker = await issuePairingScopedTokenForAdminApprovedDevice("rotate-rce-attacker");

    let sawInvoke = false;
    let pairingWs: WebSocket | undefined;
    let nodeClient: GatewayClient | undefined;

    try {
      await connectOk(started.ws);
      nodeClient = await connectApprovedNode({
        port: started.port,
        name: "rotate-rce-node",
        onInvoke: () => {
          sawInvoke = true;
        },
      });
      await getConnectedNodeId(started.ws);

      pairingWs = await connectPairingScopedOperator({
        port: started.port,
        identityPath: attacker.identityPath,
        deviceToken: attacker.pairingToken,
      });

      const rotate = await rpcReq<{ token?: string }>(pairingWs, "device.token.rotate", {
        deviceId: attacker.deviceId,
        role: "operator",
        scopes: ["operator.admin"],
      });

      expect(rotate.ok).toBe(false);
      expect(rotate.error?.message).toBe("missing scope: operator.admin");
      await waitForMacrotasks();
      expect(sawInvoke).toBe(false);

      const paired = await getPairedDevice(attacker.deviceId);
      expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
      expect(paired?.tokens?.operator?.token).toBe(attacker.pairingToken);
    } finally {
      pairingWs?.close();
      nodeClient?.stop();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
