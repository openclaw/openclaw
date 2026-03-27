import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  requests: [] as string[],
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

const { clampProbeTimeoutMs, probeGateway } = await import("./probe.js");

describe("probeGateway", () => {
  beforeEach(() => {
    deviceIdentityState.throwOnLoad = false;
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
});
