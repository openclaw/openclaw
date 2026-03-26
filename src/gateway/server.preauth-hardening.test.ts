import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { testState } from "./test-helpers.mocks.js";
import { createGatewaySuiteHarness, readConnectChallengeNonce } from "./test-helpers.server.js";

let cleanupEnv: Array<() => void> = [];

afterEach(async () => {
  while (cleanupEnv.length > 0) {
    cleanupEnv.pop()?.();
  }
});

describe("gateway pre-auth hardening", () => {
  it("closes idle unauthenticated sockets after the handshake timeout", async () => {
    const previous = process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
    process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS = "200";
    cleanupEnv.push(() => {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS = previous;
      }
    });

    const harness = await createGatewaySuiteHarness({
      serverOptions: { auth: { mode: "none" } },
    });
    try {
      const ws = await harness.openWs();
      await readConnectChallengeNonce(ws);
      const close = await new Promise<{ code: number; elapsedMs: number }>((resolve) => {
        const startedAt = Date.now();
        ws.once("close", (code) => {
          resolve({ code, elapsedMs: Date.now() - startedAt });
        });
      });
      expect(close.code).toBe(1000);
      expect(close.elapsedMs).toBeGreaterThan(0);
      expect(close.elapsedMs).toBeLessThan(1_000);
    } finally {
      await harness.close();
    }
  });

  it("rejects oversized pre-auth connect frames before application-level auth responses", async () => {
    const harness = await createGatewaySuiteHarness();
    try {
      const ws = await harness.openWs();
      await readConnectChallengeNonce(ws);

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once("close", (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      });

      const large = "A".repeat(MAX_PREAUTH_PAYLOAD_BYTES + 1024);
      ws.send(
        JSON.stringify({
          type: "req",
          id: "oversized-connect",
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: "test", version: "1.0.0", platform: "test", mode: "test" },
            pathEnv: large,
            role: "operator",
          },
        }),
      );

      const result = await closed;
      expect(result.code).toBe(1009);
    } finally {
      await harness.close();
    }
  });

  it("rejects excess simultaneous unauthenticated sockets from the same client ip", async () => {
    const previous = process.env.OPENCLAW_TEST_MAX_PREAUTH_CONNECTIONS_PER_IP;
    process.env.OPENCLAW_TEST_MAX_PREAUTH_CONNECTIONS_PER_IP = "1";
    cleanupEnv.push(() => {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TEST_MAX_PREAUTH_CONNECTIONS_PER_IP;
      } else {
        process.env.OPENCLAW_TEST_MAX_PREAUTH_CONNECTIONS_PER_IP = previous;
      }
    });
    const previousAuth = testState.gatewayAuth;
    testState.gatewayAuth = { mode: "none" };
    cleanupEnv.push(() => {
      testState.gatewayAuth = previousAuth;
    });

    const harness = await createGatewaySuiteHarness();
    try {
      const firstWs = await harness.openWs();
      await readConnectChallengeNonce(firstWs);

      const rejectedStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: harness.port,
          path: "/",
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": "dGVzdC1rZXktMDEyMzQ1Ng==",
            "Sec-WebSocket-Version": "13",
          },
        });
        req.once("upgrade", (_res, socket) => {
          socket.destroy();
          reject(new Error("expected websocket upgrade to be rejected"));
        });
        req.once("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.once("error", reject);
        req.end();
      });
      expect(rejectedStatus).toBe(503);

      firstWs.close();
    } finally {
      await harness.close();
    }
  });
});
