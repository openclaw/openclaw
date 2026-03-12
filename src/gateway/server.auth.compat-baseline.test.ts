import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  ConnectErrorDetailCodes,
  getFreePort,
  openWs,
  originForPort,
  rpcReq,
  restoreGatewayToken,
  startGatewayServer,
  testState,
} from "./server.auth.shared.js";

function expectAuthErrorDetails(params: {
  details: unknown;
  expectedCode: string;
  canRetryWithDeviceToken?: boolean;
  recommendedNextStep?: string;
}) {
  const details = params.details as
    | {
        code?: string;
        canRetryWithDeviceToken?: boolean;
        recommendedNextStep?: string;
      }
    | undefined;
  expect(details?.code).toBe(params.expectedCode);
  if (params.canRetryWithDeviceToken !== undefined) {
    expect(details?.canRetryWithDeviceToken).toBe(params.canRetryWithDeviceToken);
  }
  if (params.recommendedNextStep !== undefined) {
    expect(details?.recommendedNextStep).toBe(params.recommendedNextStep);
  }
}

describe("gateway auth compatibility baseline", () => {
  describe("token mode", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port = 0;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      testState.gatewayAuth = { mode: "token", token: "secret" };
      process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    afterAll(async () => {
      await server.close();
      restoreGatewayToken(prevToken);
    });

    test("keeps valid shared-token connect behavior unchanged", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { token: "secret" });
        expect(res.ok).toBe(true);
      } finally {
        ws.close();
      }
    });

    test("clears client-declared scopes for shared-token operator connects", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, {
          token: "secret",
          scopes: ["operator.admin"],
          device: null,
        });
        expect(res.ok).toBe(true);

        const adminRes = await rpcReq(ws, "set-heartbeats", { enabled: false });
        expect(adminRes.ok).toBe(false);
        expect(adminRes.error?.message).toBe("missing scope: operator.admin");
      } finally {
        ws.close();
      }
    });

    test("returns stable token-missing details for control ui without token", async () => {
      const ws = await openWs(port, { origin: originForPort(port) });
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...CONTROL_UI_CLIENT },
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("Control UI settings");
        expectAuthErrorDetails({
          details: res.error?.details,
          expectedCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
          canRetryWithDeviceToken: false,
          recommendedNextStep: "update_auth_configuration",
        });
      } finally {
        ws.close();
      }
    });

    test("provides one-time retry hint for shared token mismatches", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { token: "wrong" });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("gateway token mismatch");
        expectAuthErrorDetails({
          details: res.error?.details,
          expectedCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
          canRetryWithDeviceToken: true,
          recommendedNextStep: "retry_with_device_token",
        });
      } finally {
        ws.close();
      }
    });

    test("keeps explicit device token mismatch semantics stable", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          deviceToken: "not-a-valid-device-token",
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("device token mismatch");
        expectAuthErrorDetails({
          details: res.error?.details,
          expectedCode: ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH,
          canRetryWithDeviceToken: false,
          recommendedNextStep: "update_auth_credentials",
        });
      } finally {
        ws.close();
      }
    });
  });

  describe("password mode", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port = 0;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      testState.gatewayAuth = { mode: "password", password: "secret" };
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    afterAll(async () => {
      await server.close();
      restoreGatewayToken(prevToken);
    });

    test("keeps valid shared-password connect behavior unchanged", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { password: "secret" });
        expect(res.ok).toBe(true);
      } finally {
        ws.close();
      }
    });

    test("returns stable password mismatch details", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { password: "wrong" });
        expect(res.ok).toBe(false);
        expectAuthErrorDetails({
          details: res.error?.details,
          expectedCode: ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
          canRetryWithDeviceToken: false,
          recommendedNextStep: "update_auth_credentials",
        });
      } finally {
        ws.close();
      }
    });

    test("clears client-declared scopes for shared-password operator connects", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, {
          password: "secret",
          scopes: ["operator.admin"],
          device: null,
        });
        expect(res.ok).toBe(true);

        const adminRes = await rpcReq(ws, "set-heartbeats", { enabled: false });
        expect(adminRes.ok).toBe(false);
        expect(adminRes.error?.message).toBe("missing scope: operator.admin");
      } finally {
        ws.close();
      }
    });
  });

  describe("none mode", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port = 0;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      testState.gatewayAuth = { mode: "none" };
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    afterAll(async () => {
      await server.close();
      restoreGatewayToken(prevToken);
    });

    test("keeps auth-none loopback behavior unchanged", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { skipDefaultAuth: true });
        expect(res.ok).toBe(true);
      } finally {
        ws.close();
      }
    });
  });
});
