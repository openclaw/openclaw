import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildStatusJsonPayload, resolveStatusUpdateChannelInfo } from "./status-json-payload.ts";

const mocks = vi.hoisted(() => ({
  normalizeUpdateChannel: vi.fn((value?: string | null) => value ?? null),
  resolveUpdateChannelDisplay: vi.fn(() => ({
    channel: "stable",
    source: "config",
    label: "stable",
  })),
}));

vi.mock("../infra/update-channels.js", () => ({
  normalizeUpdateChannel: mocks.normalizeUpdateChannel,
  resolveUpdateChannelDisplay: mocks.resolveUpdateChannelDisplay,
}));

describe("status-json-payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves update channel info through the shared channel display path", () => {
    expect(
      resolveStatusUpdateChannelInfo({
        updateConfigChannel: "beta",
        update: {
          installKind: "npm",
          git: { tag: "v1.2.3", branch: "main" },
        },
      }),
    ).toEqual({
      channel: "stable",
      source: "config",
      label: "stable",
    });
    expect(mocks.normalizeUpdateChannel).toHaveBeenCalledWith("beta");
    expect(mocks.resolveUpdateChannelDisplay).toHaveBeenCalledWith({
      configChannel: "beta",
      installKind: "npm",
      gitTag: "v1.2.3",
      gitBranch: "main",
    });
  });

  it("builds the shared status json payload with optional sections", () => {
    expect(
      buildStatusJsonPayload({
        summary: { ok: true },
        updateConfigChannel: "stable",
        update: { installKind: "npm", git: null, version: "1.2.3" },
        osSummary: { platform: "linux" },
        memory: null,
        memoryPlugin: { enabled: true },
        gatewayMode: "remote",
        gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
        remoteUrlMissing: false,
        gatewayReachable: true,
        gatewayProbe: { connectLatencyMs: 42, error: null },
        gatewaySelf: { host: "gateway" },
        gatewayProbeAuthWarning: "warn",
        gatewayService: { label: "LaunchAgent" },
        nodeService: { label: "node" },
        agents: [{ id: "main" }],
        secretDiagnostics: ["diag"],
        securityAudit: { summary: { critical: 1 } },
        health: { ok: true },
        usage: { providers: [] },
        lastHeartbeat: { status: "ok" },
        pluginCompatibility: [{ pluginId: "legacy", message: "warn" }],
      }),
    ).toEqual({
      ok: true,
      os: { platform: "linux" },
      update: { installKind: "npm", git: null, version: "1.2.3" },
      updateChannel: "stable",
      updateChannelSource: "config",
      memory: null,
      memoryPlugin: { enabled: true },
      gateway: {
        mode: "remote",
        url: "wss://gateway.example.com",
        urlSource: "config",
        misconfigured: false,
        reachable: true,
        connectLatencyMs: 42,
        self: { host: "gateway" },
        error: null,
        authWarning: "warn",
      },
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
      agents: [{ id: "main" }],
      secretDiagnostics: ["diag"],
      securityAudit: { summary: { critical: 1 } },
      health: { ok: true },
      usage: { providers: [] },
      lastHeartbeat: { status: "ok" },
      pluginCompatibility: {
        count: 1,
        warnings: [{ pluginId: "legacy", message: "warn" }],
      },
    });
  });

  it("omits optional sections when they are absent", () => {
    expect(
      buildStatusJsonPayload({
        summary: { ok: true },
        updateConfigChannel: null,
        update: { installKind: "npm", git: null },
        osSummary: { platform: "linux" },
        memory: null,
        memoryPlugin: null,
        gatewayMode: "local",
        gatewayConnection: { url: "ws://127.0.0.1:18789" },
        remoteUrlMissing: false,
        gatewayReachable: false,
        gatewayProbe: null,
        gatewaySelf: null,
        gatewayProbeAuthWarning: null,
        gatewayService: null,
        nodeService: null,
        agents: [],
        secretDiagnostics: [],
      }),
    ).not.toHaveProperty("securityAudit");
  });
});
