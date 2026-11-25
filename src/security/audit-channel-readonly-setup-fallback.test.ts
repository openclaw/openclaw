// Covers channel readonly setup fallback audit behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { stubAuditChannelPlugin } from "./audit-channel-test-helpers.js";

type CollectParams = Parameters<
  typeof import("./audit-channel.js").collectChannelSecurityFindingsCore
>[0];

const {
  collectChannelSecurityFindingsMock,
  listReadOnlyChannelPluginsForConfigMock,
  hasConfiguredChannelsForReadOnlyScopeMock,
} = vi.hoisted(() => ({
  collectChannelSecurityFindingsMock: vi.fn(async (_params: CollectParams) => [
    {
      checkId: "channels.telegram.setup_fallback_audited",
      severity: "warn",
      title: "Telegram setup fallback audited",
    },
  ]),
  listReadOnlyChannelPluginsForConfigMock: vi.fn(),
  hasConfiguredChannelsForReadOnlyScopeMock: vi.fn(),
}));

// mock-isolation: Setup-fallback routing excludes unrelated plugin-contract and workspace flag discovery.
vi.mock("./dangerous-config-flags.js", () => ({
  collectEnabledInsecureOrDangerousFlags: (_configForTest: OpenClawConfig): string[] => [],
}));

// mock-isolation: Audit fixtures control setup fallback without loading real channel accounts.
vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfigAsync: async (...args: unknown[]) =>
    listReadOnlyChannelPluginsForConfigMock(...args),
}));

// mock-isolation: Audit fixtures control channel presence without inspecting persisted plugin state.
vi.mock("../plugins/channel-plugin-ids.js", () => ({
  hasConfiguredChannelsForReadOnlyScopeAsync: async (...args: unknown[]) =>
    hasConfiguredChannelsForReadOnlyScopeMock(...args),
  resolveConfiguredChannelPluginIdsAsync: async () => [],
}));

// mock-isolation: Capture delegated setup-fallback plugins without invoking real channel security collectors.
vi.mock("./audit-channel.collect.runtime.js", () => ({
  collectChannelSecurityFindings: collectChannelSecurityFindingsMock,
}));

const collectNoFindings = vi.hoisted(() => vi.fn(() => []));
vi.mock("./audit.nondeep.runtime.js", () => ({
  collectAttackSurfaceSummaryFindings: collectNoFindings,
  collectCrossAgentSessionAccessFindings: collectNoFindings,
  collectExposureMatrixFindings: collectNoFindings,
  collectGatewayHttpNoAuthFindings: collectNoFindings,
  collectGatewayHttpSessionKeyOverrideFindings: collectNoFindings,
  collectHooksHardeningFindings: collectNoFindings,
  collectLikelyMultiUserSetupFindings: collectNoFindings,
  collectMinimalProfileOverrideFindings: collectNoFindings,
  collectNodeDangerousAllowCommandFindings: collectNoFindings,
  collectNodeDenyCommandPatternFindings: collectNoFindings,
  collectSandboxDangerousConfigFindings: collectNoFindings,
  collectSandboxDockerNoopFindings: collectNoFindings,
  collectSecretsInConfigFindings: collectNoFindings,
  collectSmallModelRiskFindings: collectNoFindings,
  collectSyncedFolderFindings: collectNoFindings,
  readConfigSnapshotForAudit: vi.fn(async () => null),
}));

const { runSecurityAuditCore } = await import("./audit.js");

describe("security audit channel read-only setup fallback", () => {
  it("passes setup fallback plugins to channel security collection", async () => {
    const plugin = stubAuditChannelPlugin({
      id: "telegram",
      label: "Telegram",
      commands: undefined,
      collectAuditFindings: undefined,
      inspectAccount: () => ({ enabled: true, configured: true }),
      resolveAccount: () => ({}),
    });
    const cfg = {
      agents: { entries: { main: {} } },
      session: { dmScope: "main" },
      channels: { telegram: { enabled: true } },
    } satisfies OpenClawConfig;

    hasConfiguredChannelsForReadOnlyScopeMock.mockReturnValue(true);
    listReadOnlyChannelPluginsForConfigMock.mockReturnValue([plugin]);

    const report = await runSecurityAuditCore({
      config: cfg,
      sourceConfig: cfg,
      includeFilesystem: false,
      loadPluginSecurityCollectors: false,
    });

    const readOnlyPluginCall = listReadOnlyChannelPluginsForConfigMock.mock.calls[0];
    expect(readOnlyPluginCall?.[0]).toBe(cfg);
    expect(readOnlyPluginCall?.[1]).toMatchObject({
      includePersistedAuthState: true,
      includeSetupFallbackPlugins: true,
    });
    const collectParams = collectChannelSecurityFindingsMock.mock.calls[0]?.[0];
    expect(collectParams?.cfg).toBe(cfg);
    expect(collectParams?.sourceConfig).toBe(cfg);
    expect(collectParams?.plugins).toStrictEqual([plugin]);
    expect(report.findings.map((finding) => finding.checkId)).toContain(
      "channels.telegram.setup_fallback_audited",
    );
  });
});
