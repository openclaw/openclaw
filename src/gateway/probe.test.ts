import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  triggerOnClose: null as ((code: number, reason: string) => void) | null,
  triggerOnConnectError: null as ((err: Error) => void) | null,
}));

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    gatewayClientState.options = opts;
    gatewayClientState.triggerOnClose = opts.onClose as ((code: number, reason: string) => void) | null;
    gatewayClientState.triggerOnConnectError = opts.onConnectError as ((err: Error) => void) | null;
  }

  start(): void {
    // Don't auto-trigger onHelloOk - let tests control the flow
    // This allows testing of failure paths like parse errors
  }

  stop(): void {}

  async request(method: string): Promise<unknown> {
    if (method === "system-presence") {
      return [];
    }
    return {};
  }
}

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
  GATEWAY_PARSE_ERROR_CLOSE_CODE: 1008,
  GATEWAY_PARSE_ERROR_CLOSE_REASON: "parse error",
}));

const { probeGateway } = await import("./probe.js");

// Use constants from the mock (same values as client.ts exports)
const GATEWAY_PARSE_ERROR_CLOSE_CODE = 1008;
const GATEWAY_PARSE_ERROR_CLOSE_REASON = "parse error";

describe("probeGateway", () => {
  beforeEach(() => {
    gatewayClientState.options = null;
    gatewayClientState.triggerOnClose = null;
    gatewayClientState.triggerOnConnectError = null;
  });

  it("connects with operator.read scope", async () => {
    // Manually trigger onHelloOk to simulate successful connection
    setTimeout(() => {
      const onHelloOk = gatewayClientState.options?.onHelloOk as (() => Promise<void>) | undefined;
      if (onHelloOk) {
        onHelloOk();
      }
    }, 10);

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.scopes).toEqual(["operator.read"]);
    expect(result.ok).toBe(true);
  });

  it("fails immediately on parse error close instead of waiting for timeout", async () => {
    const startedAt = Date.now();
    
    // Start the probe
    const probePromise = probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 5000, // Long timeout to prove we don't wait
    });

    // Simulate the real production order:
    // 1. First, onConnectError with parse error
    setTimeout(() => {
      gatewayClientState.triggerOnConnectError?.(
        new Error("Failed to parse JSON message from gateway: SyntaxError; raw (truncated): not-json")
      );
    }, 10);
    
    // 2. Then, onClose with parse error close
    setTimeout(() => {
      gatewayClientState.triggerOnClose?.(
        GATEWAY_PARSE_ERROR_CLOSE_CODE,
        GATEWAY_PARSE_ERROR_CLOSE_REASON
      );
    }, 50);

    const result = await probePromise;
    const elapsed = Date.now() - startedAt;

    // Should fail explicitly with parse error message
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to parse JSON message from gateway");
    
    // Should fail quickly, not wait for the 5000ms timeout
    expect(elapsed).toBeLessThan(1000);
  });

  it("fails immediately on any close after parse error, even with code 1006", async () => {
    const startedAt = Date.now();

    // Start the probe
    const probePromise = probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 5000, // Long timeout to prove we don't wait
    });

    // Simulate the real production order:
    // 1. First, onConnectError with parse error
    setTimeout(() => {
      gatewayClientState.triggerOnConnectError?.(
        new Error("Failed to parse JSON message from gateway: SyntaxError; raw (truncated): not-json")
      );
    }, 10);

    // 2. Then, onClose with abnormal close (1006) and empty reason
    // This tests that sawParseError triggers fast-fail regardless of close code
    setTimeout(() => {
      gatewayClientState.triggerOnClose?.(1006, "");
    }, 50);

    const result = await probePromise;
    const elapsed = Date.now() - startedAt;

    // Should fail explicitly with parse error message
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to parse JSON message from gateway");

    // Should fail quickly, not wait for the 5000ms timeout
    expect(elapsed).toBeLessThan(1000);
  });
});
