import { Command } from "commander";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

export const loadConfig = vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig);
export const readConfigFileSnapshot = vi.fn();
export const writeConfigFile = vi.fn<(config: OpenClawConfig) => Promise<void>>(
  async () => undefined,
);
export const replaceConfigFile = vi.fn(
  async (params: { nextConfig: OpenClawConfig }) => await writeConfigFile(params.nextConfig),
);
export const resolveStateDir = vi.fn(() => "/tmp/openclaw-state");
export const installPluginFromMarketplace = vi.fn();
export const listMarketplacePlugins = vi.fn();
export const resolveMarketplaceInstallShortcut = vi.fn();
export const enablePluginInConfig = vi.fn();
export const recordPluginInstall = vi.fn();
export const clearPluginManifestRegistryCache = vi.fn();
export const buildPluginSnapshotReport = vi.fn();
export const buildPluginDiagnosticsReport = vi.fn();
export const buildPluginCompatibilityNotices = vi.fn();
export const applyExclusiveSlotSelection = vi.fn();
export const uninstallPlugin = vi.fn();
export const updateNpmInstalledPlugins = vi.fn();
export const updateNpmInstalledHookPacks = vi.fn();
export const promptYesNo = vi.fn();
export const installPluginFromNpmSpec = vi.fn();
export const installPluginFromPath = vi.fn();
export const installPluginFromClawHub = vi.fn();
export const parseClawHubPluginSpec = vi.fn();
export const installHooksFromNpmSpec = vi.fn();
export const installHooksFromPath = vi.fn();
export const recordHookInstall = vi.fn();

const { defaultRuntime, runtimeLogs, runtimeErrors, resetRuntimeCapture } =
  createCliRuntimeCapture();

export { runtimeErrors, runtimeLogs };

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  readConfigFileSnapshot: (...args: unknown[]) => readConfigFileSnapshot(...args),
  writeConfigFile: (config: OpenClawConfig) => writeConfigFile(config),
  replaceConfigFile: (params: { nextConfig: OpenClawConfig }) => replaceConfigFile(params),
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => resolveStateDir(),
}));

vi.mock("../plugins/marketplace.js", () => ({
  installPluginFromMarketplace: (...args: unknown[]) => installPluginFromMarketplace(...args),
  listMarketplacePlugins: (...args: unknown[]) => listMarketplacePlugins(...args),
  resolveMarketplaceInstallShortcut: (...args: unknown[]) =>
    resolveMarketplaceInstallShortcut(...args),
}));

vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig: (...args: unknown[]) => enablePluginInConfig(...args),
}));

vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall: (...args: unknown[]) => recordPluginInstall(...args),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: () => clearPluginManifestRegistryCache(),
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginSnapshotReport: (...args: unknown[]) => buildPluginSnapshotReport(...args),
  buildPluginDiagnosticsReport: (...args: unknown[]) => buildPluginDiagnosticsReport(...args),
  buildPluginCompatibilityNotices: (...args: unknown[]) => buildPluginCompatibilityNotices(...args),
}));

vi.mock("../plugins/slots.js", () => ({
  applyExclusiveSlotSelection: (...args: unknown[]) => applyExclusiveSlotSelection(...args),
}));

vi.mock("../plugins/uninstall.js", () => ({
  uninstallPlugin: (...args: unknown[]) => uninstallPlugin(...args),
  resolveUninstallDirectoryTarget: ({
    installRecord,
  }: {
    installRecord?: { installPath?: string; sourcePath?: string };
  }) => installRecord?.installPath ?? installRecord?.sourcePath ?? null,
}));

vi.mock("../plugins/update.js", () => ({
  updateNpmInstalledPlugins: (...args: unknown[]) => updateNpmInstalledPlugins(...args),
}));

vi.mock("../hooks/update.js", () => ({
  updateNpmInstalledHookPacks: (...args: unknown[]) => updateNpmInstalledHookPacks(...args),
}));

vi.mock("./prompt.js", () => ({
  promptYesNo: (...args: unknown[]) => promptYesNo(...args),
}));

vi.mock("../plugins/install.js", () => ({
  PLUGIN_INSTALL_ERROR_CODE: {
    NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  },
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpec(...args),
  installPluginFromPath: (...args: unknown[]) => installPluginFromPath(...args),
}));

vi.mock("../hooks/install.js", () => ({
  installHooksFromNpmSpec: (...args: unknown[]) => installHooksFromNpmSpec(...args),
  installHooksFromPath: (...args: unknown[]) => installHooksFromPath(...args),
  resolveHookInstallDir: (hookId: string) => `/tmp/hooks/${hookId}`,
}));

vi.mock("../hooks/installs.js", () => ({
  recordHookInstall: (...args: unknown[]) => recordHookInstall(...args),
}));

