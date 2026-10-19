import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildPluginCapabilityConsentReview } from "../../plugins/capability-summary.js";
import { recordInstalledPluginIndexInstallOwner } from "../../plugins/installed-plugin-index-install-owner.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createInstalledPluginIndexSnapshot } from "../../plugins/status.test-fixtures.js";
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

// mock-isolation: Keep configuration reads and writes inside the command fixture.
vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  replaceConfigFile: replaceConfigFileMock,
  transformConfigFileWithRetry: async (params: {
    afterWrite?: unknown;
    transform: (currentConfig: OpenClawConfig) => Promise<{ nextConfig: OpenClawConfig }>;
  }) => {
    const snapshot = (await readConfigFileSnapshotMock()) as ConfigSnapshotMock;
    const transformed = await params.transform(structuredClone(snapshot.sourceConfig ?? {}));
    await replaceConfigFileMock({
      nextConfig: transformed.nextConfig,
      afterWrite: params.afterWrite ?? { mode: "auto" },
    });
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

// mock-isolation: Supply fixed reports without loading the real plugin runtime.
vi.mock("../../plugins/status.js", () => ({
  buildAllPluginInspectReports: buildAllPluginInspectReportsMock,
  withPluginDiagnosticsReportForInspection: withPluginDiagnosticsReportForInspectionMock,
  buildPluginInspectReport: buildPluginInspectReportMock,
  buildPluginRegistrySnapshotReport: buildPluginRegistrySnapshotReportMock,
  formatPluginCompatibilityNotice: vi.fn(() => "ok"),
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

vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  resolveUserPath: vi.fn((value: string) => value),
}));

const buildCfg = (): OpenClawConfig => ({
  plugins: { enabled: true },
  commands: { text: true, plugins: true },
});

const pluginSummary = {
  id: "superpowers",
  name: "superpowers",
  status: "disabled",
  format: "openclaw",
  bundleFormat: "claude",
} as const;

const WRITE_GATEWAY_SCOPES = ["operator.admin", "operator.write", "operator.pairing"];

function runCommand(
  commandBodyNormalized: string,
  options: {
    gatewayClientScopes?: string[];
    omitGatewayClientScopes?: boolean;
    channel?: string;
    command?: Partial<ReturnType<typeof buildPluginsCommandParams>["command"]>;
    ctx?: Partial<ReturnType<typeof buildPluginsCommandParams>["ctx"]>;
  } = {},
) {
  const params = buildPluginsCommandParams({
    commandBodyNormalized,
    cfg: buildCfg(),
    gatewayClientScopes: options.gatewayClientScopes,
  });
  if (options.channel) {
    Object.assign(params.command, {
      channel: options.channel,
      channelId: options.channel,
      surface: options.channel,
    });
    Object.assign(params.ctx, { Provider: options.channel, Surface: options.channel });
  }
  Object.assign(params.command, options.command);
  Object.assign(params.ctx, options.ctx);
  if (options.omitGatewayClientScopes) {
    delete params.ctx.GatewayClientScopes;
  }
  return handlePluginsCommand(params, true);
}

function expectLastMutation(enabled: boolean) {
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
  expect(refreshPluginRegistryAfterConfigMutationMock.mock.lastCall).toStrictEqual([
    {
      reason: "policy-changed",
      logger: expect.objectContaining({ warn: expect.any(Function) }),
    },
  ]);
}

function expectNoMutation(beforeRead = false) {
  if (beforeRead) {
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  }
  expect(replaceConfigFileMock).not.toHaveBeenCalled();
  expect(refreshPluginRegistryAfterConfigMutationMock).not.toHaveBeenCalled();
}

async function inspectJson(command: string) {
  const result = await runCommand(command);
  return JSON.parse(result?.reply?.text?.split("```json\n")[1]?.split("\n```")[0] ?? "null");
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
    });
    validateConfigObjectWithPluginsMock.mockImplementation((config) => ({ ok: true, config }));
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
        }),
      );
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
        expectNoMutation();
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
    expect(await inspectJson(`/plugins inspect ${report.plugin.id}`)).toEqual({
      ...report,
      compatibilityWarnings: [],
      install,
    });
    expect(await inspectJson("/plugin inspect all")).toEqual([
      { inspect: report, compatibilityWarnings: [], install },
    ]);
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
    expect((await inspectJson(`/plugins inspect ${inspect.plugin.id}`)).install).toBeNull();
  });

  it("rejects internal writes without operator.admin", async () => {
    const result = await runCommand("/plugins enable superpowers", {
      channel: "webchat",
      gatewayClientScopes: ["operator.write"],
    });
    expect(result?.reply?.text).toContain("requires operator.admin");
  });

  it("blocks channel-authorized non-owner plugin toggles before config mutation", async () => {
    const result = await runCommand("/plugins enable superpowers", {
      omitGatewayClientScopes: true,
      channel: "telegram",
      command: { senderId: "telegram-user-3", senderIsOwner: false, isAuthorizedSender: true },
    });
    expect(result?.shouldContinue).toBe(false);
    expectNoMutation(true);
  });

  it("allows gateway clients with operator.admin to toggle plugins", async () => {
    const result = await runCommand("/plugins disable superpowers", {
      gatewayClientScopes: ["operator.admin", "operator.write"],
      command: { senderIsOwner: false },
    });
    expect(result?.reply?.text).toContain('Plugin "superpowers" disabled');
    expectLastMutation(false);
  });

  it("does not enable a managed plugin when capability consent is required", async () => {
    const review = buildPluginCapabilityConsentReview({
      pluginId: "superpowers",
      manifest: { name: "Super Powers", contracts: { tools: ["superpowers_run"] } },
      record: { source: "npm", spec: "@acme/superpowers", integrity: "sha512-superpowers" },
      config: buildCfg(),
    });
    resolvePendingPluginCapabilityReviewMock.mockReturnValue(review);
    resolvePluginCapabilityConsentMock.mockImplementation(async ({ onCapabilityConsent }) => {
      const accepted = await onCapabilityConsent?.(review);
      if (accepted?.reviewToken !== review.reviewToken) {
        throw new ManagedPluginLifecycleError('Plugin "superpowers" requires capability consent.', {
          capabilityConsent: { pluginId: review.pluginId, reviewToken: review.reviewToken },
        });
      }
    });
    const result = await runCommand("/plugins enable superpowers", {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });
    expect(result?.reply?.text).toContain("Tools: superpowers_run");
    expect(result?.reply?.text).toContain("Integrity: sha512-superpowers");
    expect(result?.reply?.text).toContain(
      "rerun /plugins enable superpowers --accept-capabilities",
    );
    expectNoMutation();

    const accepted = await runCommand("/plugins enable superpowers --accept-capabilities", {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });

    expect(accepted?.reply?.text).toContain('Plugin "superpowers" enabled');
    expectLastMutation(true);
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
      const result = await runCommand("/plugins enable superpowers", {
        gatewayClientScopes: WRITE_GATEWAY_SCOPES,
      });
      expect(result?.reply?.text).toContain("OPENCLAW_NIX_MODE=1");
      expect(result?.reply?.text).toContain("nix-openclaw#quick-start");
      expectNoMutation(true);
    });
  });

  it("resolves write targets by indexed plugin name without loading diagnostics", async () => {
    buildPluginRegistrySnapshotReportMock.mockReturnValue({
      workspaceDir: "/tmp/plugins-workspace",
      plugins: [{ ...pluginSummary, name: "Super Powers" }],
    });
    const result = await runCommand("/plugins enable Super Powers", {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });
    expect(result?.reply?.text).toContain('Plugin "superpowers" enabled');
    expect(buildPluginRegistrySnapshotReportMock).toHaveBeenCalledTimes(1);
    expect(withPluginDiagnosticsReportForInspectionMock).not.toHaveBeenCalled();
  });

  it("returns an explicit unauthorized reply for native /plugins list", async () => {
    const result = await runCommand("/plugins list", {
      channel: "telegram",
      command: { isAuthorizedSender: false },
      ctx: { CommandSource: "native" },
    });
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "You are not authorized to use this command." },
    });
  });
});
