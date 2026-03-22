import { describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  requests: [] as string[],
  plans: [] as Array<Record<string, unknown>>,
}));

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;
  private readonly plan: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    this.plan = gatewayClientState.plans.shift() ?? {};
    gatewayClientState.options.push(opts);
    gatewayClientState.requests = [];
  }

  start(): void {
    const onHelloOk = this.opts.onHelloOk;
    if (typeof onHelloOk !== "function" || this.plan.skipHelloOk === true) {
      return;
    }
    const helloDelayMs =
      typeof this.plan.helloDelayMs === "number" && Number.isFinite(this.plan.helloDelayMs)
        ? Math.max(0, this.plan.helloDelayMs)
        : 0;
    const runHelloOk = () => {
      void Promise.resolve()
        .then(async () => {
          await onHelloOk();
        })
        .catch(() => {});
    };
    if (helloDelayMs > 0) {
      setTimeout(runHelloOk, helloDelayMs);
      return;
    }
    runHelloOk();
  }

  stop(): void {}

  async request(method: string): Promise<unknown> {
    gatewayClientState.requests.push(method);
    const requests =
      (this.plan.requests as
        | Record<string, { error?: string; result?: unknown; delayMs?: number }>
        | undefined) ?? {};
    const planned = requests[method];
    if (
      typeof planned?.delayMs === "number" &&
      Number.isFinite(planned.delayMs) &&
      planned.delayMs > 0
    ) {
      await new Promise((resolve) => setTimeout(resolve, planned.delayMs));
    }
    if (planned?.error) {
      throw new Error(planned.error);
    }
    if (planned && "result" in planned) {
      return planned.result;
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
  it("clamps probe timeout to timer-safe bounds", () => {
    expect(clampProbeTimeoutMs(1)).toBe(250);
    expect(clampProbeTimeoutMs(2_000)).toBe(2_000);
    expect(clampProbeTimeoutMs(3_000_000_000)).toBe(2_147_483_647);
  });

  it("retries local probes without explicit auth when shared auth loses operator.read", async () => {
    gatewayClientState.options.length = 0;
    gatewayClientState.plans.splice(0, gatewayClientState.plans.length, {
      requests: {
        status: { error: "missing scope: operator.read" },
      },
    });
    gatewayClientState.plans.push({
      requests: {
        health: { result: { ok: true } },
        status: { result: { ok: true } },
        "system-presence": { result: [] },
        "config.get": { result: { ok: true } },
      },
    });

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
      allowLocalDeviceAuthRetry: true,
    });

    expect(gatewayClientState.options).toHaveLength(2);
    expect(gatewayClientState.options[0]?.token).toBe("secret");
    expect(gatewayClientState.options[1]?.token).toBeUndefined();
    // Retry enables device identity (undefined = use default, not null = disabled)
    expect(gatewayClientState.options[1]?.deviceIdentity).toBeUndefined();
    expect(gatewayClientState.options[1]?.clearDeviceAuthTokenOnMismatch).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("keeps the original scope-limited result when the local retry still fails", async () => {
    gatewayClientState.options.length = 0;
    gatewayClientState.plans.splice(0, gatewayClientState.plans.length, {
      requests: {
        status: { error: "missing scope: operator.read" },
      },
    });
    gatewayClientState.plans.push({
      requests: {
        health: { error: "pairing required" },
      },
    });

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
      allowLocalDeviceAuthRetry: true,
    });

    expect(gatewayClientState.options).toHaveLength(2);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing scope: operator.read");
  });

  it("can suppress local device-auth fallback for tunneled loopback targets", async () => {
    gatewayClientState.options.length = 0;
    gatewayClientState.plans.splice(0, gatewayClientState.plans.length, {
      requests: {
        status: { error: "missing scope: operator.read" },
      },
    });

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
      allowLocalDeviceAuthRetry: false,
    });

    expect(gatewayClientState.options).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing scope: operator.read");
  });

  it("keeps one timeout budget across the retry path", async () => {
    vi.useFakeTimers();
    try {
      gatewayClientState.options.length = 0;
      gatewayClientState.plans.splice(0, gatewayClientState.plans.length, {
        requests: {
          status: { error: "missing scope: operator.read", delayMs: 200 },
        },
      });
      gatewayClientState.plans.push({
        helloDelayMs: 400,
      });

      let settled = false;
      const resultPromise = probeGateway({
        url: "ws://127.0.0.1:18789",
        auth: { token: "secret" },
        timeoutMs: 500,
        allowLocalDeviceAuthRetry: true,
      }).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(500);

      expect(settled).toBe(true);
      const result = await resultPromise;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("missing scope: operator.read");
    } finally {
      vi.useRealTimers();
    }
  });

  it("connects with operator.read scope", async () => {
    gatewayClientState.options.length = 0;
    gatewayClientState.plans.length = 0;
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options[0]?.scopes).toEqual(["operator.read"]);
    expect(gatewayClientState.options[0]?.deviceIdentity).toBeUndefined();
    expect(gatewayClientState.requests).toEqual([
      "health",
      "status",
      "system-presence",
      "config.get",
    ]);
    expect(result.ok).toBe(true);
  });

  it("keeps device identity enabled for remote probes", async () => {
    gatewayClientState.options.length = 0;
    gatewayClientState.plans.length = 0;
    await probeGateway({
      url: "wss://gateway.example/ws",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options[0]?.deviceIdentity).toBeUndefined();
  });

  it("keeps device identity disabled for unauthenticated loopback probes", async () => {
    gatewayClientState.options.length = 0;
    gatewayClientState.plans.length = 0;
    await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options[0]?.deviceIdentity).toBeNull();
  });

  it("skips detail RPCs for lightweight reachability probes", async () => {
    gatewayClientState.options.length = 0;
    gatewayClientState.plans.length = 0;
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("fetches only presence for presence-only probes", async () => {
    gatewayClientState.options.length = 0;
    gatewayClientState.plans.length = 0;
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
});