vi.mock("../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
  },
  installPluginFromClawHub: (...args: unknown[]) => installPluginFromClawHub(...args),
  formatClawHubSpecifier: ({ name, version }: { name: string; version?: string }) =>
    `clawhub:${name}${version ? `@${version}` : ""}`,
}));

vi.mock("../infra/clawhub.js", () => ({
  parseClawHubPluginSpec: (...args: unknown[]) => parseClawHubPluginSpec(...args),
}));

const { registerPluginsCli } = await import("./plugins-cli.js");

export { registerPluginsCli };

export function runPluginsCommand(argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerPluginsCli(program);
  return program.parseAsync(argv, { from: "user" });
}

export function resetPluginsCliTestState() {
  resetRuntimeCapture();
  loadConfig.mockReset();
  readConfigFileSnapshot.mockReset();
  writeConfigFile.mockReset();
  replaceConfigFile.mockReset();
  resolveStateDir.mockReset();
  installPluginFromMarketplace.mockReset();
  listMarketplacePlugins.mockReset();
  resolveMarketplaceInstallShortcut.mockReset();
  enablePluginInConfig.mockReset();
  recordPluginInstall.mockReset();
  clearPluginManifestRegistryCache.mockReset();
  buildPluginSnapshotReport.mockReset();
  buildPluginDiagnosticsReport.mockReset();
  buildPluginCompatibilityNotices.mockReset();
  applyExclusiveSlotSelection.mockReset();
  uninstallPlugin.mockReset();
  updateNpmInstalledPlugins.mockReset();
  updateNpmInstalledHookPacks.mockReset();
  promptYesNo.mockReset();
  installPluginFromNpmSpec.mockReset();
  installPluginFromPath.mockReset();
  installPluginFromClawHub.mockReset();
  parseClawHubPluginSpec.mockReset();
  installHooksFromNpmSpec.mockReset();
  installHooksFromPath.mockReset();
  recordHookInstall.mockReset();

  loadConfig.mockReturnValue({} as OpenClawConfig);
  readConfigFileSnapshot.mockImplementation(async () => {
    const config = loadConfig();
    return {
      path: "/tmp/openclaw-config.json5",
      exists: true,
      raw: "{}",
      parsed: config,
      resolved: config,
      sourceConfig: config,
      runtimeConfig: config,
      valid: true,
      config,
      hash: "mock",
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
  });
  writeConfigFile.mockResolvedValue(undefined);
  replaceConfigFile.mockImplementation(
    async (params: { nextConfig: OpenClawConfig }) => await writeConfigFile(params.nextConfig),
  );
  resolveStateDir.mockReturnValue("/tmp/openclaw-state");
  resolveMarketplaceInstallShortcut.mockResolvedValue(null);
  installPluginFromMarketplace.mockResolvedValue({
    ok: false,
    error: "marketplace install failed",
  });
  enablePluginInConfig.mockImplementation((cfg: OpenClawConfig) => ({ config: cfg }));
  recordPluginInstall.mockImplementation((cfg: OpenClawConfig) => cfg);
  const defaultPluginReport = {
    plugins: [],
    diagnostics: [],
  };
  buildPluginSnapshotReport.mockReturnValue(defaultPluginReport);
  buildPluginDiagnosticsReport.mockReturnValue(defaultPluginReport);
  buildPluginCompatibilityNotices.mockReturnValue([]);
  applyExclusiveSlotSelection.mockImplementation(({ config }: { config: OpenClawConfig }) => ({
    config,
    warnings: [],
  }));
  uninstallPlugin.mockResolvedValue({
    ok: true,
    config: {} as OpenClawConfig,
    warnings: [],
    actions: {
      entry: false,
      install: false,
      allowlist: false,
      loadPath: false,
      memorySlot: false,
      directory: false,
    },
  });
  updateNpmInstalledPlugins.mockResolvedValue({
    outcomes: [],
    changed: false,
    config: {} as OpenClawConfig,
  });
  updateNpmInstalledHookPacks.mockResolvedValue({
    outcomes: [],
    changed: false,
    config: {} as OpenClawConfig,
  });
  promptYesNo.mockResolvedValue(true);
  installPluginFromPath.mockResolvedValue({ ok: false, error: "path install disabled in test" });
  installPluginFromNpmSpec.mockResolvedValue({
    ok: false,
    error: "npm install disabled in test",
  });
  installPluginFromClawHub.mockResolvedValue({
    ok: false,
    error: "clawhub install disabled in test",
  });
  parseClawHubPluginSpec.mockReturnValue(null);
  installHooksFromPath.mockResolvedValue({
    ok: false,
    error: "hook path install disabled in test",
  });
  installHooksFromNpmSpec.mockResolvedValue({
    ok: false,
    error: "hook npm install disabled in test",
  });
  recordHookInstall.mockImplementation((cfg: OpenClawConfig) => cfg);
}
