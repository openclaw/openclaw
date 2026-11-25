// Device auth test helpers create paired operator/node identities and tracked
// WebSocket clients for gateway authorization suites.
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.js";
import { acquireGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { trackConnectChallengeNonce } from "./test-helpers.js";

export function resolveDeviceIdentityPath(name: string): string {
  const root = process.env.OPENCLAW_STATE_DIR ?? process.env.HOME ?? os.tmpdir();
  return path.join(root, "test-device-identities", name, "client", "credentials.sqlite");
}

export function loadDeviceIdentity(name: string) {
  const identityPath = resolveDeviceIdentityPath(name);
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });
  return {
    identityPath,
    identity,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
  };
}

export async function pairDeviceIdentity(params: {
  name: string;
  role: "node" | "operator";
  scopes: string[];
  clientId?: string;
  clientMode?: string;
  platform?: string;
  deviceFamily?: string;
}): Promise<ReturnType<typeof loadDeviceIdentity>> {
  const { name, ...pairing } = params;
  const loaded = loadDeviceIdentity(name);
  const request = await requestDevicePairing({
    deviceId: loaded.identity.deviceId,
    publicKey: loaded.publicKey,
    ...pairing,
  });
  await approveDevicePairing(request.request.requestId, {
    callerScopes: params.scopes,
  });
  return loaded;
}

export async function issueOperatorToken(params: {
  name: string;
  approvedScopes: string[];
  tokenScopes?: string[];
  clientId?: string;
  clientMode?: string;
}) {
  const paired = await pairDeviceIdentity({
    name: params.name,
    role: "operator",
    scopes: params.approvedScopes,
    clientId: params.clientId,
    clientMode: params.clientMode,
  });
  const deviceId = paired.identity.deviceId;
  let token: string | undefined;
  if (params.tokenScopes) {
    const rotated = await rotateDeviceToken({
      deviceId,
      role: "operator",
      scopes: params.tokenScopes,
    });
    expect(rotated.ok).toBe(true);
    token = rotated.ok ? rotated.entry.token : undefined;
  } else {
    const device = await getPairedDevice(deviceId);
    token = device?.tokens?.operator?.token;
    expect(device?.approvedScopes).toEqual(params.approvedScopes);
  }
  if (!token) {
    throw new Error(`expected operator token for device ${deviceId}`);
  }
  return { deviceId, identityPath: paired.identityPath, token };
}

export async function openTrackedWs(
  port: number,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
  trackConnectChallengeNonce(ws);
  return await acquireGatewayTestWebSocket(ws, 5_000);
}
