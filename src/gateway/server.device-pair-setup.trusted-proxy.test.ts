import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test } from "vitest";
import type { DevicePairSetupCodeResult } from "../../packages/gateway-protocol/src/index.js";
import { replaceConfigFile } from "../config/config.js";
import { loadDeviceBootstrapTokenRecords } from "../infra/device-pairing-store.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { decodePairingSetupCode } from "../pairing/setup-code.js";
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
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const PROXY_HEADERS = {
  origin: "https://gateway.example.test",
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "operator@example.test",
};
const CONTROL_UI_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
  version: "1.0.0",
  platform: "web",
  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
};
const HANDOFF_SCOPES = [
  "operator.admin",
  "operator.approvals",
  "operator.questions",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
];

test.each(["mobile", "node"] as const)("trusted-proxy %s pairing", async (profile) => {
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  await replaceConfigFile({
    nextConfig: {
      gateway: {
        auth,
        trustedProxies: ["127.0.0.1"],
        controlUi: { allowedOrigins: [PROXY_HEADERS.origin] },
      },
    },
    afterWrite: { mode: "auto" },
  });
  const started = await startServerWithClient(undefined, { auth, wsHeaders: PROXY_HEADERS });
  const sockets = [started.ws];
  try {
    // Existing paired operators supply the authority to mint, independently
    // from the proxy identity and the new phone's bootstrap credential.
    for (const scopes of [["operator.pairing"], ["operator.admin"]]) {
      const operator = await issueOperatorToken({
        name: `setup-${scopes[0]}`,
        approvedScopes: scopes,
        clientId: CONTROL_UI_CLIENT.id,
        clientMode: CONTROL_UI_CLIENT.mode,
      });
      const ws = await openTrackedWs(started.port, PROXY_HEADERS);
      sockets.push(ws);
      await connectOk(ws, {
        skipDefaultAuth: true,
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: operator.identityPath,
        scopes,
      });
      const result = await rpcReq<DevicePairSetupCodeResult>(ws, "device.pair.setupCode", {
        includeQr: false,
        publicUrl: "wss://gateway.example.test",
        ...(profile === "node" ? { bootstrapProfile: "node" } : {}),
      });
      if (!scopes.includes("operator.admin")) {
        expect(result.ok).toBe(false);
        expect(result.error?.message).toBe("missing scope: operator.admin");
        expect(Object.keys(loadDeviceBootstrapTokenRecords())).toEqual([]);
        continue;
      }
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      expect(result.payload).toMatchObject({
        auth: "trusted-proxy",
        access: profile === "node" ? "node" : "full",
      });
      const setup = result.payload;
      if (!setup) {
        throw new Error("missing setup result");
      }
      const payload = decodePairingSetupCode(setup.setupCode);
      expect(payload).not.toHaveProperty("token");
      expect(payload).not.toHaveProperty("password");
      expect(payload.expiresAtMs).toBeGreaterThan(Date.now());
      expect(payload.expiresAtMs).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
      const phone = loadDeviceIdentity("trusted-proxy-setup-phone");
      const nodeClient = {
        id: profile === "node" ? GATEWAY_CLIENT_NAMES.NODE_HOST : "openclaw-ios",
        version: "2026.9.1",
        platform: profile === "node" ? "linux" : "iOS 26.6.1",
        ...(profile === "mobile" ? { deviceFamily: "iPhone" } : {}),
        mode: "node" as const,
      };
      // Machine routes preserve proxy attribution but assert no operator identity.
      const nodeHeaders: Record<string, string> = { ...PROXY_HEADERS };
      if (profile === "node") {
        delete nodeHeaders["x-forwarded-user"];
      }
      const node = await openTrackedWs(started.port, nodeHeaders);
      sockets.push(node);
      const connected = await connectReq(node, {
        skipDefaultAuth: true,
        bootstrapToken: payload.bootstrapToken,
        role: "node",
        scopes: [],
        client: nodeClient,
        deviceIdentityPath: phone.identityPath,
      });
      expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
      const handoff = connected.payload?.auth;
      expect(isRecord(handoff)).toBe(true);
      if (!isRecord(handoff)) {
        throw new Error("missing bootstrap handoff");
      }
      expect(handoff).toMatchObject({
        role: "node",
        scopes: [],
        deviceToken: expect.any(String),
      });
      if (profile === "mobile") {
        expect(handoff.deviceTokens).toContainEqual(
          expect.objectContaining({
            role: "operator",
            scopes: HANDOFF_SCOPES,
            deviceToken: expect.any(String),
          }),
        );
        expect((await getPairedDevice(phone.identity.deviceId))?.tokens?.operator?.scopes).toEqual(
          HANDOFF_SCOPES,
        );
      } else {
        expect((await getPairedDevice(phone.identity.deviceId))?.tokens?.operator).toBeUndefined();
        expect(await rpcReq(node, "config.get", {})).toMatchObject({ ok: false });
        // Reconnect with the issued node token, without proxy identity or setup code.
        for (const role of ["node", "operator"] as const) {
          const reconnect = await openTrackedWs(started.port, nodeHeaders);
          sockets.push(reconnect);
          const reconnected = await connectReq(reconnect, {
            skipDefaultAuth: true,
            deviceToken: String(handoff.deviceToken),
            role,
            scopes: role === "node" ? [] : ["operator.admin"],
            client: nodeClient,
            deviceIdentityPath: phone.identityPath,
          });
          expect(reconnected.ok, JSON.stringify(reconnected.error)).toBe(role === "node");
        }
      }
      expect((await listDevicePairing()).pending).toEqual([]);
      expect(Object.keys(loadDeviceBootstrapTokenRecords())).toEqual([]);

      for (const authenticatedProxy of [true, false]) {
        // A paired phone may still authenticate through the proxy. Remove only
        // its identity assertion to test the consumed bootstrap as the sole credential.
        const headers: Record<string, string> = { ...PROXY_HEADERS };
        if (!authenticatedProxy) {
          delete headers["x-forwarded-user"];
        }
        const replay = await openTrackedWs(started.port, headers);
        sockets.push(replay);
        const reconnected = await connectReq(replay, {
          skipDefaultAuth: true,
          bootstrapToken: payload.bootstrapToken,
          role: "node",
          scopes: [],
          client: nodeClient,
          deviceIdentityPath: phone.identityPath,
        });
        expect(reconnected.ok).toBe(authenticatedProxy);
        if (!authenticatedProxy) {
          expect(reconnected.error?.details).toMatchObject({
            authReason: "bootstrap_token_invalid",
          });
        }
      }
    }
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await started.server.close();
    started.envSnapshot.restore();
  }
});
