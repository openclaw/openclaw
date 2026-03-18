import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scanStatusJsonFast: vi.fn(),
  getDaemonStatusSummary: vi.fn(),
  getNodeDaemonStatusSummary: vi.fn(),
  runSecurityAudit: vi.fn(),
  normalizeUpdateChannel: vi.fn((value) => value),
  resolveUpdateChannelDisplay: vi.fn(() => ({
    channel: "stable",
    source: "default",
  })),
}));

vi.mock("./status.scan.fast-json.js", () => ({
  scanStatusJsonFast: mocks.scanStatusJsonFast,
}));

vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: mocks.getDaemonStatusSummary,
  getNodeDaemonStatusSummary: mocks.getNodeDaemonStatusSummary,
}));

vi.mock("../security/audit.runtime.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

vi.mock("../infra/update-channels.js", () => ({
  normalizeUpdateChannel: mocks.normalizeUpdateChannel,
  resolveUpdateChannelDisplay: mocks.resolveUpdateChannelDisplay,
}));

import { statusJsonCommand } from "./status-json.js";

function buildScanResult() {
  return {
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
    gatewayMode: "local" as const,
    gatewayProbeAuth: {},
    gatewayProbeAuthWarning: undefined,
    gatewayProbe: null,
    gatewayReachable: false,
    gatewaySelf: null,
    channelIssues: [],
    agentStatus: { defaultId: "main", agents: [] },
    channels: { rows: [], details: [] },
    summary: {
      linkChannel: undefined,
      sessions: { count: 0, paths: [], defaults: {}, recent: [] },
    },
    memory: null,
    memoryPlugin: { enabled: true, slot: "memory-core" },
  };
}

describe("statusJsonCommand", () => {
  const runtime = {
    log: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scanStatusJsonFast.mockResolvedValue(buildScanResult());
    mocks.getDaemonStatusSummary.mockResolvedValue({ label: "LaunchAgent" });
    mocks.getNodeDaemonStatusSummary.mockResolvedValue({ label: "LaunchAgent" });
    mocks.runSecurityAudit.mockResolvedValue({
      ts: 0,
      summary: { critical: 1, warn: 1, info: 0 },
      findings: [],
    });
  });

  it("skips security audit for default JSON output", async () => {
    await statusJsonCommand({}, runtime as never);

    const payload = JSON.parse(
      String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]),
    );
    expect(payload.securityAudit).toBeUndefined();
    expect(mocks.runSecurityAudit).not.toHaveBeenCalled();
  });

  it("includes security audit for full JSON output", async () => {
    await statusJsonCommand({ all: true }, runtime as never);

    const payload = JSON.parse(
      String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]),
    );
    expect(payload.securityAudit.summary.critical).toBe(1);
    expect(mocks.runSecurityAudit).toHaveBeenCalledTimes(1);
  });
});
