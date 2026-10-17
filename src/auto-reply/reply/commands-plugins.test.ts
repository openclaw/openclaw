// Tests plugin command install, listing, and config behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginCapabilityConsentReview } from "../../plugins/capability-summary.js";
import { recordInstalledPluginIndexInstallOwner } from "../../plugins/installed-plugin-index-install-owner.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  createInstalledPluginIndexSnapshot,
  createPluginRecord,
} from "../../plugins/status.test-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import { buildPluginsCommandParams, type ConfigSnapshotMock } from "./commands.test-harness.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const loadPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const replaceConfigFileMock = vi.hoisted(() => vi.fn(async (_params: unknown) => undefined));
const buildPluginRegistrySnapshotReportMock = vi.hoisted(() => vi.fn());
const withPluginDiagnosticsReportForInspectionMock = vi.hoisted(() =>
  vi.fn<typeof import("../../plugins/status.js").withPluginDiagnosticsReportForInspection>(),
);
const buildPluginInspectReportMock = vi.hoisted(() => vi.fn());
const buildAllPluginInspectReportsMock = vi.hoisted(() => vi.fn());
const formatPluginCompatibilityNoticeMock = vi.hoisted(() => vi.fn(() => "ok"));
const refreshPluginRegistryAfterConfigMutationMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolvePluginCapabilityConsentMock = vi.hoisted(() =>
  vi.fn<typeof import("../../plugins/capability-consent.js").resolvePluginCapabilityConsent>(
    async () => undefined,
  ),
);
const resolvePendingPluginCapabilityReviewMock = vi.hoisted(() =>
  vi.fn<
    typeof import("../../plugins/capability-consent.js").resolvePendingPluginCapabilityReview
  >(),
);

vi.mock("../../plugins/capability-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/capability-consent.js")>()),
  resolvePluginCapabilityConsent: resolvePluginCapabilityConsentMock,
  resolvePendingPluginCapabilityReview: resolvePendingPluginCapabilityReviewMock,
}));

vi.mock("../../cli/npm-resolution.js", () => ({
  buildNpmInstallRecordFields: vi.fn(),
}));

vi.mock("../../cli/plugins-command-helpers.js", () => ({
  createPluginInstallLogger: vi.fn(() => ({})),
  resolveFileNpmSpecToLocalPath: vi.fn(() => null),
}));

vi.mock("../../plugins/install-persistence.js", () => ({
  persistPluginInstall: vi.fn(async () => undefined),
}));

vi.mock("../../plugins/registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: refreshPluginRegistryAfterConfigMutationMock,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  replaceConfigFile: replaceConfigFileMock,
  transformConfigFileWithRetry: async (params: {
    afterWrite?: unknown;
    transform: (
      currentConfig: OpenClawConfig,
      context: { snapshot: ConfigSnapshotMock; previousHash: string | null; attempt: number },
    ) =>
      | Promise<{ nextConfig: OpenClawConfig; result?: unknown }>
      | {
          nextConfig: OpenClawConfig;
          result?: unknown;
        };
  }) => {
    const snapshot = (await readConfigFileSnapshotMock()) as ConfigSnapshotMock;
    const previousHash = snapshot.hash ?? null;
    const currentConfig = structuredClone(
      snapshot.sourceConfig ?? snapshot.resolved ?? snapshot.runtimeConfig ?? snapshot.parsed ?? {},
    );
    const transformContext = { snapshot, previousHash, attempt: 0 };
    const transformed = await params.transform(currentConfig, transformContext);
    const afterWrite = params.afterWrite ?? { mode: "auto" };
    await replaceConfigFileMock({ nextConfig: transformed.nextConfig, afterWrite });
    return {
      path: snapshot.path ?? "/tmp/openclaw.json",
      previousHash,
      persistedHash: "persisted-hash",
      snapshot,
      nextConfig: transformed.nextConfig,
      result: transformed.result,
      attempts: 1,
      afterWrite,
      followUp: { action: "none" },
    };
  },
}));

