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
  installHooksFromNpmSpecMock as installNpmHooks,
  installHooksFromPathMock as installPathHooks,
  installPluginFromGitSpecMock,
  installPluginFromClawHubMock as installClawHub,
  installPluginFromMarketplaceMock,
  installPluginFromNpmSpecMock as installNpm,
  installPluginFromPathMock as installPath,
  pluginCliConfigMock as configMock,
  readConfigFileSnapshotMock,
  readConfigFileSnapshotForWriteMock as readWriteSnapshot,
  promptYesNoMock,
  reportClawHubPluginInstallTelemetryMock,
  recordHookInstallMock,
  recordPluginInstallMock,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs as logs,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock as writeInstallRecords,
} from "./plugins-cli-test-helpers.js";
import { runPluginInstallCommand } from "./plugins-install-command.js";
import { createCliTtyMock } from "./test-runtime-capture.js";

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

function createEmptyPluginConfig(): OpenClawConfig {
  return { plugins: { entries: {} } };
}

function createClawHubInstallResult({
  pluginId = "demo",
  packageName = pluginId,
  version = "1.2.3",
  channel = "community",
}: {
  pluginId?: string;
  packageName?: string;
  version?: string;
  channel?: string;
} = {}): Awaited<ReturnType<typeof installClawHub>> {
  return {
    ok: true,
    pluginId,
    targetDir: cliInstallPath(pluginId),
    version,
    packageName,
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: packageName,
      clawhubFamily: "code-plugin",
      clawhubChannel: channel,
    },
  };
}

function primeSuccessfulPluginPersistence(pluginId = "demo") {
  const cfg = createEmptyPluginConfig();
  const enabledCfg: OpenClawConfig = { plugins: { entries: { [pluginId]: { enabled: true } } } };

  configMock.mockReturnValue(cfg);
  enablePluginInConfigMock.mockReturnValue({ config: enabledCfg });
  recordPluginInstallMock.mockReturnValue(enabledCfg);
  applyExclusiveSlotSelectionMock.mockReturnValue(enabledCfg);
}

function mockInstallFailure(
  mock: Pick<typeof installNpm, "mockResolvedValue" | "mockResolvedValueOnce">,
  error: string,
  code?: string,
  once = false,
) {
  const result = { ok: false, error, ...(code ? { code } : {}) };
  mock[once ? "mockResolvedValueOnce" : "mockResolvedValue"](result);
}

function primeNpmInstall(pluginId = "demo") {
  primeSuccessfulPluginPersistence(pluginId);
  installNpm.mockResolvedValue({
    ok: true,
    pluginId,
    targetDir: cliInstallPath(pluginId),
    version: "1.2.3",
  });
}

function primeSuccessfulClawHubPluginInstall() {
  primeSuccessfulPluginPersistence("demo");
  installClawHub.mockResolvedValue(createClawHubInstallResult());
}

function createEnabledHookConfig(): OpenClawConfig {
  return {
    hooks: { internal: { enabled: true, entries: { "command-audit": { enabled: true } } } },
  };
}

function createHookPackInstallResult(targetDir: string) {
  return {
    ok: true,
    hookPackId: "demo-hooks",
    hooks: ["command-audit"],
    packageKind: "hook-only" as const,
    targetDir,
    version: "1.2.3",
  };
}

function mockCallArg(
  mock: { mock: { calls: readonly (readonly unknown[])[] } },
  callIndex = 0,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[0];
}

function policyAcknowledgement(mock: typeof installNpm) {
  return (mockCallArg(mock) as Pick<InstallSafetyOverrides, "onInstallPolicyWarning">)
    .onInstallPolicyWarning;
}

function persistedInstallRecord(pluginId: string, callIndex = 0) {
  const record = writeInstallRecords.mock.calls[callIndex]?.[0][pluginId];
  if (!record) {
    throw new Error(`Expected persisted install record for ${pluginId}`);
  }
  return record;
}

function runtimeLogsContain(fragment: string): boolean {
  return logs.some((line) => line.includes(fragment));
}

function install(raw: string, ...flags: string[]) {
  return runPluginsCommand(["plugins", "install", raw, ...flags]);
}

