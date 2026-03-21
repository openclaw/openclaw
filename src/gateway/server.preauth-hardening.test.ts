import { afterEach, describe, expect, it } from "vitest";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
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

    const harness = await createGatewaySuiteHarness();
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
});
