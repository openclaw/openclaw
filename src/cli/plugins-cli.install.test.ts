// Plugins CLI install tests cover plugin install command selection and output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.types.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  applyExclusiveSlotSelectionMock,
  enablePluginInConfigMock,
  findBundledPluginSourceMock,
  installHooksFromNpmSpecMock,
  installHooksFromPathMock,
  installPluginFromGitSpecMock,
  installPluginFromClawHubMock,
  installPluginFromMarketplaceMock,
  installPluginFromNpmSpecMock,
  installPluginFromPathMock,
  pluginCliConfigMock,
  readConfigFileSnapshotMock,
  readConfigFileSnapshotForWriteMock,
  promptYesNoMock,
  reportClawHubPluginInstallTelemetryMock,
  recordHookInstallMock,
  recordPluginInstallMock,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";
import { runPluginInstallCommand } from "./plugins-install-command.js";
import { createCliTtyMock } from "./test-runtime-capture.js";

// Use a stable build identity; beta cases select their update channel.
const resolveNpmSpecMetadataMock = vi.hoisted(() =>
  vi.fn<typeof import("../infra/install-source-utils.js").resolveNpmSpecMetadata>(),
);
vi.mock("../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: resolveNpmSpecMetadataMock,
}));
vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: async () => ({
    source: "hosted",
    entries: [],
  }),
}));

vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  VERSION: "2026.8.1",
}));

const CLI_STATE_ROOT = resolveStateDir();
const { set: setTty, restore: restoreTty } = createCliTtyMock();
const PROFILE_STATE_ROOT = path.join(CLI_STATE_ROOT, "ledger-profile");

const tempDirectories = new Set<string>();

function createTempDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirectories.add(directory);
  return directory;
}

function mockNpmChannelMetadata(name: string, beta?: string, latest?: string): void {
  resolveNpmSpecMetadataMock.mockImplementation(async ({ spec }) => {
    if (spec !== `${name}@beta` && spec !== `${name}@latest`) {
      throw new Error(`Unexpected npm metadata request: ${spec}`);
    }
    const version = spec === `${name}@beta` ? beta : latest;
    return version
      ? { ok: true, metadata: { name, version, resolvedSpec: `${name}@${version}` } }
      : { ok: false, error: `Package not found on npm: ${spec}` };
  });
}

function cliInstallPath(pluginId: string): string {
  return installedPluginRoot(CLI_STATE_ROOT, pluginId);
}

function useProfileExtensionsDir(): string {
  vi.stubEnv("OPENCLAW_STATE_DIR", PROFILE_STATE_ROOT);
  return path.resolve(PROFILE_STATE_ROOT, "extensions");
}

function createEnabledPluginConfig(pluginId: string): OpenClawConfig {
  return { plugins: { entries: { [pluginId]: { enabled: true } } } };
}

function createEmptyPluginConfig(): OpenClawConfig {
  return { plugins: { entries: {} } };
}

function createClawHubInstallResult(params: {
  pluginId: string;
  packageName: string;
  version: string;
  channel: string;
}): Awaited<ReturnType<typeof installPluginFromClawHubMock>> {
  return {
    ok: true,
    pluginId: params.pluginId,
    targetDir: cliInstallPath(params.pluginId),
    version: params.version,
    packageName: params.packageName,
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: params.packageName,
      clawhubFamily: "code-plugin",
      clawhubChannel: params.channel,
      version: params.version,
      integrity: "sha256-abc",
      resolvedAt: "2026-03-22T00:00:00.000Z",
      clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      clawpackSpecVersion: 1,
      clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      clawpackSize: 4096,
    },
  };
}

function createNpmPluginInstallResult(
  pluginId = "demo",
  version = "1.2.3",
): Awaited<ReturnType<typeof installPluginFromNpmSpecMock>> {
  return {
    ok: true,
    pluginId,
    targetDir: cliInstallPath(pluginId),
    version,
    npmResolution: {
      packageName: pluginId,
      resolvedVersion: version,
      tarballUrl: `https://registry.npmjs.org/${pluginId}/-/${pluginId}-${version}.tgz`,
    },
  };
}

function primeSuccessfulPluginPersistence(pluginId = "demo") {
  const cfg = createEmptyPluginConfig();
  const enabledCfg = createEnabledPluginConfig(pluginId);

  pluginCliConfigMock.mockReturnValue(cfg);
  enablePluginInConfigMock.mockReturnValue({ config: enabledCfg });
  recordPluginInstallMock.mockReturnValue(enabledCfg);
  applyExclusiveSlotSelectionMock.mockReturnValue(enabledCfg);

  return { cfg, enabledCfg };
}

function primeSuccessfulClawHubPluginInstall() {
  const result = primeSuccessfulPluginPersistence("demo");

  installPluginFromClawHubMock.mockResolvedValue(
    createClawHubInstallResult({
      pluginId: "demo",
      packageName: "demo",
      version: "1.2.3",
      channel: "official",
    }),
  );
  return result;
}

function createEnabledHookConfig(): OpenClawConfig {
  return {
    hooks: { internal: { enabled: true, entries: { "command-audit": { enabled: true } } } },
  };
}

