// Preauth bootstrap token rate-limit tests protect forged bootstrap attempts
// before normal gateway auth has completed.
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  connectReq,
  installGatewayTestHooks,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function openWs(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => {
    ws.once("open", resolve);
  });
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
  test("locks out concurrent forged bootstrap-token attempts after maxAttempts", async () => {
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
      const responses = await Promise.all(
        Array.from(
          { length: 8 },
          async () =>
            await attemptForgedBootstrap(
              port,
              path.join(
                tempDirs.make("openclaw-preauth-bootstrap-"),
                "client",
                "credentials.sqlite",
              ),
            ),
        ),
      );
      const reasons = responses.map((res) => {
        expect(res.ok).toBe(false);
        const detail = res.error?.details as { authReason?: string } | undefined;
        return detail?.authReason;
      });
      expect(reasons.filter((reason) => reason === "bootstrap_token_invalid")).toHaveLength(3);
      expect(reasons.filter((reason) => reason === "rate_limited")).toHaveLength(5);
    });
  });
});
