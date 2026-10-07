/**
 * Gateway auth compatibility baseline tests.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { useAuthIdentityFixture } from "./server.auth.identity-fixture.test-support.js";
import {
  BACKEND_GATEWAY_CLIENT,
  connectReq,
  CONTROL_UI_CLIENT,
  ConnectErrorDetailCodes,
  createSignedDevice,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  readConnectChallengeNonce,
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

async function expectLocalSharedAuthScopesPreserved(
  port: number,
  auth: { token?: string; password?: string; skipDefaultAuth?: boolean },
  client: typeof BACKEND_GATEWAY_CLIENT | typeof CLI_CLIENT,
) {
  const ws = await openWs(port);
  try {
    const res = await connectReq(ws, {
      ...auth,
      client: { ...client },
      scopes: ["operator.admin"],
      device: null,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const helloOk = res.payload as HelloOk;
    expect(helloOk?.auth?.scopes).toEqual(["operator.admin"]);

    const adminRes = await rpcReq(ws, "system-event", { text: "Local admin scope proof" });
    expect(adminRes.ok, JSON.stringify(adminRes)).toBe(true);
  } finally {
    ws.close();
  }
}

function useGateway(auth: GatewayAuthConfig, controlUiEnabled?: boolean) {
  const gateway = { port: 0 };
  let server: Awaited<ReturnType<typeof startTestGatewayServer>>;
  let previousToken: string | undefined;
  beforeAll(async () => {
    previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    testState.gatewayAuth = auth;
    if (auth.mode === "token") {
      process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    } else {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    }
    const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    gateway.port = claim.port;
    server = await startTestGatewayServer(claim, { controlUiEnabled });
  });
  afterAll(async () => {
    await server.close();
    restoreGatewayToken(previousToken);
  });
  return gateway;
}

describe("gateway auth compatibility baseline", () => {
  describe("token mode", () => {
    const gateway = useGateway({ mode: "token", token: "secret" });

    test("preserves scopes for direct-local backend shared-token connects without device identity", async () => {
      await expectLocalSharedAuthScopesPreserved(
        gateway.port,
        { token: "secret" },
        BACKEND_GATEWAY_CLIENT,
      );
    });

    test("preserves scopes for direct-local CLI shared-token connects without device identity", async () => {
      await expectLocalSharedAuthScopesPreserved(gateway.port, { token: "secret" }, CLI_CLIENT);
    });

    test("keeps local backend device-token reconnects out of pairing", async () => {
      const identityPath = makeIdentityPath(
        `openclaw-backend-device-${process.pid}-${gateway.port}.sqlite`,
      );
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

      const ws = await openWs(gateway.port);
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...BACKEND_GATEWAY_CLIENT },
          deviceIdentityPath: identityPath,
          deviceToken: rotatedToken,
          scopes: ["operator.admin"],
        });
        expect(res.ok).toBe(true);
        expect(res.payload).toMatchObject({
          type: "hello-ok",
          snapshot: {
            configPath: expect.stringMatching(/./),
            stateDir: expect.stringMatching(/./),
            authMode: "token",
          },
        });
      } finally {
        ws.close();
      }
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
      const headers = {
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "gateway.example.com",
        "tailscale-user-login": "spoofed@example.com",
      };
      await expectProxyUpgradeRejected(gateway.port, headers);
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
      const ws = await openWs(gateway.port, { origin: originForPort(gateway.port) });
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...BACKEND_GATEWAY_CLIENT },
          scopes: ["operator.admin"],
          device: null,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("device identity required");
        expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
          ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED,
        );
      } finally {
        ws.close();
      }
    });

    test("keeps auth-none control ui first-connect token absence unchanged", async () => {
      const ws = await openWs(gateway.port, { origin: originForPort(gateway.port) });
      try {
        const deviceIdentityPath = makeIdentityPath(
          `openclaw-auth-none-control-ui-first-${process.pid}-${gateway.port}.sqlite`,
        );
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...CONTROL_UI_CLIENT },
          scopes: ["operator.read"],
          deviceIdentityPath,
        });
        expect(res.ok).toBe(true);
        const helloOk = res.payload as HelloOk;
        expect(helloOk?.auth?.deviceToken).toBeUndefined();
      } finally {
        ws.close();
      }
    });

    test("keeps auth-none control ui stale-key token handoff unchanged", async () => {
      const ws = await openWs(gateway.port, { origin: originForPort(gateway.port) });
      try {
        const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
          await import("../infra/device-identity.js");
        const { approveDevicePairing } = await import("../infra/device-pairing-approval.js");
        const { requestDevicePairing } = await import("../infra/device-pairing.js");
        const nonce = await readConnectChallengeNonce(ws);
        const identityPath = makeIdentityPath(
          `openclaw-auth-none-control-ui-${process.pid}-${gateway.port}.sqlite`,
        );
        const staleIdentityPath = makeIdentityPath(
          `openclaw-auth-none-control-ui-stale-${process.pid}-${gateway.port}.sqlite`,
        );
        const { identity, device } = await createSignedDevice({
          token: null,
          scopes: ["operator.read"],
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          identityPath,
          nonce,
        });
        const staleIdentity = loadOrCreateDeviceIdentity({ path: staleIdentityPath });
        const pending = await requestDevicePairing({
          deviceId: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(staleIdentity.publicKeyPem),
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          role: "operator",
          scopes: ["operator.read"],
        });
        await approveDevicePairing(pending.request.requestId, {
          callerScopes: ["operator.admin"],
        });

        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...CONTROL_UI_CLIENT },
          scopes: ["operator.read"],
          device,
        });
        expect(res.ok).toBe(true);
        const helloOk = res.payload as HelloOk;
        expect(typeof helloOk?.auth?.deviceToken).toBe("string");
      } finally {
        ws.close();
      }
    });
  });
});
