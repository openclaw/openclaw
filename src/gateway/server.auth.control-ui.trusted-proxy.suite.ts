import { expect, test } from "vitest";
import {
  seedApprovedOperatorReadPairing,
  withControlUiGatewayServer,
} from "./server.auth.control-ui.fixtures.test-support.js";
import {
  connectReq,
  configureTrustedProxyControlUiAuth,
  CONTROL_UI_CLIENT,
  ConnectErrorDetailCodes,
  createSignedDevice,
  openWs,
  readConnectChallengeNonce,
  rpcReq,
  testState,
  TRUSTED_PROXY_CONTROL_UI_HEADERS,
} from "./server.auth.test-helpers.js";

export function registerControlUiTrustedProxySuite(): void {
  test("requires device identity when loopback trusted-proxy authentication is rejected", async () => {
    await configureTrustedProxyControlUiAuth();
    await withControlUiGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          role: "operator",
          scopes: ["operator.admin"],
          device: null,
          client: CONTROL_UI_CLIENT,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.details).toMatchObject({
          code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
        });
      } finally {
        ws.close();
      }
    });
  });

  test("rejects loopback trusted-proxy control ui node role before pairing", async () => {
    await configureTrustedProxyControlUiAuth();
    await withControlUiGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
      try {
        const { device } = await createSignedDevice({
          token: null,
          role: "node",
          scopes: [],
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          nonce: await readConnectChallengeNonce(ws),
        });
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          role: "node",
          scopes: [],
          device,
          client: CONTROL_UI_CLIENT,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message).toContain("unauthorized");
      } finally {
        ws.close();
      }
    });
  });

  const withTrustedProxyControlUiServer = async (
    run: (port: number) => Promise<void>,
  ): Promise<void> => {
    const { replaceConfigFile } = await import("../config/config.js");
    testState.gatewayAuth = undefined;
    testState.gatewayControlUi = {
      ...testState.gatewayControlUi,
      allowedOrigins: ["https://localhost"],
    };
    await replaceConfigFile({
      nextConfig: {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
              requiredHeaders: ["x-forwarded-proto"],
              allowLoopback: true,
            },
          },
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: ["https://localhost"] },
        },
      },
      afterWrite: { mode: "auto" },
    });
    await withControlUiGatewayServer(async ({ port }) => await run(port));
  };

  test("requires pairing for trusted-proxy control ui device identity", async () => {
    await withTrustedProxyControlUiServer(async (port) => {
      const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
      try {
        const challengeNonce = await readConnectChallengeNonce(ws);
        const { device } = await createSignedDevice({
          token: null,
          role: "operator",
          scopes: ["operator.admin", "operator.read"],
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          nonce: challengeNonce,
        });
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.admin", "operator.read"],
          device,
          client: { ...CONTROL_UI_CLIENT },
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("pairing required");
        expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
          ConnectErrorDetailCodes.PAIRING_REQUIRED,
        );
      } finally {
        ws.close();
      }
    });
  });

  test("clears trusted-proxy control ui scopes without device identity", async () => {
    await withTrustedProxyControlUiServer(async (port) => {
      const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.admin", "operator.read"],
          device: null,
          client: { ...CONTROL_UI_CLIENT },
        });
        expect(res.ok).toBe(true);
        expect(res.payload).toMatchObject({ auth: { method: "trusted-proxy" } });
        const payload = res.payload as
          | {
              auth?: { scopes?: string[]; deviceToken?: string };
            }
          | undefined;
        expect(payload?.auth?.scopes).toEqual([]);
        expect(payload?.auth?.deviceToken).toBeUndefined();

        const admin = await rpcReq(ws, "set-heartbeats", { enabled: false });
        expect(admin.ok).toBe(false);
        expect(admin.error?.message ?? "").toContain("missing scope");
      } finally {
        ws.close();
      }
    });
  });

  test("bounds trusted-proxy control ui scopes to proxy-declared scope header", async () => {
    await withTrustedProxyControlUiServer(async (port) => {
      const seeded = await seedApprovedOperatorReadPairing({
        identityPrefix: "openclaw-control-ui-trusted-proxy-bounded-",
        clientId: CONTROL_UI_CLIENT.id,
        clientMode: CONTROL_UI_CLIENT.mode,
        displayName: "Control UI",
        platform: "web",
        scopes: ["operator.admin", "operator.read"],
      });
      const ws = await openWs(port, {
        ...TRUSTED_PROXY_CONTROL_UI_HEADERS,
        "x-openclaw-scopes": "operator.read",
      });
      try {
        const challengeNonce = await readConnectChallengeNonce(ws);
        const { device } = await createSignedDevice({
          token: null,
          role: "operator",
          scopes: ["operator.admin", "operator.read"],
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          identityPath: seeded.identityPath,
          nonce: challengeNonce,
        });
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.admin", "operator.read"],
          device,
          client: { ...CONTROL_UI_CLIENT },
        });
        expect(res.ok).toBe(true);
        const payload = res.payload as
          | {
              auth?: { scopes?: string[]; deviceToken?: string };
            }
          | undefined;
        expect(payload?.auth?.scopes).toEqual(["operator.read"]);
        expect(payload?.auth?.deviceToken).toBeUndefined();

        const admin = await rpcReq(ws, "set-heartbeats", { enabled: false });
        expect(admin.ok).toBe(false);
        expect(admin.error?.message ?? "").toContain("missing scope");

        const health = await rpcReq(ws, "health");
        expect(health.ok).toBe(true);
      } finally {
        ws.close();
      }
    });
  });
}
