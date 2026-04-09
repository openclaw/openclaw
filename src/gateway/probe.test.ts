import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  requests: [] as string[],
  startMode: "hello" as "hello" | "close",
  close: { code: 1008, reason: "pairing required" },
}));

const deviceIdentityState = vi.hoisted(() => ({
  value: { id: "test-device-identity" } as Record<string, unknown>,
  throwOnLoad: false,
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
        if (gatewayClientState.startMode === "close") {
          const onClose = this.opts.onClose;
          if (typeof onClose === "function") {
            onClose(gatewayClientState.close.code, gatewayClientState.close.reason);
          }
          return;
        }
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
    if (method === "system-presence") {
      return [];
    }
    return {};
  }
}

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: () => {
    if (deviceIdentityState.throwOnLoad) {
      throw new Error("read-only identity dir");
    }
    return deviceIdentityState.value;
  },
}));

const { __resetDeviceRequiredCacheForTests, clampProbeTimeoutMs, probeGateway } = await import(
  "./probe.js"
);

describe("probeGateway", () => {
  beforeEach(() => {
    deviceIdentityState.throwOnLoad = false;
    gatewayClientState.startMode = "hello";
    gatewayClientState.close = { code: 1008, reason: "pairing required" };
    __resetDeviceRequiredCacheForTests();
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
    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
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

    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
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
    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("keeps device identity enabled for authenticated lightweight probes", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("falls back to token/password auth when device identity cannot be persisted", async () => {
    deviceIdentityState.throwOnLoad = true;

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expect(gatewayClientState.requests).toEqual([
      "health",
      "status",
      "system-presence",
      "config.get",
    ]);
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

  it("passes through tls fingerprints for secure daemon probes", async () => {
    await probeGateway({
      url: "wss://gateway.example/ws",
      auth: { token: "secret" },
      tlsFingerprint: "sha256:abc",
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(gatewayClientState.options?.tlsFingerprint).toBe("sha256:abc");
  });

  it("surfaces immediate close failures before the probe timeout", async () => {
    gatewayClientState.startMode = "close";

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 5_000,
      includeDetails: false,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "gateway closed (1008): pairing required",
      close: { code: 1008, reason: "pairing required" },
    });
    expect(gatewayClientState.requests).toEqual([]);
  });

  describe("device-required short-circuit cache (#63427)", () => {
    const makeDeviceRequiredProbe = () =>
      probeGateway({
        url: "ws://127.0.0.1:18789",
        timeoutMs: 1_000,
        includeDetails: false,
      });

    beforeEach(() => {
      gatewayClientState.startMode = "close";
      gatewayClientState.close = { code: 1008, reason: "device identity required" };
    });

    it("opens a WebSocket for the first three device-required rejections", async () => {
      for (let i = 0; i < 3; i += 1) {
        const result = await makeDeviceRequiredProbe();
        expect(result.ok).toBe(false);
        expect(result.close).toMatchObject({ code: 1008, reason: "device identity required" });
        // First 3 attempts must actually hit the mock GatewayClient
        expect(gatewayClientState.options).not.toBeNull();
      }
    });

    it("short-circuits the 4th probe without creating a GatewayClient", async () => {
      for (let i = 0; i < 3; i += 1) {
        await makeDeviceRequiredProbe();
      }
      // Mark the mock as "has not been re-created" by nulling the options seen.
      gatewayClientState.options = null;

      const fourth = await makeDeviceRequiredProbe();

      expect(fourth.ok).toBe(false);
      expect(fourth.close?.code).toBe(1008);
      expect(fourth.close?.reason).toBe("device identity required");
      expect(fourth.close?.hint).toContain("short-circuited");
      // Crucially: no new GatewayClient was constructed.
      expect(gatewayClientState.options).toBeNull();
    });

    it("does not populate the cache on non-device-required closes", async () => {
      gatewayClientState.close = { code: 1008, reason: "pairing required" };
      for (let i = 0; i < 5; i += 1) {
        await probeGateway({
          url: "ws://127.0.0.1:18789",
          timeoutMs: 1_000,
          includeDetails: false,
        });
      }
      // After 5 "pairing required" failures the cache must still be empty,
      // so a 6th probe goes through the real mock client path.
      gatewayClientState.options = null;
      await probeGateway({
        url: "ws://127.0.0.1:18789",
        timeoutMs: 1_000,
        includeDetails: false,
      });
      expect(gatewayClientState.options).not.toBeNull();
    });

    it("clears the cache entry when the same URL eventually succeeds", async () => {
      for (let i = 0; i < 3; i += 1) {
        await makeDeviceRequiredProbe();
      }
      // Switch the mock to successful hello and probe the same URL —
      // a successful probe must reset the cache.
      gatewayClientState.startMode = "hello";
      const success = await probeGateway({
        url: "ws://127.0.0.1:18789",
        timeoutMs: 1_000,
        includeDetails: false,
      });
      expect(success.ok).toBe(true);

      // Flip back to rejection and confirm the next probe is NOT short-
      // circuited — the cache must have been cleared by the success.
      gatewayClientState.startMode = "close";
      gatewayClientState.close = { code: 1008, reason: "device identity required" };
      gatewayClientState.options = null;
      const afterReset = await makeDeviceRequiredProbe();
      expect(afterReset.ok).toBe(false);
      expect(afterReset.close?.hint).toBeUndefined();
      // Real mock client path was taken — options populated again.
      expect(gatewayClientState.options).not.toBeNull();
    });

    it("keeps per-URL caches independent across different gateway URLs", async () => {
      for (let i = 0; i < 3; i += 1) {
        await probeGateway({
          url: "ws://127.0.0.1:18789",
          timeoutMs: 1_000,
          includeDetails: false,
        });
      }

      // A different URL must NOT be short-circuited just because 127.0.0.1
      // exceeded its threshold.
      gatewayClientState.options = null;
      const other = await probeGateway({
        url: "ws://127.0.0.1:28789",
        timeoutMs: 1_000,
        includeDetails: false,
      });
      expect(other.ok).toBe(false);
      // Real mock was used for the second URL.
      expect(gatewayClientState.options).not.toBeNull();
    });
  });
});
