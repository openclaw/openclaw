import { describe, expect, test } from "vitest";
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
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
await Promise.all([
  import("./server.js"),
  import("../infra/device-identity.js"),
  import("../infra/device-pairing.js"),
]);

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

type PairingSession = {
  ws: WebSocket;
  requestId: string;
  deviceId: string;
};
async function withPairingSession(
  options: {
    name: string;
    auth: "device" | "shared" | "proxy";
    admin?: boolean;
    self?: boolean;
    role: "operator" | "node";
    roles?: string[];
    scopes: string[];
  },
  run: (session: PairingSession) => Promise<void>,
) {
  const callerScopes = options.admin ? ["operator.admin"] : ["operator.pairing"];
  let started: Awaited<ReturnType<typeof startServerWithClient>>;
  const proxyHeaders = { ...TRUSTED_PROXY_HEADERS, "x-openclaw-scopes": callerScopes.join(",") };
  if (options.auth === "proxy") {
    const { replaceConfigFile } = await import("../config/config.js");
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
      role: options.role,
      roles: options.roles,
      scopes: options.scopes,
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
    await run({ ws, requestId: request.request.requestId, deviceId: pending.identity.deviceId });
  } finally {
    ws?.close();
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  }
}
async function expectApprovalDenied({ ws, requestId, deviceId }: PairingSession) {
  const approve = await rpcReq(ws, "device.pair.approve", { requestId });
  expect(approve.ok).toBe(false);
  expect(approve.error?.message).toBe("device pairing approval denied");
  expect(await getPairedDevice(deviceId)).toBeNull();
}

describe("gateway device.pair.approve caller scope guard", () => {
  test("rejects approving device scopes above the caller session scopes", async () => {
    await withPairingSession(
      {
        name: "approve-attacker",
        auth: "device",
        self: true,
        role: "operator",
        scopes: ["operator.admin"],
      },
      async ({ ws, requestId, deviceId }) => {
        const approve = await rpcReq(ws, "device.pair.approve", { requestId });
        expect(approve.ok).toBe(false);
        expect(approve.error?.message).toBe("missing scope: operator.admin");
        expect((await getPairedDevice(deviceId))?.approvedScopes).toEqual(["operator.admin"]);
      },
    );
  });
  test("allows operator-role approval from a non-admin shared-auth session", async () => {
    await withPairingSession(
      {
        name: "approve-shared-operator-approver",
        auth: "shared",
        role: "operator",
        scopes: ["operator.pairing"],
      },
      async ({ ws, requestId, deviceId }) => {
        expect((await rpcReq(ws, "device.pair.approve", { requestId })).ok).toBe(true);
        const paired = await getPairedDevice(deviceId);
        expect(paired?.role).toBe("operator");
        expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
      },
    );
  });
  test("rejects mixed operator/node approval from a non-admin shared-auth session", async () => {
    await withPairingSession(
      {
        name: "approve-shared-mixed-attacker",
        auth: "shared",
        role: "operator",
        roles: ["operator", "node"],
        scopes: ["operator.pairing"],
      },
      expectApprovalDenied,
    );
  });
  test("rejects node-role approval from a non-admin trusted-proxy Control UI session", async () => {
    await withPairingSession(
      { name: "approve-proxy-node-attacker", auth: "proxy", role: "node", scopes: [] },
      expectApprovalDenied,
    );
  });
  test("allows node-role approval from an admin trusted-proxy Control UI session", async () => {
    await withPairingSession(
      { name: "approve-proxy-node-admin", auth: "proxy", admin: true, role: "node", scopes: [] },
      async ({ ws, requestId, deviceId }) => {
        expect((await rpcReq(ws, "device.pair.approve", { requestId })).ok).toBe(true);
        const paired = await getPairedDevice(deviceId);
        expect(paired?.role).toBe("node");
        expect(paired?.tokens?.node?.role).toBe("node");
      },
    );
  });
  test("rejects approving another device from a non-admin paired-device session", async () => {
    await withPairingSession(
      {
        name: "approve-cross-device-attacker",
        auth: "device",
        role: "operator",
        scopes: ["operator.pairing"],
      },
      expectApprovalDenied,
    );
  });
  test("rejects rejecting another device from a non-admin paired-device session", async () => {
    await withPairingSession(
      {
        name: "reject-cross-device-attacker",
        auth: "device",
        role: "operator",
        scopes: ["operator.pairing"],
      },
      async ({ ws, requestId }) => {
        const reject = await rpcReq(ws, "device.pair.reject", { requestId });
        expect(reject.ok).toBe(false);
        expect(reject.error?.message).toBe("device pairing rejection denied");
        expect((await getPendingDevicePairing(requestId))?.requestId).toBe(requestId);
      },
    );
  });
});
