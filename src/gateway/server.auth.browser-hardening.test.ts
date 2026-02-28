import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import {
  connectReq,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const TEST_OPERATOR_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.TEST,
  version: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.TEST,
};

const originForPort = (port: number) => `http://127.0.0.1:${port}`;

const openWs = async (port: number, headers?: Record<string, string>) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
};

async function createSignedDevice(params: {
  token: string;
  scopes: string[];
  clientId: string;
  clientMode: string;
  identityPath?: string;
  nonce: string;
  signedAtMs?: number;
}) {
  const identity = params.identityPath
    ? loadOrCreateDeviceIdentity(params.identityPath)
    : loadOrCreateDeviceIdentity();
  const signedAtMs = params.signedAtMs ?? Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: "operator",
    scopes: params.scopes,
    signedAtMs,
    token: params.token,
    nonce: params.nonce,
  });
  return {
    identity,
    device: {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce: params.nonce,
    },
  };
}

describe("gateway auth browser hardening", () => {
  test("rejects non-local browser origins for non-control-ui clients", async () => {
    testState.gatewayAuth = { mode: "token", token: "secret" };
    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, { origin: "https://attacker.example" });
      try {
        const res = await connectReq(ws, {
          token: "secret",
          client: TEST_OPERATOR_CLIENT,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("origin not allowed");
      } finally {
        ws.close();
      }
    });
  });

  test("rate-limits browser-origin auth failures on loopback even when loopback exemption is enabled", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: true },
    };
    await withGatewayServer(async ({ port }) => {
      const firstWs = await openWs(port, { origin: originForPort(port) });
      try {
        const first = await connectReq(firstWs, { token: "wrong" });
        expect(first.ok).toBe(false);
        expect(first.error?.message ?? "").not.toContain("retry later");
      } finally {
        firstWs.close();
      }

      const secondWs = await openWs(port, { origin: originForPort(port) });
      try {
        const second = await connectReq(secondWs, { token: "wrong" });
        expect(second.ok).toBe(false);
        expect(second.error?.message ?? "").toContain("retry later");
      } finally {
        secondWs.close();
      }
    });
  });

  test("does not silently auto-pair non-control-ui browser clients on loopback", async () => {
    const { listDevicePairing } = await import("../infra/device-pairing.js");
    testState.gatewayAuth = { mode: "token", token: "secret" };

    await withGatewayServer(async ({ port }) => {
      const browserWs = await openWs(port, { origin: originForPort(port) });
      try {
        const nonce = await readConnectChallengeNonce(browserWs);
        expect(typeof nonce).toBe("string");
        const { identity, device } = await createSignedDevice({
          token: "secret",
          scopes: ["operator.admin"],
          clientId: TEST_OPERATOR_CLIENT.id,
          clientMode: TEST_OPERATOR_CLIENT.mode,
          identityPath: path.join(os.tmpdir(), `openclaw-browser-device-${randomUUID()}.json`),
          nonce: String(nonce ?? ""),
        });
        const res = await connectReq(browserWs, {
          token: "secret",
          scopes: ["operator.admin"],
          client: TEST_OPERATOR_CLIENT,
          device,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("pairing required");

        const pairing = await listDevicePairing();
        const pending = pairing.pending.find((entry) => entry.deviceId === identity.deviceId);
        expect(pending).toBeTruthy();
        expect(pending?.silent).toBe(false);
      } finally {
        browserWs.close();
      }
    });
  });
});
