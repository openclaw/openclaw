import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";

const mocks = vi.hoisted(() => ({
  buildStatusJsonPayload: vi.fn((input) => ({ built: true, input })),
  resolveStatusSecurityAudit: vi.fn(),
  resolveStatusRuntimeDetails: vi.fn(),
}));

vi.mock("./status-json-payload.ts", () => ({
  buildStatusJsonPayload: mocks.buildStatusJsonPayload,
}));

vi.mock("./status-runtime-shared.ts", () => ({
  resolveStatusSecurityAudit: mocks.resolveStatusSecurityAudit,
  resolveStatusRuntimeDetails: mocks.resolveStatusRuntimeDetails,
}));

function createScan() {
  return {
    cfg: { update: { channel: "stable" }, gateway: {} },
    sourceConfig: { gateway: {} },
    summary: { ok: true },
    update: { installKind: "npm", git: null },
    osSummary: { platform: "linux" },
    memory: null,
    memoryPlugin: { enabled: true },
    gatewayMode: "local" as const,
    gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "config" },
    remoteUrlMissing: false,
    gatewayReachable: true,
    gatewayProbe: { connectLatencyMs: 42, error: null },
    gatewaySelf: { host: "gateway" },
    gatewayProbeAuthWarning: null,
    agentStatus: [{ id: "main" }],
    secretDiagnostics: [],
    pluginCompatibility: [{ pluginId: "legacy", message: "warn" }],
  };
}

describe("status-json-runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveStatusSecurityAudit.mockResolvedValue({ summary: { critical: 1 } });
    mocks.resolveStatusRuntimeDetails.mockResolvedValue({
      usage: { providers: [] },
      health: { ok: true },
      lastHeartbeat: { status: "ok" },
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });
  });

  it("builds the full json output for status --json", async () => {
    const result = await resolveStatusJsonOutput({
      scan: createScan(),
      opts: { deep: true, usage: true, timeoutMs: 1234 },
      includeSecurityAudit: true,
      includePluginCompatibility: true,
    });

    expect(mocks.resolveStatusSecurityAudit).toHaveBeenCalled();
    expect(mocks.resolveStatusRuntimeDetails).toHaveBeenCalledWith({
      config: { update: { channel: "stable" }, gateway: {} },
      timeoutMs: 1234,
      usage: true,
      deep: true,
      gatewayReachable: true,
      suppressHealthErrors: undefined,
    });
    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        securityAudit: { summary: { critical: 1 } },
        usage: { providers: [] },
        health: { ok: true },
        lastHeartbeat: { status: "ok" },
        pluginCompatibility: [{ pluginId: "legacy", message: "warn" }],
      }),
    );
    expect(result).toEqual({ built: true, input: expect.any(Object) });
  });

  it("skips optional sections when flags are off", async () => {
    mocks.resolveStatusRuntimeDetails.mockResolvedValueOnce({
      usage: undefined,
      health: undefined,
      lastHeartbeat: null,
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });

    await resolveStatusJsonOutput({
      scan: createScan(),
      opts: { deep: false, usage: false, timeoutMs: 500 },
      includeSecurityAudit: false,
      includePluginCompatibility: false,
    });

    expect(mocks.resolveStatusSecurityAudit).not.toHaveBeenCalled();
    expect(mocks.resolveStatusRuntimeDetails).toHaveBeenCalledWith({
      config: { update: { channel: "stable" }, gateway: {} },
      timeoutMs: 500,
      usage: false,
      deep: false,
      gatewayReachable: true,
      suppressHealthErrors: undefined,
    });
    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        securityAudit: undefined,
        usage: undefined,
        health: undefined,
        lastHeartbeat: null,
        pluginCompatibility: undefined,
      }),
    );
  });

  it("suppresses health errors when requested", async () => {
    mocks.resolveStatusRuntimeDetails.mockResolvedValueOnce({
      usage: undefined,
      health: undefined,
      lastHeartbeat: { status: "ok" },
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });

    await resolveStatusJsonOutput({
      scan: createScan(),
      opts: { deep: true, timeoutMs: 500 },
      includeSecurityAudit: false,
      suppressHealthErrors: true,
    });

    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        health: undefined,
      }),
    );
    expect(mocks.resolveStatusRuntimeDetails).toHaveBeenCalledWith({
      config: { update: { channel: "stable" }, gateway: {} },
      timeoutMs: 500,
      usage: undefined,
      deep: true,
      gatewayReachable: true,
      suppressHealthErrors: true,
    });
  });
});
