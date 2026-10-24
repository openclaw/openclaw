import { expect, test } from "vitest";
import type { WebSocket } from "ws";
import {
  getPairedDevice,
  getPendingDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import { browserProxyAuth } from "./server.auth.test-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const CONTROL_UI_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
  version: "1.0.0",
  platform: "web",
  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
};
const TRUSTED_PROXY_ORIGIN = "https://localhost";
const TRUSTED_PROXY_HEADERS = {
  origin: TRUSTED_PROXY_ORIGIN,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "operator@example.com",
};

async function withPairingSession(
  options: {
    name: string;
    auth: "device" | "shared" | "proxy";
    admin?: boolean;
    self?: boolean;
    role?: "operator" | "node";
    roles?: string[];
    scopes?: string[];
  },
  run: (ws: WebSocket, requestId: string, deviceId: string) => Promise<void>,
) {
  const callerScopes = options.admin ? ["operator.admin"] : ["operator.pairing"];
  let started: Awaited<ReturnType<typeof startServerWithClient>>;
  const proxyHeaders = { ...TRUSTED_PROXY_HEADERS, "x-openclaw-scopes": callerScopes.join(",") };
  if (options.auth === "proxy") {
    const { replaceConfigFile } = await import("../config/config.js");
    const auth = browserProxyAuth();
    testState.gatewayAuth = auth;
    await replaceConfigFile({
      nextConfig: {
        gateway: {
          auth,
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: [TRUSTED_PROXY_ORIGIN] },
        },
      },
      afterWrite: { mode: "auto" },
    });
    started = await startServerWithClient(undefined, { auth, wsHeaders: proxyHeaders });
  } else {
    started = await startServerWithClient("secret");
  }
  let ws: WebSocket | undefined;
  try {
    const approver = await issueOperatorToken({
      name: options.name,
      approvedScopes: ["operator.admin"],
      tokenScopes: options.admin ? undefined : ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    const pending = loadDeviceIdentity(options.self ? options.name : `${options.name}-target`);
    const request = await requestDevicePairing({
      deviceId: pending.identity.deviceId,
      publicKey: pending.publicKey,
      role: options.role ?? "operator",
      roles: options.roles,
      scopes: options.scopes ?? ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    ws = await openTrackedWs(started.port, options.auth === "proxy" ? proxyHeaders : undefined);
    await connectOk(ws, {
      ...(options.auth === "device"
        ? { skipDefaultAuth: true, deviceToken: approver.token }
        : options.auth === "proxy"
          ? { skipDefaultAuth: true, client: CONTROL_UI_CLIENT }
          : { token: "secret" }),
      deviceIdentityPath: approver.identityPath,
      scopes: callerScopes,
    });
    await run(ws, request.request.requestId, pending.identity.deviceId);
  } finally {
    ws?.close();
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  }
}
const errors = {
  scope: "missing scope: operator.admin",
  approval: "device pairing approval denied",
  rejection: "device pairing rejection denied",
};
type PairingCase = Parameters<typeof withPairingSession>[0] & {
  reject?: boolean;
  error?: keyof typeof errors;
};
test.each<PairingCase>([
  { name: "scope upgrade", auth: "device", self: true, scopes: ["operator.admin"], error: "scope" },
  { name: "mixed roles", auth: "shared", roles: ["operator", "node"], error: "approval" },
  { name: "proxy node", auth: "proxy", role: "node", scopes: [], error: "approval" },
  { name: "cross-device approval", auth: "device", error: "approval" },
  { name: "proxy admin approval", auth: "proxy", admin: true, role: "node", scopes: [] },
  { name: "cross-device rejection", auth: "device", reject: true, error: "rejection" },
])("device pairing: $name", (options) =>
  withPairingSession(options, async (ws, requestId, deviceId) => {
    const result = await rpcReq(ws, options.reject ? "device.pair.reject" : "device.pair.approve", {
      requestId,
    });
    if (options.error) {
      expect(result).toMatchObject({ ok: false, error: { message: errors[options.error] } });
    } else {
      expect(result.ok).toBe(true);
    }
    if (options.reject) {
      expect((await getPendingDevicePairing(requestId))?.requestId).toBe(requestId);
    } else if (options.self) {
      expect((await getPairedDevice(deviceId))?.approvedScopes).toEqual(["operator.admin"]);
    } else if (options.admin) {
      expect(await getPairedDevice(deviceId)).toMatchObject({
        role: "node",
        tokens: { node: { role: "node" } },
      });
    } else {
      expect(await getPairedDevice(deviceId)).toBeNull();
    }
  }),
);
