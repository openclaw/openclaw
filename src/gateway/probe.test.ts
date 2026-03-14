import { describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  requests: [] as string[],
  simulateHang: false,
  asyncStopError: false,
}));

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = {
      ...opts,
      simulateHang: gatewayClientState.simulateHang,
      asyncStopError: gatewayClientState.asyncStopError,
    };
    gatewayClientState.options = this.opts;
    gatewayClientState.requests = [];
  }

  start(): void {
    void Promise.resolve()
      .then(async () => {
        if ((this.opts as { simulateHang?: boolean }).simulateHang) {
          return;
        }
        const onHelloOk = this.opts.onHelloOk;
        if (typeof onHelloOk === "function") {
          await onHelloOk();
        }
      })
      .catch(() => {});
  }

  stop(): void {
    const onConnectError = this.opts.onConnectError;
    if (typeof onConnectError !== "function") {
      return;
    }
    if ((this.opts as { asyncStopError?: boolean }).asyncStopError) {
      queueMicrotask(() => onConnectError(new Error("gateway client stopped")));
      return;
    }
    onConnectError(new Error("gateway client stopped"));
  }

  async request(method: string): Promise<unknown> {
    gatewayClientState.requests.push(method);
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
  it("connects with operator.read scope", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.scopes).toEqual(["operator.read"]);
    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expect(gatewayClientState.requests).toEqual([
      "health",
      "status",
      "system-presence",
      "config.get",
    ]);
    expect(result.ok).toBe(true);
  });

  it("keeps device identity enabled for remote probes", async () => {
    await probeGateway({
      url: "wss://gateway.example/ws",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.deviceIdentity).toBeUndefined();
  });

  it("skips detail RPCs for lightweight reachability probes", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("prefers a late connect error over generic timeout when stop triggers client failure", async () => {
    gatewayClientState.simulateHang = true;
    try {
      const result = await probeGateway({
        url: "ws://127.0.0.1:18789",
        timeoutMs: 10,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("gateway client stopped");
    } finally {
      gatewayClientState.simulateHang = false;
    }
  });

  it("captures async stop-triggered connect errors instead of reporting generic timeout", async () => {
    gatewayClientState.simulateHang = true;
    gatewayClientState.asyncStopError = true;
    try {
      const result = await probeGateway({
        url: "ws://127.0.0.1:18789",
        timeoutMs: 10,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("gateway client stopped");
    } finally {
      gatewayClientState.simulateHang = false;
      gatewayClientState.asyncStopError = false;
    }
  });
});
