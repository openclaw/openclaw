import { describe, expect, it, vi } from "vitest";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";

const gatewayClientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  requests: [] as string[],
}));

const mockIdentity = vi.hoisted(() => ({
  deviceId: "mock-device-id",
  publicKeyPem: "mock-public-key",
  privateKeyPem: "mock-private-key",
}));

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: vi.fn(() => mockIdentity),
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

const { probeGateway } = await import("./probe.js");

describe("probeGateway", () => {
  it("connects with operator.read scope", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.scopes).toEqual(["operator.read"]);
    expect(gatewayClientState.options?.deviceIdentity).toEqual(mockIdentity);
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

    expect(gatewayClientState.options?.deviceIdentity).toEqual(mockIdentity);
  });

  it("skips device identity when loadOrCreateDeviceIdentity throws (read-only environment)", async () => {
    vi.mocked(loadOrCreateDeviceIdentity).mockImplementationOnce(() => {
      throw new Error("EROFS: read-only file system");
    });
    await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });
    // null signals GatewayClient to skip device auth rather than throwing
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
});