function createHookPackInstallResult(targetDir: string): {
  ok: true;
  hookPackId: string;
  hooks: string[];
  packageKind: "hook-only";
  targetDir: string;
  version: string;
} {
  return {
    ok: true,
    hookPackId: "demo-hooks",
    hooks: ["command-audit"],
    packageKind: "hook-only",
    targetDir,
    version: "1.2.3",
  };
}

type MockWithCalls = {
  mock: {
    calls: readonly (readonly unknown[])[];
  };
};

type PluginInstallCall = {
  allowSourceTypeScriptEntries?: boolean;
  dryRun?: boolean;
  expectedIntegrity?: string;
  expectedPackageKind?: "hook-only";
  expectedPluginId?: string;
  extensionsDir?: string;
  inspection?: "package-kind";
  logger?: {
    info?: unknown;
    warn?: unknown;
  };
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
  mode?: string;
  path?: string;
  spec?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
};

function mockCallArg(mock: MockWithCalls, callIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[0];
}

function clawHubInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromClawHubMock, callIndex) as PluginInstallCall;
}

function npmInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromNpmSpecMock, callIndex) as PluginInstallCall;
}

function pathInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromPathMock, callIndex) as PluginInstallCall;
}

function hookPathInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installHooksFromPathMock, callIndex) as PluginInstallCall;
}

function hookNpmInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installHooksFromNpmSpecMock, callIndex) as PluginInstallCall;
}

function persistedInstallRecord(pluginId: string, callIndex = 0) {
  const record =
    writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mock.calls[callIndex]?.[0][
      pluginId
    ];
  if (!record) {
    throw new Error(`Expected persisted install record for ${pluginId}`);
  }
  return record;
}

function runtimeLogsContain(fragment: string): boolean {
  return pluginsCliRuntimeLogs.some((line) => line.includes(fragment));
}

const NON_CLAWHUB_INSTALL_FORCE_FLAG = "--force";

function install(raw: string, ...flags: string[]) {
  return runPluginsCommand(["plugins", "install", raw, ...flags]);
}

function installAcknowledged(raw: string, ...flags: string[]) {
  return install(
    raw,
    ...flags,
    ...(flags.includes("--force") ? [] : ["--force"]),
    ...(flags.includes("--accept-capabilities") ? [] : ["--accept-capabilities"]),
  );
}

function installAccepted(raw: string, ...flags: string[]) {
  return install(raw, ...flags, "--accept-capabilities");
}

function blockConfigMutation(...sections: Array<"plugins" | "hooks">) {
  const config = {};
  const configPath = path.join(process.cwd(), "openclaw.json5");
  const paths = sections.map((section) => [
    section,
    path.join(path.parse(process.cwd()).root, "external-openclaw", `${section}.json5`),
  ]);
  const parsed = Object.fromEntries(
    paths.map(([section, target]) => [section, { $include: target }]),
  );
  pluginCliConfigMock.mockReturnValue(config);
  readConfigFileSnapshotForWriteMock.mockResolvedValue({
    snapshot: {
      ...createTestConfigSnapshot(config, config, configPath),
      raw: JSON.stringify(parsed),
      parsed,
      hash: "blocked-install-config",
    },
    writeOptions: {
      assertConfigPathForWrite: () => {},
      expectedConfigPath: configPath,
      ownedConfigPathForWrite: configPath,
      includeFileTargetsForWrite: Object.fromEntries(paths.map(([, target]) => [target, target])),
    },
  });
}

function mockConfigRequiredBundle(pluginId: string) {
  findBundledPluginSourceMock.mockReturnValue({
    pluginId,
    localPath: `/app/dist/extensions/${pluginId}`,
    configSchema: {
      type: "object",
      required: ["token"],
      properties: { token: { type: "string" } },
    },
    requiresConfig: true,
  });
}

