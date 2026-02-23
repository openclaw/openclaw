import { writeFile } from "node:fs/promises";
import { WebSocket } from "ws";
import {
  type DeviceIdentity,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { rawDataToString } from "../infra/ws.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { startGatewayServer } from "./server.js";

export async function getFreeGatewayPort(): Promise<number> {
  return await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 3, 4] });
}

export async function connectGatewayClient(params: {
  url: string;
  token?: string;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  mode?: GatewayClientMode;
  platform?: string;
  role?: "operator" | "node";
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  instanceId?: string;
  deviceIdentity?: DeviceIdentity;
  onEvent?: (evt: { event?: string; payload?: unknown }) => void;
  connectDelayMs?: number;
  timeoutMs?: number;
  timeoutMessage?: string;
}) {
  return await new Promise<InstanceType<typeof GatewayClient>>((resolve, reject) => {
    let settled = false;
    const stop = (err?: Error, client?: InstanceType<typeof GatewayClient>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(client as InstanceType<typeof GatewayClient>);
      }
    };
    const client = new GatewayClient({
      url: params.url,
      token: params.token,
      connectDelayMs: params.connectDelayMs ?? 0,
      clientName: params.clientName ?? GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: params.clientDisplayName ?? "vitest",
      clientVersion: params.clientVersion ?? "dev",
      platform: params.platform,
      mode: params.mode ?? GATEWAY_CLIENT_MODES.TEST,
      role: params.role,
      scopes: params.scopes,
      caps: params.caps,
      commands: params.commands,
      instanceId: params.instanceId,
      deviceIdentity: params.deviceIdentity,
      onEvent: params.onEvent,
      onHelloOk: () => stop(undefined, client),
      onConnectError: (err) => stop(err),
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
    });
    const timer = setTimeout(
      () => stop(new Error(params.timeoutMessage ?? "gateway connect timeout")),
      params.timeoutMs ?? 10_000,
    );
    timer.unref();
    client.start();
  });
}

export async function connectDeviceAuthReq(params: { url: string; token?: string }) {
  const ws = new WebSocket(params.url);
  const connectNoncePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timeout waiting for connect challenge")),
      5000,
    );
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${rawDataToString(reason)}`));
    };
    const handler = (data: WebSocket.RawData) => {
      try {
        const obj = JSON.parse(rawDataToString(data)) as {
          type?: unknown;
          event?: unknown;
          payload?: { nonce?: unknown } | null;
        };
        if (obj.type !== "event" || obj.event !== "connect.challenge") {
          return;
        }
        const nonce = obj.payload?.nonce;
        if (typeof nonce !== "string" || nonce.trim().length === 0) {
          return;
        }
        clearTimeout(timer);
        ws.off("message", handler);
        ws.off("close", closeHandler);
        resolve(nonce.trim());
      } catch {
        // ignore parse errors while waiting for challenge
      }
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
  await new Promise<void>((resolve) => ws.once("open", resolve));
  const connectNonce = await connectNoncePromise;
  const identity = loadOrCreateDeviceIdentity();
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
    role: "operator",
    scopes: [],
    signedAtMs,
    token: params.token ?? null,
    nonce: connectNonce,
  });
  const device = {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce: connectNonce,
  };
  ws.send(
    JSON.stringify({
      type: "req",
      id: "c1",
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: GATEWAY_CLIENT_NAMES.TEST,
          displayName: "vitest",
          version: "dev",
          platform: process.platform,
          mode: GATEWAY_CLIENT_MODES.TEST,
        },
        caps: [],
        auth: params.token ? { token: params.token } : undefined,
        device,
      },
    }),
  );
  const res = await new Promise<{
    type: "res";
    id: string;
    ok: boolean;
    error?: { message?: string };
  }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 5000);
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${rawDataToString(reason)}`));
    };
    const handler = (data: WebSocket.RawData) => {
      const obj = JSON.parse(rawDataToString(data)) as { type?: unknown; id?: unknown };
      if (obj?.type !== "res" || obj?.id !== "c1") {
        return;
      }
      clearTimeout(timer);
      ws.off("message", handler);
      ws.off("close", closeHandler);
      resolve(
        obj as {
          type: "res";
          id: string;
          ok: boolean;
          error?: { message?: string };
        },
      );
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
  ws.close();
  return res;
}

export async function startGatewayWithClient(params: {
  cfg: unknown;
  configPath: string;
  token: string;
  clientDisplayName?: string;
}) {
  await writeFile(params.configPath, `${JSON.stringify(params.cfg, null, 2)}\n`);
  process.env.OPENCLAW_CONFIG_PATH = params.configPath;

  const port = await getFreeGatewayPort();
  const server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token: params.token },
    controlUiEnabled: false,
  });
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token: params.token,
    clientDisplayName: params.clientDisplayName,
  });

  return { port, server, client };
}
