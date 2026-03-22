import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  requests: [] as string[],
  delaysMs: {} as Record<string, number>,
}));

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    gatewayClientState.options = opts;
    gatewayClientState.requests = [];
  }

  start(): void {
    void Promise.resolve()
      .then(async () => {
        const onHelloOk = this.opts.onHelloOk;
        if (typeof onHelloOk === "function") {
          await onHelloOk();
        }
      })
      .catch(() => {});
  }

  stop(): void {}

  async request(method: string): Promise<unknown> {
    gatewayClientState.requests.push(method);
    const delayMs = gatewayClientState.delaysMs[method];
    if (typeof delayMs === "number" && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (method === "health") {
      return {};
    }
    if (method === "system-presence") {
      return [];
    }
    return {};
  }
}

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

const { clampProbeTimeoutMs, probeGateway } = await import("./probe.js");

describe("probeGateway", () => {
  beforeEach(() => {
    gatewayClientState.delaysMs = { health: 2_000 };
  });

  it("clamps probe timeout to timer-safe bounds", () => {
    expect(clampProbeTimeoutMs(1)).toBe(250);
    expect(clampProbeTimeoutMs(2_000)).toBe(2_000);
    expect(clampProbeTimeoutMs(3_000_000_000)).toBe(2_147_483_647);
  });

  it("connects with operator.read scope", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.scopes).toEqual(["operator.read"]);
    expect(gatewayClientState.options?.deviceIdentity).toBeUndefined();
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

  it("keeps device identity disabled for unauthenticated loopback probes", async () => {
    await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
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

  it("fetches only presence for presence-only probes", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
      detailLevel: "presence",
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.requests).toEqual(["system-presence"]);
    expect(result.health).toBeNull();
    expect(result.status).toBeNull();
    expect(result.configSnapshot).toBeNull();
  });

  it("treats reachability as successful when status/presence/config finish before a slow health call", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 100,
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.status).toEqual({});
    expect(result.presence).toEqual([]);
    expect(result.health).toBeNull();
  });

  it("requires config.get before treating a full probe as successful", async () => {
    gatewayClientState.delaysMs = {
      health: 2_000,
      "config.get": 2_000,
    };
    vi.useFakeTimers();
    try {
      const probePromise = probeGateway({
        url: "ws://127.0.0.1:18789",
        auth: { token: "secret" },
        timeoutMs: 100,
      });

      await vi.advanceTimersByTimeAsync(300);
      const result = await probePromise;

      expect(result.ok).toBe(false);
      expect(result.error).toBe("timeout");
      expect(result.configSnapshot).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
