import { beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { useAuthIdentityFixture } from "./server.auth.identity-fixture.test-support.js";
import {
  BACKEND_GATEWAY_CLIENT,
  connectReq,
  ConnectErrorDetailCodes,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  openWs,
  originForPort,
  rpcReq,
  restoreGatewayToken,
  startTestGatewayServer,
  testState,
  testTailscaleWhois,
  installGatewayTestHooks,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const makeIdentityPath = useAuthIdentityFixture();

const CLI_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.CLI,
  version: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.CLI,
};

async function expectProxyUpgradeRejected(port: number, headers: Record<string, string>) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out waiting for proxy upgrade rejection"));
    }, 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error("expected proxy-shaped upgrade to be rejected"));
    });
    ws.once("unexpected-response", (_request, response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        clearTimeout(timer);
        expect(response.statusCode).toBe(403);
        expect(body).toContain("proxy_attribution_required");
        expect(body).toContain("gateway.trustedProxies");
        resolve();
      });
    });
    ws.once("error", () => {});
  });
}

async function withSocket(
  port: number,
  origin: string | undefined,
  run: (ws: WebSocket) => Promise<void>,
) {
  const ws = await openWs(port, origin ? { origin } : undefined);
  try {
    await run(ws);
  } finally {
    ws.close();
  }
}

async function expectLocalSharedAuthScopesPreserved(
  port: number,
  auth: { token?: string; password?: string; skipDefaultAuth?: boolean },
  client: typeof BACKEND_GATEWAY_CLIENT | typeof CLI_CLIENT,
) {
  await withSocket(port, undefined, async (ws) => {
    const res = await connectReq(ws, {
      ...auth,
      client,
      scopes: ["operator.admin"],
      device: null,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.payload).toHaveProperty("auth.scopes", ["operator.admin"]);
    expect((await rpcReq(ws, "exec.approvals.get", {})).ok).toBe(true);
  });
}

function useGateway(auth: GatewayAuthConfig, controlUiEnabled?: boolean) {
  const gateway = { port: 0 };
  beforeAll(async () => {
    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    testState.gatewayAuth = auth;
    restoreGatewayToken(auth.mode === "token" ? "secret" : undefined);
    const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    gateway.port = claim.port;
    const server = await startTestGatewayServer(claim, { controlUiEnabled });
    return async () => {
      await server.close();
      restoreGatewayToken(previousToken);
    };
  });
  return gateway;
}

describe("gateway auth compatibility baseline", () => {
  describe("token mode", () => {
    const gateway = useGateway({ mode: "token", token: "secret" });

    test.each([BACKEND_GATEWAY_CLIENT, CLI_CLIENT])(
      "preserves scopes for direct-local $id shared-token connects without device identity",
      async (client) => {
        await expectLocalSharedAuthScopesPreserved(gateway.port, { token: "secret" }, client);
      },
    );

    test("keeps local backend device-token reconnects out of pairing", async () => {
      const identityPath = makeIdentityPath("backend-device");
      const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
        await import("../infra/device-identity.js");
      const { approveDevicePairing } = await import("../infra/device-pairing-approval.js");
      const { rotateDeviceToken } = await import("../infra/device-pairing-tokens.js");
      const { requestDevicePairing } = await import("../infra/device-pairing.js");

      const identity = loadOrCreateDeviceIdentity({ path: identityPath });
      const pending = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        clientId: BACKEND_GATEWAY_CLIENT.id,
        clientMode: BACKEND_GATEWAY_CLIENT.mode,
        role: "operator",
        scopes: ["operator.admin"],
      });
      await approveDevicePairing(pending.request.requestId, {
        callerScopes: ["operator.admin"],
      });

      const rotated = await rotateDeviceToken({
        deviceId: identity.deviceId,
        role: "operator",
        scopes: ["operator.admin"],
      });
      expect(rotated.ok).toBe(true);
      const rotatedToken = rotated.ok ? rotated.entry.token : "";
      expect(rotatedToken).toBeTypeOf("string");
      expect(rotatedToken.length).toBeGreaterThan(0);

      await withSocket(gateway.port, undefined, async (ws) => {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...BACKEND_GATEWAY_CLIENT },
          deviceIdentityPath: identityPath,
          deviceToken: rotatedToken,
          scopes: ["operator.admin"],
        });
        expect(res).toMatchObject({
          ok: true,
          payload: {
            type: "hello-ok",
            snapshot: {
              configPath: expect.stringMatching(/./),
              stateDir: expect.stringMatching(/./),
              authMode: "token",
            },
          },
        });
      });
    });
  });

  describe("unattributable proxy ingress", () => {
    const gateway = useGateway({
      mode: "token",
      token: "secret",
      rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 },
    });

    test("rejects before credentials can bypass attribution", async () => {
      testTailscaleWhois.value = { login: "spoofed@example.com", name: "Spoofed" };
      await expectProxyUpgradeRejected(gateway.port, {
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "gateway.example.com",
        "tailscale-user-login": "spoofed@example.com",
      });
    });
  });

  describe("none mode", () => {
    const gateway = useGateway({ mode: "none" }, true);

    test("allows auth-none local backend connects without device identity", async () => {
      await expectLocalSharedAuthScopesPreserved(
        gateway.port,
        { skipDefaultAuth: true },
        BACKEND_GATEWAY_CLIENT,
      );
    });

    test("rejects auth-none browser-origin backend connects without device identity", async () => {
      await withSocket(gateway.port, originForPort(gateway.port), async (ws) => {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...BACKEND_GATEWAY_CLIENT },
          scopes: ["operator.admin"],
          device: null,
        });
        expect(res).toMatchObject({
          ok: false,
          error: {
            message: expect.stringContaining("device identity required"),
            details: { code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED },
          },
        });
      });
    });
  });
});
