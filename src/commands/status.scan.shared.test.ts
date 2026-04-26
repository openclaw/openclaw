import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveGatewayProbeSnapshot,
  resolveSharedMemoryStatusSnapshot,
} from "./status.scan.shared.js";

const mocks = vi.hoisted(() => ({
  buildGatewayConnectionDetailsWithResolvers: vi.fn(),
  resolveGatewayProbeTarget: vi.fn(),
  probeGateway: vi.fn(),
  resolveGatewayProbeAuthResolution: vi.fn(),
  pickGatewaySelfPresence: vi.fn(),
}));

vi.mock("../gateway/connection-details.js", () => ({
  buildGatewayConnectionDetailsWithResolvers: mocks.buildGatewayConnectionDetailsWithResolvers,
}));

vi.mock("../gateway/probe-target.js", () => ({
  resolveGatewayProbeTarget: mocks.resolveGatewayProbeTarget,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

vi.mock("./status.gateway-probe.js", () => ({
  resolveGatewayProbeAuthResolution: mocks.resolveGatewayProbeAuthResolution,
}));

vi.mock("./gateway-presence.js", () => ({
  pickGatewaySelfPresence: mocks.pickGatewaySelfPresence,
}));

describe("resolveGatewayProbeSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildGatewayConnectionDetailsWithResolvers.mockReturnValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    });
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "remote",
      gatewayMode: "remote",
      remoteUrlMissing: true,
    });
    mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
      auth: { token: "tok", password: "pw" },
      warning: "warn",
    });
    mocks.pickGatewaySelfPresence.mockReturnValue({ host: "box" });
  });

  it("skips auth resolution and probe for missing remote urls by default", async () => {
    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {},
    });

    expect(mocks.resolveGatewayProbeAuthResolution).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
    expect(result).toEqual({
      gatewayConnection: expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
      remoteUrlMissing: true,
      gatewayMode: "remote",
      gatewayProbeAuth: {},
      gatewayProbeAuthWarning: undefined,
      gatewayProbe: null,
      gatewayReachable: false,
      gatewaySelf: null,
      gatewayCallOverrides: {
        url: "ws://127.0.0.1:18789",
        token: undefined,
        password: undefined,
      },
    });
  });

  it("can probe the local fallback when remote url is missing", async () => {
    mocks.probeGateway.mockResolvedValue({
      ok: true,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 12,
      error: null,
      close: null,
      health: {},
      status: {},
      presence: [{ host: "box" }],
      configSnapshot: null,
    });
    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {
        detailLevel: "full",
        probeWhenRemoteUrlMissing: true,
        resolveAuthWhenRemoteUrlMissing: true,
        mergeAuthWarningIntoProbeError: false,
      },
    });

    expect(mocks.resolveGatewayProbeAuthResolution).toHaveBeenCalled();
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        auth: { token: "tok", password: "pw" },
        detailLevel: "full",
      }),
    );
    expect(result.gatewayReachable).toBe(true);
    expect(result.gatewaySelf).toEqual({ host: "box" });
    expect(result.gatewayCallOverrides).toEqual({
      url: "ws://127.0.0.1:18789",
      token: "tok",
      password: "pw",
    });
    expect(result.gatewayProbeAuthWarning).toBe("warn");
  });

  it("merges auth warnings into failed probe errors by default", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });
    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {},
    });

    expect(result.gatewayProbe?.error).toBe("timeout; warn");
    expect(result.gatewayProbeAuthWarning).toBeUndefined();
  });
});

describe("resolveSharedMemoryStatusSnapshot", () => {
  it("allows memory-slot plugins to provide status without built-in store paths", async () => {
    const manager = {
      probeVectorAvailability: vi.fn(async () => true),
      status: vi.fn(() => ({
        backend: "lancedb-pro",
        provider: "openai-compatible",
        requestedProvider: "openai-compatible",
        model: "nomic-embed-text",
        dbPath: "/tmp/lancedb-pro",
        workspaceDir: "/tmp/workspace",
        vector: { enabled: true, available: true },
      })),
      close: vi.fn(async () => undefined),
    };

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: { agents: {} },
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-lancedb-pro" },
      resolveMemoryConfig: vi.fn(() => null),
      getMemorySearchManager: vi.fn(async () => ({ manager })),
      requireDefaultStore: vi.fn(() => "/tmp/main.sqlite"),
    });

    expect(result).toEqual(
      expect.objectContaining({
        agentId: "main",
        backend: "lancedb-pro",
        vector: { enabled: true, available: true },
      }),
    );
    expect(manager.probeVectorAvailability).toHaveBeenCalled();
    expect(manager.status).toHaveBeenCalled();
    expect(manager.close).toHaveBeenCalled();
  });

  it("keeps returning null for built-in memory without explicit config or store", async () => {
    const getMemorySearchManager = vi.fn(async () => ({ manager: null }));

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: { agents: {} },
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig: vi.fn(() => null),
      getMemorySearchManager,
      requireDefaultStore: vi.fn(() => "/tmp/main.sqlite"),
    });

    expect(result).toBeNull();
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });
});