vi.mock("../../infra/archive.js", () => ({
  resolveArchiveKind: vi.fn(() => null),
}));

vi.mock("../../infra/clawhub-spec.js", () => ({
  parseClawHubPluginSpec: vi.fn(() => null),
}));

vi.mock("../../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {},
  installPluginFromClawHub: vi.fn(),
}));

vi.mock("../../plugins/install.js", () => ({
  installPluginFromNpmSpec: vi.fn(),
  installPluginFromPath: vi.fn(),
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

vi.mock("../../plugins/status.js", () => ({
  buildAllPluginInspectReports: buildAllPluginInspectReportsMock,
  withPluginDiagnosticsReportForInspection: withPluginDiagnosticsReportForInspectionMock,
  buildPluginInspectReport: buildPluginInspectReportMock,
  buildPluginRegistrySnapshotReport: buildPluginRegistrySnapshotReportMock,
  formatPluginCompatibilityNotice: formatPluginCompatibilityNoticeMock,
}));

vi.mock("../../plugins/toggle-config.js", () => ({
  setPluginEnabledInConfig: vi.fn((config: OpenClawConfig, id: string, enabled: boolean) => ({
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [id]: { enabled },
      },
    },
  })),
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    resolveUserPath: vi.fn((value: string) => value),
  };
});

function buildCfg(): OpenClawConfig {
  return {
    plugins: { enabled: true },
    commands: { text: true, plugins: true },
  };
}

const pluginSummary = {
  id: "superpowers",
  name: "superpowers",
  status: "disabled",
  format: "openclaw",
  bundleFormat: "claude",
} as const;

const WRITE_GATEWAY_SCOPES = ["operator.admin", "operator.write", "operator.pairing"];

function buildPluginsParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
  options?: { gatewayClientScopes?: string[]; omitGatewayClientScopes?: boolean },
) {
  const params = buildPluginsCommandParams({
    commandBodyNormalized,
    cfg,
    gatewayClientScopes: options?.gatewayClientScopes,
  });
  if (options?.omitGatewayClientScopes) {
    delete params.ctx.GatewayClientScopes;
  }
  return params;
}

function expectLastReplaceConfig(enabled: boolean) {
  expect(replaceConfigFileMock.mock.lastCall).toStrictEqual([
    {
      afterWrite: { mode: "auto" },
      nextConfig: expect.objectContaining({
        plugins: expect.objectContaining({
          entries: expect.objectContaining({ superpowers: expect.objectContaining({ enabled }) }),
        }),
      }),
    },
  ]);
}

function expectLastRegistryRefresh() {
  expect(refreshPluginRegistryAfterConfigMutationMock.mock.lastCall).toStrictEqual([
    {
      reason: "policy-changed",
      logger: expect.objectContaining({ warn: expect.any(Function) }),
    },
  ]);
}

function runCommand(command: string, options?: Parameters<typeof buildPluginsParams>[2]) {
  return handlePluginsCommand(buildPluginsParams(command, buildCfg(), options), true);
}

