import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scanStatus: vi.fn(),
  getDaemonStatusSummary: vi.fn(),
  getNodeDaemonStatusSummary: vi.fn(),
  callGateway: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
  runSecurityAudit: vi.fn(),
}));

vi.mock("./status.scan.js", () => ({
  scanStatus: mocks.scanStatus,
}));

vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: mocks.getDaemonStatusSummary,
  getNodeDaemonStatusSummary: mocks.getNodeDaemonStatusSummary,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

vi.mock("../security/audit.runtime.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

import { statusJsonCommand } from "./status-json.js";

describe("statusJsonCommand", () => {
  it("keeps securityAudit null for the lean status --json path", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    mocks.scanStatus.mockResolvedValue({
      summary: { sessions: { count: 0, paths: [], defaults: {}, recent: [] } },
      osSummary: { label: "test-os" },
      update: { installKind: "git", git: null, registry: null },
      cfg: { update: {} },
      sourceConfig: {},
      memory: null,
      memoryPlugin: { enabled: true, slot: "memory-core" },
      gatewayMode: "local",
      gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "default" },
      remoteUrlMissing: false,
      gatewayReachable: false,
      gatewayProbe: null,
      gatewaySelf: null,
      gatewayProbeAuthWarning: null,
      agentStatus: { defaultId: "main", agents: [] },
      secretDiagnostics: [],
    });
    mocks.getDaemonStatusSummary.mockResolvedValue({ label: "LaunchAgent" });
    mocks.getNodeDaemonStatusSummary.mockResolvedValue({ label: "LaunchAgent" });

    await statusJsonCommand({}, runtime as never);

    expect(mocks.runSecurityAudit).not.toHaveBeenCalled();
    const payload = JSON.parse(
      String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]),
    );
    expect(payload.securityAudit).toBeNull();
  });
});
