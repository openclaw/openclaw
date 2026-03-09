import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  triggerOnClose: null as ((code: number, reason: string) => void) | null,
}));

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    gatewayClientState.options = opts;
    gatewayClientState.triggerOnClose = opts.onClose as ((code: number, reason: string) => void) | null;
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
}));

const { probeGateway } = await import("./probe.js");

describe("probeGateway", () => {
  beforeEach(() => {
    gatewayClientState.options = null;
    gatewayClientState.triggerOnClose = null;
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

    // Simulate a parse error close from the gateway after a short delay
    // This simulates what happens when gateway sends non-JSON content
    setTimeout(() => {
      gatewayClientState.triggerOnClose?.(1008, "parse error");
    }, 50);

    const result = await probePromise;
    const elapsed = Date.now() - startedAt;

    // Should fail explicitly
    expect(result.ok).toBe(false);
    expect(result.error).toContain("gateway protocol error");
    expect(result.error).toContain("parse error");
    
    // Should fail quickly, not wait for the 5000ms timeout
    expect(elapsed).toBeLessThan(1000);
  });
});
