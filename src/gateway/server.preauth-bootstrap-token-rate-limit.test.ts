import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  connectReq,
  installGatewayTestHooks,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function openWs(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
}

async function attemptForgedBootstrap(port: number, identityPath: string) {
  const ws = await openWs(port);
  try {
    const res = await connectReq(ws, {
      skipDefaultAuth: true,
      bootstrapToken: "forged-bootstrap-token",
      deviceIdentityPath: identityPath,
    });
    return res;
  } finally {
    ws.close();
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
    });
  }
}

describe("pre-auth bootstrap-token rate limit", () => {
  test("locks out forged bootstrap-token attempts after maxAttempts", async () => {
    // exemptLoopback:false ensures the limiter applies to loopback test
    // clients. In production the same gate applies to remote clients via
    // the per-IP bucket.
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 3,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: false,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const identityPath = path.join(
        os.tmpdir(),
        `openclaw-preauth-bootstrap-${randomUUID()}.json`,
      );

      // The first maxAttempts forged tokens reach verifyDeviceBootstrapToken
      // and fail with bootstrap_token_invalid (the verify path ran).
      const reasons: Array<string | undefined> = [];
      for (let i = 0; i < 3; i++) {
        const res = await attemptForgedBootstrap(port, identityPath);
        expect(res.ok).toBe(false);
        const detail = res.error?.details as { authReason?: string } | undefined;
        reasons.push(detail?.authReason);
      }
      expect(reasons.every((r) => r === "bootstrap_token_invalid")).toBe(true);

      // The next attempt is the one that proves the gate fires: the gateway
      // rejects without invoking the mutex-locked verify path.
      const lockedOut = await attemptForgedBootstrap(port, identityPath);
      expect(lockedOut.ok).toBe(false);
      const detail = lockedOut.error?.details as
        | { authReason?: string; retryAfterMs?: number }
        | undefined;
      expect(detail?.authReason).toBe("rate_limited");
    });
  });

  test("forged bootstrap-token failures consume their own bucket independent of device-token", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: false,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const identityPath = path.join(
        os.tmpdir(),
        `openclaw-preauth-bootstrap-shared-${randomUUID()}.json`,
      );

      const first = await attemptForgedBootstrap(port, identityPath);
      expect(first.ok).toBe(false);
      const firstDetail = first.error?.details as { authReason?: string } | undefined;
      expect(firstDetail?.authReason).toBe("bootstrap_token_invalid");

      const second = await attemptForgedBootstrap(port, identityPath);
      expect(second.ok).toBe(false);
      const secondDetail = second.error?.details as { authReason?: string } | undefined;
      expect(secondDetail?.authReason).toBe("rate_limited");
    });
  });
});