describe("plugins cli install", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    resolveNpmSpecMetadataMock.mockReset().mockImplementation(async ({ spec }) => {
      throw new Error(`Unexpected npm metadata request: ${spec}`);
    });
  });

  afterEach(() => {
    for (const directory of tempDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    tempDirectories.clear();
    vi.unstubAllEnvs();
    restoreTty();
  });

  it("refuses plugin installs in Nix mode before installer side effects", async () => {
    vi.stubEnv("OPENCLAW_NIX_MODE", "1");

    await expect(installAcknowledged("@acme/demo")).rejects.toThrow("OPENCLAW_NIX_MODE=1");

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
    expect(installPluginFromMarketplaceMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("rejects a cancelled install before installer or persistence side effects", async () => {
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));
    const readSnapshot = readConfigFileSnapshotForWriteMock.getMockImplementation();
    if (!readSnapshot) {
      throw new Error("missing config snapshot fixture");
    }
    let active = true;
    readConfigFileSnapshotForWriteMock.mockImplementation(async (...args) => {
      const snapshot = await readSnapshot(...args);
      active = false;
      return snapshot;
    });
    await expect(
      runPluginInstallCommand({
        raw: "npm:demo",
        opts: { force: true, acceptCapabilities: true },
        allowInstallPolicyWarningPrompt: false,
        beforePersistentApply: () => {
          if (!active) {
            throw new Error("installation authority closed");
          }
        },
      }),
    ).rejects.toThrow("installation authority closed");
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(recordHookInstallMock).not.toHaveBeenCalled();
    expect(await loadInstalledPluginIndexInstallRecords()).toEqual({});
    expect(runtimeLogsContain("Installed")).toBe(false);
  });

  it.each([
    ["plugin-capable", "@acme/dual-package"],
    ["probe throws", "@acme/demo-plugin"],
  ])("fails closed for a blocked npm plugin when the hook probe reports %s", async (kind, spec) => {
    blockConfigMutation("plugins");
    installHooksFromNpmSpecMock.mockImplementation(async () => {
      if (kind === "probe throws") {
        throw new Error("hook validation exploded");
      }
      return {
        ...createHookPackInstallResult("/tmp/hooks/demo-hooks"),
        packageKind: "plugin-capable",
      };
    });
    await expect(installAcknowledged(spec)).rejects.toThrow("__exit__:1");
    expect(installHooksFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(hookNpmInstallCall().inspection).toBe("package-kind");
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("installs a positively identified npm hook pack without probing plugin installation", async () => {
    const installedCfg = createEnabledHookConfig();
    blockConfigMutation("plugins");
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: true,
      hookPackId: "demo-hooks",
      hooks: ["command-audit"],
      packageKind: "hook-only",
      targetDir: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
      npmResolution: {
        name: "@acme/demo-hooks",
        version: "1.2.3",
        resolvedSpec: "@acme/demo-hooks@1.2.3",
        integrity: "sha256-demo",
      },
    });
    await installAcknowledged("@acme/demo-hooks");

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(installHooksFromNpmSpecMock).toHaveBeenCalledTimes(2);
    expect(hookNpmInstallCall().inspection).toBe("package-kind");
    expect(hookNpmInstallCall(1).expectedIntegrity).toBe("sha256-demo");
    expect(hookNpmInstallCall(1).expectedPackageKind).toBe("hook-only");
    expect(mockCallArg(recordHookInstallMock)).toMatchObject({
      hookId: "demo-hooks",
      spec: "@acme/demo-hooks",
      resolvedVersion: "1.2.3",
      resolvedSpec: "@acme/demo-hooks@1.2.3",
      integrity: "sha256-demo",
      hooks: ["command-audit"],
    });
    expect(hookNpmInstallCall(1).mode).toBe("update");
    expect(runtimeLogsContain("Installed hook pack: demo-hooks")).toBe(true);
    expect(configWriteMock).toHaveBeenCalledWith(installedCfg);
  });

  it("blocks npm package inspection when plugin and hook config are include-owned", async () => {
    blockConfigMutation("plugins", "hooks");
    await expect(installAcknowledged("@acme/demo-hooks")).rejects.toThrow("__exit__:1");

    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config hooks are stored in an external or unresolved top-level $include",
    );
  });

  it("blocks a proven local hook pack before plugin installer side effects when only hooks config is include-owned", async () => {
    const localPath = createTempDirectory("openclaw-hook-pack-");
    blockConfigMutation("hooks");
    installHooksFromPathMock.mockResolvedValue(createHookPackInstallResult(localPath));

    await expect(installAcknowledged(localPath)).rejects.toThrow("__exit__:1");

    expect(installHooksFromPathMock).toHaveBeenCalledTimes(1);
    expect(hookPathInstallCall().inspection).toBe("package-kind");
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config hooks are stored in an external or unresolved top-level $include",
    );
  });

  it.skipIf(process.platform === "win32")(
    "preserves local hook-pack precedence for prefix-shaped paths",
    async () => {
      const localPath = path.join(process.cwd(), `clawhub:demo-hooks-${process.pid}`);
      const installedCfg = createEnabledHookConfig();
      fs.mkdirSync(localPath);
      blockConfigMutation("plugins");

      installPluginFromPathMock.mockResolvedValue({
        ok: false,
        error: "package.json missing openclaw.extensions",
        code: "missing_openclaw_extensions",
      });
      installHooksFromPathMock.mockResolvedValue(createHookPackInstallResult(localPath));

      try {
        await installAcknowledged(path.basename(localPath));
      } finally {
        fs.rmSync(localPath, { recursive: true, force: true });
      }

      expect(installPluginFromPathMock).not.toHaveBeenCalled();
      expect(installHooksFromPathMock).toHaveBeenCalledTimes(2);
      expect(hookPathInstallCall().inspection).toBe("package-kind");
      expect(hookPathInstallCall(1).expectedPackageKind).toBe("hook-only");
      expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
      expect(configWriteMock).toHaveBeenCalledWith(installedCfg);
    },
  );

  it("blocks explicit marketplace installs before installer side effects", async () => {
    blockConfigMutation("plugins");
    await expect(installAcknowledged("demo", "--marketplace", "local/repo")).rejects.toThrow(
      "__exit__:1",
    );
    expect(installPluginFromMarketplaceMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("inspects the npm hook fallback when an official plugin's config is include-owned", async () => {
    blockConfigMutation("plugins");
    findBundledPluginSourceMock.mockReturnValue(undefined);
    await expect(install("brave")).rejects.toThrow("__exit__:1");
    expect(hookNpmInstallCall()).toMatchObject({
      spec: "@openclaw/brave-plugin",
      inspection: "package-kind",
    });
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("fails closed for unrelated invalid config before installer side effects", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    pluginCliConfigMock.mockImplementation(() => {
      throw invalidConfigErr;
    });
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw-config.json5",
      exists: true,
      raw: '{ "models": { "default": 123 } }',
      parsed: { models: { default: 123 } },
      resolved: { models: { default: 123 } },
      valid: false,
      config: { models: { default: 123 } },
      hash: "mock",
      issues: [{ path: "models.default", message: "invalid model ref" }],
      warnings: [],
      legacyIssues: [],
    });

    await expect(installAcknowledged("alpha")).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
    expect(installPluginFromMarketplaceMock).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("requires acknowledgement for noninteractive non-ClawHub plugin installs", async () => {
    setTty(false);
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await expect(install("npm:demo")).rejects.toThrow("__exit__:1");

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("outside ClawHub review");
    expect(runtimeErrors.at(-1)).toContain(NON_CLAWHUB_INSTALL_FORCE_FLAG);
  });

  it("does not require acknowledgement for a bundled plugin's local source path", async () => {
    const localPath = createTempDirectory("openclaw-bundled-plugin-source-");
    findBundledPluginSourceMock.mockImplementation((params: unknown) => {
      const { lookup } = params as {
        lookup: { kind: "localPath" | "npmSpec" | "pluginId"; value: string };
      };
      return lookup.kind === "localPath" && path.resolve(lookup.value) === path.resolve(localPath)
        ? { pluginId: "demo", localPath }
        : undefined;
    });
    primeSuccessfulPluginPersistence("demo");
    installPluginFromPathMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: cliInstallPath("demo"),
      version: "1.0.0",
      extensions: ["index.js"],
    });

    await install(localPath);

    expect(promptYesNoMock).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).not.toContain("outside ClawHub review");
    expect(installPluginFromPathMock).toHaveBeenCalledTimes(1);
  });

  it("prompts interactive users before non-ClawHub plugin installs and cancels on no", async () => {
    setTty(true);
    promptYesNoMock.mockResolvedValueOnce(false);
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await expect(install("npm:demo")).rejects.toThrow("__exit__:1");

    expect(promptYesNoMock).toHaveBeenCalledWith("Install this non-ClawHub plugin source?");
    expect(runtimeLogsContain("Installing plugin from npm registry")).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
  });

  it("prompts interactive users before non-ClawHub plugin installs and proceeds on yes", async () => {
    setTty(true);
    promptYesNoMock.mockResolvedValueOnce(true);
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await install("npm:demo");

    expect(promptYesNoMock).toHaveBeenCalledWith("Install this non-ClawHub plugin source?");
    expect(runtimeLogsContain("Installing plugin from npm registry")).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(persistedInstallRecord("demo").source).toBe("npm");
  });

  it("does not install a stable ClawHub release when no beta release exists", async () => {
    primeSuccessfulClawHubPluginInstall();

    pluginCliConfigMock.mockReturnValue({
      ...createEmptyPluginConfig(),
      update: { channel: "beta" },
    } as OpenClawConfig);
    installPluginFromClawHubMock.mockResolvedValue({
      ok: false,
      error: "Version not found on ClawHub: @openclaw/brave-plugin@beta.",
      code: "version_not_found",
    });

    await expect(install("clawhub:@openclaw/brave-plugin")).rejects.toThrow("__exit__:1");

    expect(clawHubInstallCall(0).spec).toBe("clawhub:@openclaw/brave-plugin@beta");
    expect(installPluginFromClawHubMock).toHaveBeenCalledTimes(1);
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "No clawhub:@openclaw/brave-plugin@beta release is published for this gateway",
    );
  });

  it("rejects unacknowledged noninteractive ClawHub installs before persistence", async () => {
    setTty(false);
    primeSuccessfulClawHubPluginInstall();

    await expect(install("clawhub:demo")).rejects.toThrow("--accept-capabilities");

    expect(configWriteMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(reportClawHubPluginInstallTelemetryMock).not.toHaveBeenCalled();
  });

  it("installs a pinned ClawHub plugin in the active profile and persists source metadata", async () => {
    const extensionsDir = useProfileExtensionsDir();
    const { enabledCfg } = primeSuccessfulClawHubPluginInstall();
    await installAccepted("clawhub:demo@1.2.3", "--force");
    expect(clawHubInstallCall()).toMatchObject({
      spec: "clawhub:demo@1.2.3",
      mode: "update",
      extensionsDir,
    });
    expect(runtimeLogsContain("outside ClawHub review")).toBe(false);
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("clawhub");
    expect(record.spec).toBe("clawhub:demo@1.2.3");
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.version).toBe("1.2.3");
    expect(record.clawhubPackage).toBe("demo");
    expect(record.clawhubFamily).toBe("code-plugin");
    expect(record.clawhubChannel).toBe("official");
    expect(record.clawpackSha256).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(record.clawpackSpecVersion).toBe(1);
    expect(record.clawpackManifestSha256).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(record.clawpackSize).toBe(4096);
    expect(record.acceptedSurfaceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.acceptedSurfaceIntegrity).toBe("sha256-abc");
    expect(readConfigFileSnapshotForWriteMock).toHaveBeenCalledTimes(2);
    expect(configWriteMock).toHaveBeenCalledWith(enabledCfg);
    expect(runtimeLogsContain("Installed plugin: demo")).toBe(true);
    expect(reportClawHubPluginInstallTelemetryMock).toHaveBeenCalledWith({
      baseUrl: "https://clawhub.ai",
      packageName: "demo",
      version: "1.2.3",
    });
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
  });

  it("preserves invocation-wide policy acknowledgement across the ClawHub lifecycle lease", async () => {
    setTty(false);
    primeSuccessfulClawHubPluginInstall();

    await installAccepted("clawhub:demo", "--acknowledge-install-policy-warning");

    const acknowledgement = clawHubInstallCall().onInstallPolicyWarning;
    if (typeof acknowledgement !== "function") {
      throw new Error("expected ClawHub install-policy acknowledgement callback");
    }
    await expect(
      acknowledgement({
        targetName: "demo",
        targetType: "plugin",
        requestMode: "install",
        reason: "Review this plugin",
      }),
    ).resolves.toEqual({ status: "approved" });
    await expect(
      acknowledgement({
        targetName: "demo-dependency",
        targetType: "plugin",
        requestMode: "install",
        reason: "Review this dependency",
      }),
    ).resolves.toEqual({ status: "approved" });
  });

  it("does not report a ClawHub install when durable persistence fails", async () => {
    primeSuccessfulClawHubPluginInstall();
    configWriteMock.mockRejectedValueOnce(new Error("persistence failed"));

    await expect(installAccepted("clawhub:demo")).rejects.toThrow("persistence failed");

    expect(reportClawHubPluginInstallTelemetryMock).not.toHaveBeenCalled();
  });

  it("preserves non-config policy for unconfigured bundled installs", async () => {
    const pluginId = "config-required-plugin";
    const cfg: OpenClawConfig = {
      plugins: {
        entries: { [pluginId]: { hooks: { timeoutMs: 5_000 } } },
        load: { paths: ["/existing/plugin"] },
      },
    };
    pluginCliConfigMock.mockReturnValue(cfg);
    mockConfigRequiredBundle(pluginId);

    await install(pluginId);

    const writtenConfig = configWriteMock.mock.calls[
      configWriteMock.mock.calls.length - 1
    ]?.[0] as OpenClawConfig;
    expect(writtenConfig.plugins?.entries?.[pluginId]).toEqual({
      enabled: false,
      hooks: { timeoutMs: 5_000 },
    });
    expect(writtenConfig.plugins?.load?.paths).toEqual(["/existing/plugin"]);
    const record = persistedInstallRecord(pluginId);
    expect(record.source).toBe("path");
    expect(String(record.sourcePath)).toContain(pluginId);
    expect(String(record.installPath)).toContain(pluginId);
    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    expect(applyExclusiveSlotSelectionMock).not.toHaveBeenCalled();
    expect(runtimeLogsContain("requires configuration first")).toBe(true);
  });

  it("rejects invalid authored config for config-gated bundled installs", async () => {
    const pluginId = "config-required-plugin";
    const cfg: OpenClawConfig = {
      plugins: { entries: { [pluginId]: { config: {}, hooks: { timeoutMs: 5_000 } } } },
    };
    pluginCliConfigMock.mockReturnValue(cfg);
    mockConfigRequiredBundle(pluginId);

    await expect(install(pluginId)).rejects.toThrow("has invalid configured settings");

    expect(configWriteMock).not.toHaveBeenCalled();
    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
  });

  it("selects the beta artifact for an official npm alias and preserves the operator selector", async () => {
    const { enabledCfg } = primeSuccessfulPluginPersistence("brave");
    pluginCliConfigMock.mockReturnValue({
      ...createEmptyPluginConfig(),
      update: { channel: "beta" },
    });
    findBundledPluginSourceMock.mockReturnValue(undefined);
    mockNpmChannelMetadata("@openclaw/brave-plugin", "2026.8.2-beta.1", "2026.8.1");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("brave"));
    await installAccepted("brave");
    expect(npmInstallCall().spec).toBe("@openclaw/brave-plugin@2026.8.2-beta.1");
    expect(npmInstallCall().expectedPluginId).toBe("brave");
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(npmInstallCall().expectedIntegrity).toBeUndefined();
    expect(runtimeLogsContain("outside ClawHub review")).toBe(false);
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(persistedInstallRecord("brave")).toMatchObject({
      source: "npm",
      spec: "@openclaw/brave-plugin",
      installPath: cliInstallPath("brave"),
      version: "1.2.3",
    });
    expect(configWriteMock).toHaveBeenCalledWith(enabledCfg);
    expect(resolveNpmSpecMetadataMock).toHaveBeenCalledTimes(2);
  });

  it("does not change source or retry latest when the selected explicit npm beta is unavailable", async () => {
    primeSuccessfulPluginPersistence("brave");
    pluginCliConfigMock.mockReturnValue({
      ...createEmptyPluginConfig(),
      update: { channel: "beta" },
    } as OpenClawConfig);
    findBundledPluginSourceMock.mockReturnValue(undefined);
    mockNpmChannelMetadata("@openclaw/brave-plugin", "2026.8.2-beta.1", "2026.8.1");
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error:
        "npm error code ETARGET No matching version found for @openclaw/brave-plugin@2026.8.2-beta.1",
      code: "npm_package_not_found",
    });

    await expect(install("npm:@openclaw/brave-plugin")).rejects.toThrow("__exit__:1");

    expect(npmInstallCall(0).spec).toBe("@openclaw/brave-plugin@2026.8.2-beta.1");
    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "No @openclaw/brave-plugin@2026.8.2-beta.1 release is published for this gateway",
    );
  });

  it("uses the declared beta ClawHub secondary only when npm is absent", async () => {
    primeSuccessfulPluginPersistence("brave");
    pluginCliConfigMock.mockReturnValue({
      ...createEmptyPluginConfig(),
      update: { channel: "beta" },
    });
    mockNpmChannelMetadata("@openclaw/brave-plugin", "2026.8.2-beta.1", "2026.8.1");
    findBundledPluginSourceMock.mockReturnValue(undefined);
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "npm error E404 package not found",
      code: "npm_package_not_found",
    });
    installPluginFromClawHubMock.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "brave",
        packageName: "@openclaw/brave-plugin",
        version: "2026.8.2-beta.1",
        channel: "beta",
      }),
    );
    await installAccepted("brave");
    expect(npmInstallCall().spec).toBe("@openclaw/brave-plugin@2026.8.2-beta.1");
    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(clawHubInstallCall().spec).toBe("clawhub:@openclaw/brave-plugin@beta");
    expect(
      runtimeLogsContain(
        "@openclaw/brave-plugin unavailable; using clawhub:@openclaw/brave-plugin instead.",
      ),
    ).toBe(true);
    expect(persistedInstallRecord("brave")).toMatchObject({
      source: "clawhub",
      spec: "clawhub:@openclaw/brave-plugin",
      version: "2026.8.2-beta.1",
    });
    expect(installPluginFromClawHubMock).toHaveBeenCalledTimes(1);
    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
  });

  it("does not change source or probe hooks after an official integrity refusal", async () => {
    findBundledPluginSourceMock.mockReturnValue(undefined);
    installPluginFromNpmSpecMock.mockResolvedValue({ ok: false, error: "integrity mismatch" });

    await expect(install("matrix")).rejects.toThrow("__exit__:1");

    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("integrity mismatch");
  });

  it("passes third-party external catalog integrity to hook-pack fallback", async () => {
    pluginCliConfigMock.mockReturnValue(createEmptyPluginConfig());
    findBundledPluginSourceMock.mockReturnValue(undefined);
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.extensions",
      code: "missing_openclaw_extensions",
    });
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error:
        "aborted: npm package integrity drift detected for @wecom/wecom-openclaw-plugin@2026.7.2",
    });

    await expect(install("wecom")).rejects.toThrow("__exit__:1");

    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(hookNpmInstallCall().spec).toBe("@wecom/wecom-openclaw-plugin@2026.7.2");
    expect(hookNpmInstallCall().expectedIntegrity).toBe(
      "sha512-7kqdBIOF3SgDDoBoFtO6jxnxofbYSgbKdxZDNabD0y0jg2xKcVqlXZOOJ9+XQho/QOtIFrnRH2IRnPukFEYwJg==",
    );
  });

  it("stores npm resolution metadata without changing the active plugin install selector", async () => {
    const extensionsDir = useProfileExtensionsDir();
    const { enabledCfg } = primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: cliInstallPath("demo"),
      version: "1.2.3",
      npmResolution: {
        name: "demo",
        version: "1.2.3",
        resolvedSpec: "demo@1.2.3",
        integrity: "sha512-demo",
      },
    });
    await installAcknowledged("npm:demo");

    expect(npmInstallCall()).toMatchObject({ spec: "demo", mode: "update", extensionsDir });
    expect(runtimeLogsContain("Installing plugin from npm registry")).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(configWriteMock).toHaveBeenCalledWith(enabledCfg);
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("npm");
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.version).toBe("1.2.3");
    expect(record.spec).toBe("demo");
    expect(record.resolvedSpec).toBe("demo@1.2.3");
    expect(record.integrity).toBe("sha512-demo");
  });

  it("installs Git sources directly and records the selected revision", async () => {
    primeSuccessfulPluginPersistence("demo");
    const spec = "git:github.com/acme/demo@v1.2.3";
    installPluginFromGitSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: cliInstallPath("demo"),
      extensions: ["index.js"],
      git: {
        url: "https://github.com/acme/demo.git",
        ref: "v1.2.3",
        commit: "abc123",
        resolvedAt: "2026-04-30T00:00:00.000Z",
      },
    });
    await installAcknowledged(spec);
    expect(mockCallArg(installPluginFromGitSpecMock)).toMatchObject({ spec, mode: "update" });
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(persistedInstallRecord("demo")).toMatchObject({
      source: "git",
      spec,
      gitRef: "v1.2.3",
      gitCommit: "abc123",
    });
  });

  it("keeps npm-prefixed official plugin ids on explicit npm semantics", async () => {
    primeSuccessfulPluginPersistence("brave");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("brave"));

    await installAcknowledged("npm:brave");

    expect(npmInstallCall().spec).toBe("brave");
    expect(npmInstallCall().expectedPluginId).toBeUndefined();
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBeUndefined();
    expect(runtimeLogsContain("Installing plugin from npm registry")).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
  });

  it("uses bundled OpenClaw package specs instead of pinning stale managed npm overrides", async () => {
    primeSuccessfulPluginPersistence("discord");
    const bundledPath = "/app/dist/extensions/discord";
    findBundledPluginSourceMock.mockImplementation((params: unknown) => {
      const { lookup } = params as {
        lookup: { kind: "pluginId" | "npmSpec"; value: string };
      };
      return (lookup.kind === "npmSpec" && lookup.value === "@openclaw/discord") ||
        (lookup.kind === "pluginId" && lookup.value === "discord")
        ? {
            pluginId: "discord",
            localPath: bundledPath,
            npmSpec: "@openclaw/discord",
            version: "2026.5.24-beta.2",
          }
        : undefined;
    });
    await install("@openclaw/discord@2026.5.20", "--pin", "--force");

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(findBundledPluginSourceMock).toHaveBeenCalledWith({
      lookup: { kind: "npmSpec", value: "@openclaw/discord@2026.5.20" },
    });
    expect(findBundledPluginSourceMock).toHaveBeenCalledWith({
      lookup: { kind: "npmSpec", value: "@openclaw/discord" },
    });
    const record = persistedInstallRecord("discord");
    expect(record.source).toBe("path");
    expect(record.spec).toBe("@openclaw/discord@2026.5.20");
    expect(record.sourcePath).toBe(bundledPath);
    expect(record.installPath).toBe(bundledPath);
    expect(runtimeLogsContain("ships with the current OpenClaw build")).toBe(true);
    expect(runtimeLogsContain("npm:@openclaw/discord@2026.5.20")).toBe(true);
  });

  it("requires matching policy acknowledgement despite the deprecated unsafe flag", async () => {
    setTty(true);
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));
    await installAcknowledged("npm:demo", "--dangerously-force-unsafe-install");
    expect(
      pluginsCliRuntimeLogs.filter((message) =>
        message.includes(
          "--dangerously-force-unsafe-install is deprecated and no longer affects plugin installs",
        ),
      ),
    ).toHaveLength(1);
    const acknowledge = npmInstallCall().onInstallPolicyWarning;
    const request = {
      targetType: "plugin" as const,
      requestMode: "install" as const,
      reason: "Review this plugin",
    };
    await expect(acknowledge?.({ ...request, targetName: "another-plugin" })).resolves.toEqual({
      status: "declined",
    });
    await expect(acknowledge?.({ ...request, targetName: "demo" })).resolves.toEqual({
      status: "approved",
    });
  });

  it("adds a Git PATH hint when npm plugin dependency install cannot spawn git", async () => {
    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: [
        "npm install failed:",
        "npm error code ENOENT",
        "npm error syscall spawn git",
        "npm error path git",
      ].join("\n"),
    });
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
      code: "missing_openclaw_hooks",
    });

    await expect(installAcknowledged("npm:@openclaw/whatsapp")).rejects.toThrow("__exit__:1");

    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "one of this plugin's npm dependencies is fetched from a git URL",
    );
    expect(runtimeErrors.at(-1)).toContain("winget install --id Git.Git -e");
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("preserves linked hook-pack fallback with the deprecated unsafe flag", async () => {
    const tmpRoot = createTempDirectory("openclaw-hook-link-");
    installPluginFromPathMock.mockResolvedValueOnce({
      ok: false,
      error: "plugin install probe failed",
    });
    installHooksFromPathMock.mockResolvedValueOnce(createHookPackInstallResult(tmpRoot));

    await installAcknowledged(tmpRoot, "--link", "--dangerously-force-unsafe-install");

    expect(hookPathInstallCall().path).toBe(tmpRoot);
    expect(hookPathInstallCall().dryRun).toBe(true);
  });

  it.each([
    ["profile", "work", undefined, "openclaw --profile work"],
    ["container before profile", "work", "demo", "openclaw --container demo"],
  ] as const)(
    "preserves %s context in duplicate-install recovery guidance",
    async (_name, profile, container, prefix) => {
      await withEnvAsync(
        { OPENCLAW_PROFILE: profile, OPENCLAW_CONTAINER_HINT: container },
        async () => {
          pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
          installPluginFromNpmSpecMock.mockResolvedValue({
            ok: false,
            error:
              "plugin already exists: /home/openclaw/.openclaw/extensions/lossless-claw (delete it first)",
          });
          installHooksFromNpmSpecMock.mockResolvedValue({
            ok: false,
            error: "package.json missing openclaw.hooks",
          });

          await expect(installAcknowledged("@example/lossless-claw")).rejects.toThrow("__exit__:1");

          expect(runtimeErrors.at(-1)).toContain(
            `Use \`${prefix} plugins update <id-or-npm-spec>\` to upgrade the tracked plugin, or rerun install with \`--force\` to replace it.`,
          );
          expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
          expect(configWriteMock).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("does not append hook-pack fallback details for managed extensions boundary failures", async () => {
    const localPluginDir = createTempDirectory("openclaw-local-plugin-");

    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    installPluginFromPathMock.mockResolvedValue({
      ok: false,
      error: "Invalid path: must stay within extensions directory",
    });
    installHooksFromPathMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    await expect(installAcknowledged(localPluginDir)).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toBe("Invalid path: must stay within extensions directory");
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("passes the install logger to the --link dry-run probe", async () => {
    const extensionsDir = useProfileExtensionsDir();
    const localPluginDir = createTempDirectory("openclaw-link-plugin-");
    createColdPluginFixture({ rootDir: localPluginDir, pluginId: "demo" });
    primeSuccessfulPluginPersistence("demo");
    pluginCliConfigMock.mockReturnValue({ plugins: { entries: {}, load: { paths: [] } } });
    installPluginFromPathMock.mockImplementation(async (...args: unknown[]) => {
      const [params] = args as [
        {
          logger?: { warn?: (message: string) => void };
          path: string;
          dryRun?: boolean;
        },
      ];
      params.logger?.warn?.("WARNING: installer warning from dry-run probe");
      return {
        ok: true,
        pluginId: "demo",
        targetDir: localPluginDir,
        version: "1.0.0",
        extensions: ["./index.cjs"],
      };
    });
    await installAcknowledged(localPluginDir, "--link", "--dangerously-force-unsafe-install");

    expect(pathInstallCall().path).toBe(localPluginDir);
    expect(pathInstallCall().extensionsDir).toBe(extensionsDir);
    expect(pathInstallCall().mode).toBe("install");
    expect(pathInstallCall().dryRun).toBe(true);
    expect(pathInstallCall().allowSourceTypeScriptEntries).toBe(true);
    expect(typeof pathInstallCall().logger?.info).toBe("function");
    expect(typeof pathInstallCall().logger?.warn).toBe("function");
    expect(runtimeLogsContain("installer warning from dry-run probe")).toBe(true);
  });

  it("does not fall back to hooks when a local security scan fails", async () => {
    const localPluginDir = createTempDirectory("openclaw-local-plugin-");
    installPluginFromPathMock.mockResolvedValue({
      ok: false,
      error: "plugin security scan failed",
      code: "security_scan_failed",
    });
    await expect(installAcknowledged(localPluginDir)).rejects.toThrow("__exit__:1");
    expect(installHooksFromPathMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("plugin security scan failed");
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("does not bypass an npm security block with the deprecated unsafe flag", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "plugin blocked by security scan",
      code: "security_scan_blocked",
    });
    await expect(installAcknowledged("demo", "--dangerously-force-unsafe-install")).rejects.toThrow(
      "__exit__:1",
    );
    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("plugin blocked by security scan");
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it.each([
    { source: "npm", raw: "npm:demo", enabled: true },
    { source: "bundled fallback", raw: "demo-package", enabled: false },
  ])(
    "preserves plugin policy when installing from $source with --no-enable and enabled=$enabled",
    async ({ source, raw, enabled }) => {
      const pluginId = "demo";
      const targetDir = installedPluginRoot(resolveStateDir(), pluginId);
      const config = {
        plugins: {
          allow: ["other"],
          deny: [pluginId],
          entries: { [pluginId]: { enabled } },
        },
      };
      pluginCliConfigMock.mockReturnValue(config);
      findBundledPluginSourceMock.mockImplementation((input) => {
        const { lookup } = input as Parameters<
          typeof import("../plugins/bundled-sources.js").findBundledPluginSource
        >[0];
        return source === "bundled fallback" &&
          (lookup.kind === "npmSpec" || lookup.value === pluginId)
          ? { pluginId, localPath: targetDir }
          : undefined;
      });
      installPluginFromNpmSpecMock.mockResolvedValue(
        source === "bundled fallback"
          ? { ok: false, error: "npm error E404 package not found", code: "npm_package_not_found" }
          : { ok: true, pluginId, targetDir, version: "1.2.3" },
      );

      await install(raw, "--no-enable", "--force", "--accept-capabilities");

      expect(configWriteMock).toHaveBeenLastCalledWith(config);
      expect(
        writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mock.calls[0]?.[0],
      ).toMatchObject({ [pluginId]: { source: source === "npm" ? "npm" : "path" } });
      expect(enablePluginInConfigMock).not.toHaveBeenCalled();
      expect(applyExclusiveSlotSelectionMock).not.toHaveBeenCalled();
    },
  );

  it("rejects --no-enable for hook-only fallback before installing hooks", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.plugin.json",
    });
    await expect(
      install("npm:@acme/demo-hooks", "--no-enable", "--force", "--accept-capabilities"),
    ).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.at(-1)).toContain("--no-enable is only supported for plugins");
    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