describe("handlePluginsCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPluginMetadataSnapshotMock.mockReturnValue({
      index: createInstalledPluginIndexSnapshot([]),
    });
    resolvePluginCapabilityConsentMock.mockReset().mockResolvedValue(undefined);
    resolvePendingPluginCapabilityReviewMock.mockReset();
    readConfigFileSnapshotMock.mockResolvedValue({
      valid: true,
      path: "/tmp/openclaw.json",
      sourceConfig: buildCfg(),
      resolved: buildCfg(),
      hash: "config-1",
    });
    validateConfigObjectWithPluginsMock.mockReturnValue({
      ok: true,
      config: buildCfg(),
      issues: [],
    });
    buildPluginRegistrySnapshotReportMock.mockReturnValue({
      workspaceDir: "/tmp/plugins-workspace",
      plugins: [pluginSummary],
    });
    withPluginDiagnosticsReportForInspectionMock
      .mockReset()
      .mockImplementation(async (_params, formatReport) =>
        formatReport({
          ...createEmptyPluginRegistry(),
          workspaceScope: "selected",
          workspaceDir: "/tmp/plugins-workspace",
          plugins: [createPluginRecord(pluginSummary)],
        }),
      );
    buildPluginInspectReportMock.mockReturnValue({
      plugin: {
        id: "superpowers",
      },
      compatibility: [],
      bundleFormat: "claude",
      shape: { commands: ["review"] },
    });
    buildAllPluginInspectReportsMock.mockReturnValue([
      {
        plugin: { id: "superpowers" },
        compatibility: [],
      },
    ]);
  });

  it.each(["inspect", "inspect missing"])(
    "waits for inspection cleanup before returning the %s reply",
    async (action) => {
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      if (action === "inspect missing") {
        buildPluginInspectReportMock.mockReturnValue(null);
      }
      withPluginDiagnosticsReportForInspectionMock.mockImplementation(
        async (_params, formatReport) => {
          const text = formatReport({
            ...createEmptyPluginRegistry(),
            workspaceScope: "selected",
            workspaceDir: "/tmp/plugins-workspace",
          });
          entered.resolve();
          await finish.promise;
          return text;
        },
      );
      let returned = false;
      const command = runCommand(`/plugins ${action}`).then((result) => {
        returned = true;
        return result;
      });
      try {
        await entered.promise;
        expect(returned).toBe(false);
        expect(replaceConfigFileMock).not.toHaveBeenCalled();
        expect(refreshPluginRegistryAfterConfigMutationMock).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        await command;
      }
      expect(withPluginDiagnosticsReportForInspectionMock).toHaveBeenCalledTimes(1);
      expect((await command)?.shouldContinue).toBe(false);
      expect(withPluginDiagnosticsReportForInspectionMock.mock.calls[0]?.[0]).toEqual({
        config: buildCfg(),
        workspaceDir: "/tmp/plugins-workspace",
        metadataSnapshot: { index: createInstalledPluginIndexSnapshot([]) },
      });
    },
  );

  it("lists discovered plugins", async () => {
    const listResult = await runCommand("/plugins list");
    expect(listResult?.reply?.text).toContain("Plugins");
    expect(listResult?.reply?.text).toContain("superpowers");
    expect(listResult?.reply?.text).toContain("[disabled]");
  });

  it("reports package-owned provenance for child and collection inspection", async () => {
    const install = {
      source: "npm",
      spec: "@example/pack@1.2.3",
      version: "1.2.3",
      installPath: "/plugins/pack",
      integrity: "sha512-pack",
    };
    const report = {
      plugin: { id: "pack/one" },
      compatibility: [],
      tools: [{ name: "runtime_tool" }],
    };
    const index = {
      ...createInstalledPluginIndexSnapshot([
        recordInstalledPluginIndexInstallOwner(
          { pluginId: report.plugin.id, rootDir: install.installPath },
          "pack",
        ),
      ]),
      installRecords: { pack: install },
    };
    loadPluginMetadataSnapshotMock.mockReturnValue({ index });
    buildAllPluginInspectReportsMock.mockReturnValue([report]);
    buildPluginInspectReportMock.mockReturnValue(report);
    const child = await runCommand(`/plugins inspect ${report.plugin.id}`);
    expect(
      JSON.parse(child?.reply?.text?.split("```json\n")[1]?.split("\n```")[0] ?? "null"),
    ).toEqual({ ...report, compatibilityWarnings: [], install });
    const all = await runCommand("/plugin inspect all");
    expect(
      JSON.parse(all?.reply?.text?.split("```json\n")[1]?.split("\n```")[0] ?? "null"),
    ).toEqual([{ inspect: report, compatibilityWarnings: [], install }]);
    expect(withPluginDiagnosticsReportForInspectionMock).toHaveBeenCalled();
    expect(buildPluginRegistrySnapshotReportMock).not.toHaveBeenCalled();
  });

  it("rejects invalid config before loading plugin state", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ valid: false, path: "/tmp/openclaw.json" });
    const result = await runCommand("/plugins enable pack/one", {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });
    expect(result?.reply?.text).toBe("⚠️ Config file is invalid; fix it before using /plugins.");
    expect(withPluginDiagnosticsReportForInspectionMock).not.toHaveBeenCalled();
    expect(buildPluginRegistrySnapshotReportMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("does not attribute chat install metadata when ownership conflicts", async () => {
    const inspect = { plugin: { id: "pack/one" }, compatibility: [] };
    const index = {
      ...createInstalledPluginIndexSnapshot([
        recordInstalledPluginIndexInstallOwner(
          { pluginId: inspect.plugin.id, rootDir: "/plugins/pack" },
          "pack",
          false,
        ),
      ]),
      installRecords: {
        pack: { source: "npm", installPath: "/plugins/pack" },
        "pack/one": { source: "npm", installPath: "/plugins/unrelated" },
      },
    };
    loadPluginMetadataSnapshotMock.mockReturnValue({ index });
    buildPluginInspectReportMock.mockReturnValue(inspect);
    const result = await runCommand(`/plugins inspect ${inspect.plugin.id}`);
    const payload = JSON.parse(
      result?.reply?.text?.split("```json\n")[1]?.split("\n```")[0] ?? "null",
    );
    expect(payload.install).toBeNull();
  });

  it("rejects internal writes without operator.admin", async () => {
    const params = buildPluginsParams("/plugins enable superpowers", buildCfg());
    params.command.channel = "webchat";
    params.command.channelId = "webchat";
    params.command.surface = "webchat";
    params.ctx.Provider = "webchat";
    params.ctx.Surface = "webchat";
    params.ctx.GatewayClientScopes = ["operator.write"];

    const result = await handlePluginsCommand(params, true);
    expect(result?.reply?.text).toContain("requires operator.admin");
  });

  it("blocks channel-authorized non-owner plugin toggles before config mutation", async () => {
    const params = buildPluginsParams("/plugins enable superpowers", buildCfg(), {
      omitGatewayClientScopes: true,
    });
    params.command.channel = "telegram";
    params.command.channelId = "telegram";
    params.command.surface = "telegram";
    params.command.senderId = "telegram-user-3";
    params.command.senderIsOwner = false;
    params.command.isAuthorizedSender = true;
    params.ctx.Provider = "telegram";
    params.ctx.Surface = "telegram";

    const result = await handlePluginsCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryAfterConfigMutationMock).not.toHaveBeenCalled();
  });

  it("allows gateway clients with operator.admin to toggle plugins", async () => {
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ ok: true, config: next }));
    const params = buildPluginsParams("/plugins disable superpowers", buildCfg(), {
      gatewayClientScopes: ["operator.admin", "operator.write"],
    });
    params.command.senderIsOwner = false;

    const result = await handlePluginsCommand(params, true);

    expect(result?.reply?.text).toContain('Plugin "superpowers" disabled');
    expectLastReplaceConfig(false);
    expectLastRegistryRefresh();
  });

  it("does not enable a managed plugin when capability consent is required", async () => {
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ ok: true, config: next }));
    const review: PluginCapabilityConsentReview = {
      pluginId: "superpowers",
      name: "Super Powers",
      reviewToken: "pending-review",
      source: { kind: "npm", spec: "@acme/superpowers", integrity: "sha512-superpowers" },
      declared: {
        channels: [],
        providers: [],
        tools: ["superpowers_run"],
        contracts: [],
        hooks: [],
        mcpServers: [],
        cliCommands: [],
        cliBackends: [],
        skills: [],
        dangerousConfigFlags: [],
      },
      grants: {
        hooks: {
          allowPromptInjection: { effective: true },
          allowConversationAccess: { effective: false },
        },
      },
    };
    resolvePendingPluginCapabilityReviewMock.mockReturnValue(review);
    resolvePluginCapabilityConsentMock.mockImplementation(async ({ onCapabilityConsent }) => {
      const accepted = await onCapabilityConsent?.(review);
      if (accepted?.reviewToken !== review.reviewToken) {
        throw new ManagedPluginLifecycleError('Plugin "superpowers" requires capability consent.', {
          capabilityConsent: { pluginId: review.pluginId, reviewToken: review.reviewToken },
        });
      }
    });
    const params = buildPluginsParams("/plugins enable superpowers", buildCfg(), {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });

    const result = await handlePluginsCommand(params, true);

    expect(result?.reply?.text).toContain("Tools: superpowers_run");
    expect(result?.reply?.text).toContain("Integrity: sha512-superpowers");
    expect(result?.reply?.text).toContain(
      "rerun /plugins enable superpowers --accept-capabilities",
    );
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryAfterConfigMutationMock).not.toHaveBeenCalled();

    const accepted = await runCommand("/plugins enable superpowers --accept-capabilities", {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });

    expect(accepted?.reply?.text).toContain('Plugin "superpowers" enabled');
    expectLastReplaceConfig(true);
    expectLastRegistryRefresh();
  });

  it.each([
    "--accept-capabilities",
    "--accept-capabilities superpowers",
    "superpowers --accept-capabilities --accept-capabilities",
  ])("rejects malformed enable consent flags: %s", async (argumentsText) => {
    const result = await runCommand(`/plugins enable ${argumentsText}`, {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });

    expect(result?.reply?.text).toContain(
      "Usage: /plugins enable <plugin-id-or-name> [--accept-capabilities]",
    );
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("refuses plugin enablement in Nix mode before reading or replacing config", async () => {
    await withEnvAsync({ OPENCLAW_NIX_MODE: "1" }, async () => {
      const params = buildPluginsParams("/plugins enable superpowers", buildCfg(), {
        gatewayClientScopes: WRITE_GATEWAY_SCOPES,
      });
      params.command.senderIsOwner = true;

      const result = await handlePluginsCommand(params, true);
      expect(result?.reply?.text).toContain("OPENCLAW_NIX_MODE=1");
      expect(result?.reply?.text).toContain("nix-openclaw#quick-start");
      expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
      expect(replaceConfigFileMock).not.toHaveBeenCalled();
      expect(refreshPluginRegistryAfterConfigMutationMock).not.toHaveBeenCalled();
    });
  });

  it("resolves write targets by indexed plugin name without loading diagnostics", async () => {
    buildPluginRegistrySnapshotReportMock.mockReturnValue({
      workspaceDir: "/tmp/plugins-workspace",
      plugins: [{ ...pluginSummary, name: "Super Powers" }],
    });
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ ok: true, config: next }));

    const params = buildPluginsParams("/plugins enable Super Powers", buildCfg(), {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });
    params.command.senderIsOwner = true;

    const result = await handlePluginsCommand(params, true);
    expect(result?.reply?.text).toContain('Plugin "superpowers" enabled');
    expect(buildPluginRegistrySnapshotReportMock).toHaveBeenCalledTimes(1);
    expect(withPluginDiagnosticsReportForInspectionMock).not.toHaveBeenCalled();
  });

  it("returns an explicit unauthorized reply for native /plugins list", async () => {
    const params = buildPluginsParams("/plugins list", buildCfg());
    params.command.isAuthorizedSender = false;
    params.ctx.Provider = "telegram";
    params.ctx.Surface = "telegram";
    params.ctx.CommandSource = "native";
    params.command.channel = "telegram";
    params.command.channelId = "telegram";
    params.command.surface = "telegram";

    const result = await handlePluginsCommand(params, true);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "You are not authorized to use this command." },
    });
  });
});