function installAcknowledged(raw: string, ...flags: string[]) {
  return install(raw, ...flags, "--force", "--accept-capabilities");
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
  configMock.mockReturnValue(config);
  readWriteSnapshot.mockResolvedValue({
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

function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

async function expectBlockedInstall(
  raw: string,
  section: "plugins" | "hooks",
  untouched: unknown[],
  ...flags: string[]
) {
  await expect(installAcknowledged(raw, ...flags)).rejects.toThrow("__exit__:1");
  expectNoCalls(...untouched, configWriteMock);
  expect(runtimeErrors.at(-1)).toContain(
    `Config ${section} are stored in an external or unresolved top-level $include`,
  );
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

    expectNoCalls(installNpm, installPath, installPluginFromMarketplaceMock, configWriteMock);
  });

  it("rejects a cancelled install before installer or persistence side effects", async () => {
    primeNpmInstall("demo");
    const readSnapshot = readWriteSnapshot.getMockImplementation();
    if (!readSnapshot) {
      throw new Error("missing config snapshot fixture");
    }
    let active = true;
    readWriteSnapshot.mockImplementation(async (...args) => {
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
    expectNoCalls(
      installNpm,
      installClawHub,
      installNpmHooks,
      configWriteMock,
      recordHookInstallMock,
    );
    expect(await loadInstalledPluginIndexInstallRecords()).toEqual({});
    expect(runtimeLogsContain("Installed")).toBe(false);
  });

  it.each([
    ["plugin-capable", "@acme/dual-package"],
    ["probe throws", "@acme/demo-plugin"],
  ])("fails closed for a blocked npm plugin when the hook probe reports %s", async (kind, spec) => {
    blockConfigMutation("plugins");
    installNpmHooks.mockImplementation(async () => {
      if (kind === "probe throws") {
        throw new Error("hook validation exploded");
      }
      return {
        ...createHookPackInstallResult("/tmp/hooks/demo-hooks"),
        packageKind: "plugin-capable",
      };
    });
    await expectBlockedInstall(`npm:${spec}`, "plugins", [installNpm]);
    expect(installNpmHooks).toHaveBeenCalledTimes(1);
    expect(mockCallArg(installNpmHooks)).toMatchObject({ inspection: "package-kind" });
  });

  it("installs a positively identified npm hook pack without probing plugin installation", async () => {
    const installedCfg = createEnabledHookConfig();
    blockConfigMutation("plugins");
    installNpmHooks.mockResolvedValue({
      ...createHookPackInstallResult("/tmp/hooks/demo-hooks"),
      npmResolution: {
        name: "@acme/demo-hooks",
        version: "1.2.3",
        resolvedSpec: "@acme/demo-hooks@1.2.3",
        integrity: "sha256-demo",
      },
    });
    await installAcknowledged("npm:@acme/demo-hooks");

    expect(installNpm).not.toHaveBeenCalled();
    expect(installNpmHooks).toHaveBeenCalledTimes(2);
    expect(mockCallArg(installNpmHooks)).toMatchObject({ inspection: "package-kind" });
    expect(mockCallArg(installNpmHooks, 1)).toMatchObject({
      expectedIntegrity: "sha256-demo",
      expectedPackageKind: "hook-only",
      mode: "update",
    });
    expect(mockCallArg(recordHookInstallMock)).toMatchObject({
      hookId: "demo-hooks",
      spec: "@acme/demo-hooks",
      resolvedVersion: "1.2.3",
      resolvedSpec: "@acme/demo-hooks@1.2.3",
      integrity: "sha256-demo",
      hooks: ["command-audit"],
    });
    expect(runtimeLogsContain("Installed hook pack: demo-hooks")).toBe(true);
    expect(configWriteMock).toHaveBeenCalledWith(installedCfg);
  });

  it("blocks a proven local hook pack before plugin installer side effects when only hooks config is include-owned", async () => {
    const localPath = createTempDirectory("openclaw-hook-pack-");
    blockConfigMutation("hooks");
    installPathHooks.mockResolvedValue(createHookPackInstallResult(localPath));

    await expectBlockedInstall(localPath, "hooks", [installPath]);
    expect(installPathHooks).toHaveBeenCalledTimes(1);
    expect(mockCallArg(installPathHooks)).toMatchObject({ inspection: "package-kind" });
  });

  it.skipIf(process.platform === "win32")(
    "preserves local hook-pack precedence for prefix-shaped paths",
    async () => {
      const localPath = path.join(process.cwd(), `clawhub:demo-hooks-${process.pid}`);
      const installedCfg = createEnabledHookConfig();
      fs.mkdirSync(localPath);
      blockConfigMutation("plugins");

      installPathHooks.mockResolvedValue(createHookPackInstallResult(localPath));

      try {
        await installAcknowledged(path.basename(localPath));
      } finally {
        fs.rmSync(localPath, { recursive: true, force: true });
      }

      expect(installPath).not.toHaveBeenCalled();
      expect(installPathHooks).toHaveBeenCalledTimes(2);
      expect(mockCallArg(installPathHooks)).toMatchObject({ inspection: "package-kind" });
      expect(mockCallArg(installPathHooks, 1)).toMatchObject({ expectedPackageKind: "hook-only" });
      expect(installClawHub).not.toHaveBeenCalled();
      expect(configWriteMock).toHaveBeenCalledWith(installedCfg);
    },
  );

  it.each([
    ["npm", "npm:@acme/demo-hooks", ["plugins", "hooks"], [installNpmHooks, installNpm], []],
    [
      "marketplace",
      "demo",
      ["plugins"],
      [installPluginFromMarketplaceMock],
      ["--marketplace", "local/repo"],
    ],
  ] as const)(
    "blocks %s before side effects when config is include-owned",
    async (_source, raw, sections, untouched, flags) => {
      blockConfigMutation(...sections);
      await expectBlockedInstall(raw, sections.at(-1)!, [...untouched], ...flags);
    },
  );

  it("inspects the npm hook fallback when an official plugin's config is include-owned", async () => {
    blockConfigMutation("plugins");
    findBundledPluginSourceMock.mockReturnValue(undefined);
    await expect(install("brave")).rejects.toThrow("__exit__:1");
    expect(mockCallArg(installNpmHooks)).toMatchObject({
      spec: "@openclaw/brave-plugin",
      inspection: "package-kind",
    });
    expectNoCalls(installNpm, configWriteMock);
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("fails closed for unrelated invalid config before installer side effects", async () => {
    const invalidConfigErr = Object.assign(new Error("config invalid"), { code: "INVALID_CONFIG" });
    configMock.mockImplementation(() => {
      throw invalidConfigErr;
    });
    const invalidConfig = { models: { default: 123 } };
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw-config.json5",
      exists: true,
      raw: JSON.stringify(invalidConfig),
      parsed: invalidConfig,
      resolved: invalidConfig,
      config: invalidConfig,
      valid: false,
      hash: "mock",
      issues: [{ path: "models.default", message: "invalid model ref" }],
      warnings: [],
      legacyIssues: [],
    });

    await expect(installAcknowledged("alpha")).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
    expectNoCalls(installPluginFromMarketplaceMock, installNpm, configWriteMock);
  });

  it("requires acknowledgement for noninteractive non-ClawHub plugin installs", async () => {
    setTty(false);
    primeNpmInstall("demo");

    await expect(install("npm:demo")).rejects.toThrow("__exit__:1");

    expect(installNpm).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("outside ClawHub review");
    expect(runtimeErrors.at(-1)).toContain("--force");
  });

  it.each([false, true])("honors interactive non-ClawHub install consent: %s", async (accept) => {
    setTty(true);
    promptYesNoMock.mockResolvedValueOnce(accept);
    primeNpmInstall("demo");
    if (accept) {
      await install("npm:demo");
      expect(installNpm).toHaveBeenCalledTimes(1);
      expect(persistedInstallRecord("demo").source).toBe("npm");
    } else {
      await expect(install("npm:demo")).rejects.toThrow("__exit__:1");
      expect(installNpm).not.toHaveBeenCalled();
    }
    expect(promptYesNoMock).toHaveBeenCalledWith("Install this non-ClawHub plugin source?");
    expect(runtimeLogsContain("Installing plugin from npm registry")).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
  });

  it("rejects unacknowledged noninteractive ClawHub installs before persistence", async () => {
    setTty(false);
    primeSuccessfulClawHubPluginInstall();

    await expect(install("clawhub:demo")).rejects.toThrow("--accept-capabilities");

    expectNoCalls(configWriteMock, writeInstallRecords, reportClawHubPluginInstallTelemetryMock);
  });

  it.each([
    ["demo", "demo", undefined],
    ["dashscope", "dashscope", undefined],
    ["demo@1.2.3", "demo", "1.2.3"],
    ["plugin.js", "plugin.js", undefined],
    ["@acme/plugin.js", "@acme/plugin.js", undefined],
    ["owner/plugin.js", "owner/plugin.js", undefined],
    ["@composio/composio", "@composio/composio", undefined],
    ["@openclaw/diffs", "@openclaw/diffs", undefined],
    ["brave@latest", "brave", "latest"],
    ["@composio/composio@beta", "@composio/composio", "beta"],
    ["community/demo@1.2.3", "community/demo", "1.2.3"],
  ])("installs %s from ClawHub by default and records its source", async (raw, name, version) => {
    setTty(false);
    const pluginId = name === "@openclaw/diffs" ? "diffs" : "demo";
    primeSuccessfulPluginPersistence(pluginId);
    installClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId,
        packageName: name,
        version: "1.2.3",
        channel: "community",
      }),
    );

    await installAccepted(raw);

    if (name === "@openclaw/diffs") {
      // Official packages retain their core-compatible release selector within ClawHub.
      expect(mockCallArg(installClawHub)).toMatchObject({
        spec: expect.stringMatching(/^clawhub:@openclaw\/diffs@\d/),
      });
    } else {
      expect(mockCallArg(installClawHub)).toMatchObject({
        spec: `clawhub:${name}${version ? `@${version}` : ""}`,
      });
    }
    expect(persistedInstallRecord(pluginId)).toMatchObject({
      source: "clawhub",
      clawhubPackage: name,
      spec: `clawhub:${raw}`,
    });
    expect(installNpm).not.toHaveBeenCalled();
    expect(installNpmHooks).not.toHaveBeenCalled();
    expect(promptYesNoMock).not.toHaveBeenCalled();
  });

  it("does not fall back to npm when an unprefixed package is absent from ClawHub", async () => {
    installClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub package not found: demo",
      code: "package_not_found",
    });

    await expect(installAccepted("demo")).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("ClawHub package not found: demo");
    expect(installNpm).not.toHaveBeenCalled();
    expect(installNpmHooks).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("preserves invocation-wide policy acknowledgement across the ClawHub lifecycle lease", async () => {
    setTty(false);
    primeSuccessfulClawHubPluginInstall();

    await installAccepted("clawhub:demo", "--acknowledge-install-policy-warning");

    const acknowledgement = policyAcknowledgement(installClawHub);
    if (typeof acknowledgement !== "function") {
      throw new Error("expected ClawHub install-policy acknowledgement callback");
    }
    for (const targetName of ["demo", "demo-dependency"]) {
      await expect(
        acknowledgement({
          targetName,
          targetType: "plugin",
          requestMode: "install",
          reason: targetName === "demo" ? "Review this plugin" : "Review this dependency",
        }),
      ).resolves.toEqual({ status: "approved" });
    }
  });

  it("does not report a ClawHub install when durable persistence fails", async () => {
    primeSuccessfulClawHubPluginInstall();
    configWriteMock.mockRejectedValueOnce(new Error("persistence failed"));

    await expect(installAccepted("clawhub:demo")).rejects.toThrow("persistence failed");

    expect(reportClawHubPluginInstallTelemetryMock).not.toHaveBeenCalled();
  });

  it("does not change source or retry latest when the selected explicit npm beta is unavailable", async () => {
    primeSuccessfulPluginPersistence("brave");
    configMock.mockReturnValue({
      ...createEmptyPluginConfig(),
      update: { channel: "beta" },
    } as OpenClawConfig);
    findBundledPluginSourceMock.mockReturnValue(undefined);
    mockNpmChannelMetadata("@openclaw/brave-plugin", "2026.8.2-beta.1", "2026.8.1");
    mockInstallFailure(
      installNpm,
      "npm error code ETARGET No matching version found for @openclaw/brave-plugin@2026.8.2-beta.1",
      "npm_package_not_found",
    );

    await expect(install("npm:@openclaw/brave-plugin")).rejects.toThrow("__exit__:1");

    expect(mockCallArg(installNpm)).toMatchObject({
      spec: "@openclaw/brave-plugin@2026.8.2-beta.1",
    });
    expect(installNpm).toHaveBeenCalledTimes(1);
    expectNoCalls(installClawHub, installNpmHooks, configWriteMock);
    expect(runtimeErrors.at(-1)).toContain(
      "No @openclaw/brave-plugin@2026.8.2-beta.1 release is published for this gateway",
    );
  });

  it("does not change source or probe hooks after an official integrity refusal", async () => {
    findBundledPluginSourceMock.mockReturnValue(undefined);
    mockInstallFailure(installNpm, "integrity mismatch");

    await expect(install("matrix")).rejects.toThrow("__exit__:1");

    expectNoCalls(installClawHub, installNpmHooks, configWriteMock);
    expect(runtimeErrors.at(-1)).toContain("integrity mismatch");
  });

  it("passes third-party external catalog integrity to hook-pack fallback", async () => {
    configMock.mockReturnValue(createEmptyPluginConfig());
    findBundledPluginSourceMock.mockReturnValue(undefined);
    mockInstallFailure(
      installNpm,
      "package.json missing openclaw.extensions",
      "missing_openclaw_extensions",
    );
    mockInstallFailure(
      installNpmHooks,
      "aborted: npm package integrity drift detected for @wecom/wecom-openclaw-plugin@2026.7.2",
    );

    await expect(install("wecom-openclaw-plugin")).rejects.toThrow("__exit__:1");

    expect(mockCallArg(installNpm)).toMatchObject({ trustedSourceLinkedOfficialInstall: true });
    expect(mockCallArg(installNpmHooks)).toMatchObject({
      spec: "@wecom/wecom-openclaw-plugin@2026.7.2",
      expectedIntegrity:
        "sha512-7kqdBIOF3SgDDoBoFtO6jxnxofbYSgbKdxZDNabD0y0jg2xKcVqlXZOOJ9+XQho/QOtIFrnRH2IRnPukFEYwJg==",
    });
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
    expectNoCalls(installNpm, installClawHub);
    expect(persistedInstallRecord("demo")).toMatchObject({
      source: "git",
      spec,
      gitRef: "v1.2.3",
      gitCommit: "abc123",
    });
  });

  it("keeps npm-prefixed official plugin ids on explicit npm semantics", async () => {
    primeNpmInstall("brave");

    await installAcknowledged("npm:brave");

    const call = mockCallArg(installNpm) as Parameters<
      typeof import("../plugins/install.js").installPluginFromNpmSpec
    >[0];
    expect(call.spec).toBe("brave");
    expect(call.expectedPluginId).toBeUndefined();
    expect(call.trustedSourceLinkedOfficialInstall).toBeUndefined();
    expect(runtimeLogsContain("Installing plugin from npm registry")).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    expect(installClawHub).not.toHaveBeenCalled();
  });

  it("installs scoped package specs from ClawHub even when a bundled copy exists", async () => {
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
    installClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "discord",
        packageName: "@openclaw/discord",
        version: "2026.5.20",
        channel: "official",
      }),
    );
    await installAccepted("@openclaw/discord@2026.5.20");

    expect(mockCallArg(installClawHub)).toMatchObject({
      spec: "clawhub:@openclaw/discord@2026.5.20",
    });
    expect(installNpm).not.toHaveBeenCalled();
    expect(persistedInstallRecord("discord")).toMatchObject({
      source: "clawhub",
      clawhubPackage: "@openclaw/discord",
      spec: "clawhub:@openclaw/discord@2026.5.20",
    });
  });

  it("requires matching policy acknowledgement despite the deprecated unsafe flag", async () => {
    setTty(true);
    primeNpmInstall("demo");
    await installAcknowledged("npm:demo", "--dangerously-force-unsafe-install");
    expect(
      logs.filter((message) =>
        message.includes(
          "--dangerously-force-unsafe-install is deprecated and no longer affects plugin installs",
        ),
      ),
    ).toHaveLength(1);
    const acknowledge = policyAcknowledgement(installNpm);
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
    configMock.mockReturnValue({} as OpenClawConfig);
    installNpm.mockResolvedValue({
      ok: false,
      error: [
        "npm install failed:",
        "npm error code ENOENT",
        "npm error syscall spawn git",
        "npm error path git",
      ].join("\n"),
    });
    mockInstallFailure(
      installNpmHooks,
      "package.json missing openclaw.hooks",
      "missing_openclaw_hooks",
    );

    await expect(installAcknowledged("npm:@openclaw/whatsapp")).rejects.toThrow("__exit__:1");

    expect(installClawHub).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "one of this plugin's npm dependencies is fetched from a git URL",
    );
    expect(runtimeErrors.at(-1)).toContain("winget install --id Git.Git -e");
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("preserves linked hook-pack fallback with the deprecated unsafe flag", async () => {
    const tmpRoot = createTempDirectory("openclaw-hook-link-");
    mockInstallFailure(installPath, "plugin install probe failed", undefined, true);
    installPathHooks.mockResolvedValueOnce(createHookPackInstallResult(tmpRoot));

    await installAcknowledged(tmpRoot, "--link", "--dangerously-force-unsafe-install");

    expect(mockCallArg(installPathHooks)).toMatchObject({ path: tmpRoot, dryRun: true });
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
          configMock.mockReturnValue({} as OpenClawConfig);
          mockInstallFailure(
            installNpm,
            "plugin already exists: /home/openclaw/.openclaw/extensions/lossless-claw (delete it first)",
          );
          mockInstallFailure(installNpmHooks, "package.json missing openclaw.hooks");

          await expect(installAcknowledged("npm:@example/lossless-claw")).rejects.toThrow(
            "__exit__:1",
          );

          expect(runtimeErrors.at(-1)).toContain(
            `Use \`${prefix} plugins update <id-or-npm-spec>\` to upgrade the tracked plugin, or rerun install with \`--force\` to replace it.`,
          );
          expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
          expect(configWriteMock).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("passes the install logger to the --link dry-run probe", async () => {
    const extensionsDir = useProfileExtensionsDir();
    const localPluginDir = createTempDirectory("openclaw-link-plugin-");
    createColdPluginFixture({ rootDir: localPluginDir, pluginId: "demo" });
    primeSuccessfulPluginPersistence("demo");
    configMock.mockReturnValue({ plugins: { entries: {}, load: { paths: [] } } });
    installPath.mockImplementation(async (input: unknown) => {
      const params = input as Parameters<
        typeof import("../plugins/install.js").installPluginFromPath
      >[0];
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

    expect(mockCallArg(installPath)).toMatchObject({
      path: localPluginDir,
      extensionsDir,
      mode: "install",
      dryRun: true,
      allowSourceTypeScriptEntries: true,
      logger: { info: expect.any(Function), warn: expect.any(Function) },
    });
    expect(runtimeLogsContain("installer warning from dry-run probe")).toBe(true);
  });

  it.each([
    ["local", installPath, installPathHooks, "plugin security scan failed", "security_scan_failed"],
    [
      "npm",
      installNpm,
      installNpmHooks,
      "plugin blocked by security scan",
      "security_scan_blocked",
    ],
  ] as const)(
    "does not bypass a %s security refusal or fall back to hooks",
    async (source, installer, hooks, error, code) => {
      mockInstallFailure(installer, error, code);
      const raw = source === "local" ? createTempDirectory("openclaw-local-plugin-") : "npm:demo";
      const flags = source === "npm" ? ["--dangerously-force-unsafe-install"] : [];
      await expect(installAcknowledged(raw, ...flags)).rejects.toThrow("__exit__:1");
      expect(hooks).not.toHaveBeenCalled();
      expect(runtimeErrors.at(-1)).toContain(error);
      expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
    },
  );

  it("preserves plugin policy when installing a bundled plugin with --no-enable", async () => {
    const pluginId = "demo";
    const targetDir = installedPluginRoot(resolveStateDir(), pluginId);
    const config = {
      plugins: {
        allow: ["other"],
        deny: [pluginId],
        entries: { [pluginId]: { enabled: false } },
      },
    };
    configMock.mockReturnValue(config);
    findBundledPluginSourceMock.mockImplementation((input) => {
      const { lookup } = input as Parameters<
        typeof import("../plugins/bundled-sources.js").findBundledPluginSource
      >[0];
      return lookup.kind === "npmSpec" || lookup.value === pluginId
        ? { pluginId, localPath: targetDir }
        : undefined;
    });

    await install("demo", "--no-enable", "--force", "--accept-capabilities");

    expect(configWriteMock).toHaveBeenLastCalledWith(config);
    expect(writeInstallRecords.mock.calls[0]?.[0]).toMatchObject({
      [pluginId]: { source: "path" },
    });
    expectNoCalls(enablePluginInConfigMock, applyExclusiveSlotSelectionMock);
  });

  it("rejects --no-enable for hook-only fallback before installing hooks", async () => {
    mockInstallFailure(installNpm, "package.json missing openclaw.plugin.json");
    await expect(
      install("npm:@acme/demo-hooks", "--no-enable", "--force", "--accept-capabilities"),
    ).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.at(-1)).toContain("--no-enable is only supported for plugins");
    expectNoCalls(installNpmHooks, configWriteMock);
  });
});
