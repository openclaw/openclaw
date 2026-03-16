import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scanStatus: vi.fn(),
  runSecurityAudit: vi.fn(),
  getDaemonStatusSummary: vi.fn(),
  getNodeDaemonStatusSummary: vi.fn(),
  callGateway: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("./status.scan.js", () => ({
  scanStatus: mocks.scanStatus,
}));

vi.mock("../security/audit.runtime.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: mocks.getDaemonStatusSummary,
  getNodeDaemonStatusSummary: mocks.getNodeDaemonStatusSummary,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

describe("statusJsonCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scanStatus.mockResolvedValue({
      cfg: {},
      sourceConfig: {},
      secretDiagnostics: [],
      osSummary: { label: "test-os" },
      tailscaleMode: "off",
      tailscaleDns: null,
      tailscaleHttpsUrl: null,
      update: { installKind: "git", git: null, registry: null },
      gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "default" },
      remoteUrlMissing: false,
      gatewayMode: "local",
      gatewayProbeAuth: {},
      gatewayProbeAuthWarning: undefined,
      gatewayProbe: null,
      gatewayReachable: false,
      gatewaySelf: null,
      channelIssues: [],
      agentStatus: { defaultId: "main", agents: [] },
      channels: { rows: [], details: [] },
      summary: { sessions: { count: 0, paths: [], defaults: {}, recent: [] } },
      memory: null,
      memoryPlugin: { enabled: true, slot: "memory-core" },
    });
    mocks.runSecurityAudit.mockResolvedValue({ summary: { critical: 0, warn: 0, info: 0 } });
    mocks.getDaemonStatusSummary.mockResolvedValue({ label: "daemon" });
    mocks.getNodeDaemonStatusSummary.mockResolvedValue({ label: "node" });
    mocks.callGateway.mockResolvedValue(undefined);
  });

  it("skips filesystem audit work for default JSON status", async () => {
    const { statusJsonCommand } = await import("./status-json.js");

    await statusJsonCommand({}, mocks.runtime as never);

    expect(mocks.runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        includeFilesystem: false,
        includeChannelSecurity: true,
      }),
    );
  });

  it("keeps filesystem audit enabled for deep JSON status", async () => {
    const { statusJsonCommand } = await import("./status-json.js");

    await statusJsonCommand({ deep: true }, mocks.runtime as never);

    expect(mocks.runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        includeFilesystem: true,
        includeChannelSecurity: true,
      }),
    );
  });
});
