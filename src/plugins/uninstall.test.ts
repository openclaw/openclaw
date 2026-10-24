// Covers plugin uninstall flows and install-record cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { runCommandWithTimeout } from "../process/exec.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { toRepoRelativePath } from "../test-utils/repo-files.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmGenerationProjectDirPrefix,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { resolvePluginInstallDir } from "./install.js";
import {
  cleanupTrackedTempDirsAsync,
  makeTrackedTempDirAsync,
} from "./test-helpers/fs-fixtures.js";
import { removePluginFromConfig } from "./uninstall-config.js";
import { pruneManagedNpmPeerDependenciesAfterUninstall } from "./uninstall-managed-npm.js";
import { recordPluginPackageUninstallPlan } from "./uninstall-package-plan.js";
import {
  applyPluginUninstallDirectoryRemoval,
  planPluginUninstall,
  resolveUninstallChannelConfigKeys,
} from "./uninstall.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

type PluginConfig = NonNullable<OpenClawConfig["plugins"]>;
type PluginInstallRecord = NonNullable<PluginConfig["installs"]>[string];

type TestUninstallParams = Parameters<typeof planPluginUninstall>[0] & {
  runtimePluginIds?: readonly string[];
  runtimeLoadPaths?: readonly string[];
};

function planTestUninstall(params: TestUninstallParams) {
  const { runtimePluginIds, runtimeLoadPaths, ...planParams } = params;
  return planPluginUninstall(
    recordPluginPackageUninstallPlan(planParams, {
      runtimePluginIds: runtimePluginIds ?? [params.pluginId],
      ...(runtimeLoadPaths ? { runtimeLoadPaths } : {}),
    }),
  );
}

async function uninstallPlugin(params: TestUninstallParams) {
  const plan = planTestUninstall(params);
  if (!plan.ok) {
    return plan;
  }
  const directory = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
  return {
    ok: true as const,
    config: plan.config,
    pluginId: plan.pluginId,
    actions: { ...plan.actions, directory: directory.directoryRemoved },
    warnings: directory.warnings,
  };
}

async function createInstalledNpmPluginFixture({
  baseDir,
  pluginId = "my-plugin",
}: {
  baseDir: string;
  pluginId?: string;
}) {
  const extensionsDir = path.join(baseDir, "extensions");
  const pluginDir = await createPluginDirFixture(extensionsDir, pluginId);
  return {
    pluginId,
    extensionsDir,
    pluginDir,
    config: installedPlugin(createNpmInstallRecord(pluginId, pluginDir), pluginId),
  };
}

type UninstallResult = Awaited<ReturnType<typeof uninstallPlugin>>;

function expectSuccessfulUninstall(result: UninstallResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected uninstall success, got: ${result.error}`);
  }
  return result;
}

function expectSuccessfulUninstallActions(
  result: UninstallResult,
  params: {
    directory: boolean;
    loadPath?: boolean;
    warnings?: string[];
  },
) {
  const successfulResult = expectSuccessfulUninstall(result);
  expect(successfulResult.actions.directory).toBe(params.directory);
  if (params.loadPath !== undefined) {
    expect(successfulResult.actions.loadPath).toBe(params.loadPath);
  }
  if (params.warnings) {
    expect(successfulResult.warnings).toEqual(params.warnings);
  }
  return successfulResult;
}

function createSinglePluginEntries(pluginId = "my-plugin") {
  return {
    [pluginId]: { enabled: true },
  };
}

function installedPlugin(
  record: PluginInstallRecord,
  pluginId = "my-plugin",
  extra: Parameters<typeof createPluginConfig>[0] = {},
) {
  return createPluginConfig({
    entries: createSinglePluginEntries(pluginId),
    installs: { [pluginId]: record },
    ...extra,
  });
}

function createNpmInstallRecord(pluginId = "my-plugin", installPath?: string): PluginInstallRecord {
  return {
    source: "npm",
    spec: `${pluginId}@1.0.0`,
    ...(installPath ? { installPath } : {}),
  };
}

function createGitInstallRecord(pluginId = "my-plugin", installPath?: string): PluginInstallRecord {
  return {
    source: "git",
    spec: `git:https://github.com/acme/${pluginId}.git`,
    gitUrl: `https://github.com/acme/${pluginId}.git`,
    gitCommit: "abc123",
    ...(installPath ? { installPath } : {}),
  };
}

function createMarketplaceInstallRecord(installPath: string): PluginInstallRecord {
  return {
    source: "marketplace",
    installPath,
    marketplaceSource: "release-fixtures",
    marketplacePlugin: "my-plugin",
  };
}

function createPathInstallRecord(
  installPath = "/path/to/plugin",
  sourcePath = installPath,
): PluginInstallRecord {
  return {
    source: "path",
    sourcePath,
    installPath,
  };
}

function createPluginConfig(params: {
  entries?: Record<string, { enabled: boolean }>;
  installs?: Record<string, PluginInstallRecord>;
  allow?: string[];
  deny?: string[];
  enabled?: boolean;
  slots?: PluginConfig["slots"];
  loadPaths?: string[];
  channels?: OpenClawConfig["channels"];
}): OpenClawConfig {
  const plugins: PluginConfig = {
    ...(params.entries ? { entries: params.entries } : {}),
    ...(params.installs ? { installs: params.installs } : {}),
    ...(params.allow ? { allow: params.allow } : {}),
    ...(params.deny ? { deny: params.deny } : {}),
    ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
    ...(params.slots ? { slots: params.slots } : {}),
    ...(params.loadPaths ? { load: { paths: params.loadPaths } } : {}),
  };
  return {
    ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
    ...(params.channels ? { channels: params.channels } : {}),
  };
}

function createSingleNpmInstallConfig(installPath: string): OpenClawConfig {
  return installedPlugin(createNpmInstallRecord("my-plugin", installPath));
}

function createKitchenSinkInstallConfig(
  installPath: string,
  entries?: Record<string, { enabled: boolean }>,
): OpenClawConfig {
  return createPluginConfig({
    entries,
    installs: {
      "openclaw-kitchen-sink-fixture": {
        source: "npm",
        spec: "@openclaw/kitchen-sink@1.0.0",
        installPath,
      },
    },
  });
}

function planKitchenSinkUninstall(
  pluginDir: string,
  extensionsDir: string,
  entries?: Record<string, { enabled: boolean }>,
) {
  return planTestUninstall({
    config: createKitchenSinkInstallConfig(pluginDir, entries),
    pluginId: "openclaw-kitchen-sink-fixture",
    deleteFiles: true,
    extensionsDir,
  });
}

async function createPluginDirFixture(baseDir: string, pluginId = "my-plugin") {
  const pluginDir = path.join(baseDir, pluginId);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.js"), "// plugin");
  return pluginDir;
}

function kitchenSinkDir(npmRoot: string) {
  return path.join(npmRoot, "node_modules", "@openclaw", "kitchen-sink");
}
function requirePlan(plan: ReturnType<typeof planTestUninstall>) {
  expect(plan.ok).toBe(true);
  if (!plan.ok) {
    throw new Error(plan.error);
  }
  return plan;
}
function requireRemovalPlan(plan: ReturnType<typeof planTestUninstall>) {
  const result = requirePlan(plan);
  if (!result.directoryRemoval) {
    throw new Error("missing removal");
  }
  return { ...result, directoryRemoval: result.directoryRemoval };
}
function makeExpectedActions(
  overrides: Partial<Extract<UninstallResult, { ok: true }>["actions"]>,
) {
  return {
    entry: false,
    install: false,
    allowlist: false,
    denylist: false,
    loadPath: false,
    memorySlot: false,
    contextEngineSlot: false,
    channelConfig: false,
    directory: false,
    ...overrides,
  };
}

async function writePackageJson(directory: string, manifest: Record<string, unknown>) {
  await fs.writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function expectPathAccessState(pathToCheck: string, expected: "exists" | "missing") {
  if (expected === "exists") {
    await fs.access(pathToCheck);
  } else {
    await expect(fs.access(pathToCheck)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

function expectNpmUninstallCommand(params: { packageName: string; npmRoot: string }) {
  const command = runCommandWithTimeoutMock.mock.calls[0];
  if (!command) {
    throw new Error("Expected npm uninstall command");
  }
  expect(npmCommandArgs(command[0])).toEqual([
    "uninstall",
    "--loglevel=error",
    "--legacy-peer-deps",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    params.packageName,
  ]);
  const options = command[1] as {
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  };
  expect(options.cwd).toBe(params.npmRoot);
  expect(options.timeoutMs).toBe(300_000);
  expect(options.env?.NPM_CONFIG_IGNORE_SCRIPTS).toBe("true");
  expect(options.env?.npm_config_legacy_peer_deps).toBe("true");
  expect(options.env?.npm_config_package_lock).toBe("true");
}

describe("resolveUninstallChannelConfigKeys", () => {
  it("filters shared keys and duplicate channel ids", () => {
    expect(
      resolveUninstallChannelConfigKeys("bad-plugin", {
        channelIds: ["defaults", "discord", "discord", "modelByChannel", "slack"],
      }),
    ).toEqual(["discord", "slack"]);
  });
});

describe("planPluginUninstall package ownership", () => {
  it("removes every owned child policy while planning one owner install removal", () => {
    const result = planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
          config: {
            plugins: {
              allow: ["pack/one", "pack/two", "other"],
              deny: ["pack/two"],
              entries: {
                "pack/one": { enabled: true },
                "pack/two": { enabled: false },
                other: { enabled: true },
              },
              installs: {
                pack: { source: "path", installPath: "/managed/pack" },
              },
              slots: { memory: "pack/two" },
            },
          },
          pluginId: "pack",
          deleteFiles: false,
        },
        { runtimePluginIds: ["pack/one", "pack/two"] },
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.directoryRemoval).toBeNull();
    expect(result.config.plugins).toEqual({
      allow: ["other"],
      entries: {
        other: { enabled: true },
        "pack/one": { enabled: false },
        "pack/two": { enabled: false },
      },
    });
    expect(result.actions).toMatchObject({
      entry: true,
      install: true,
      allowlist: true,
      denylist: true,
      memorySlot: true,
    });
  });
});

describe("removePluginFromConfig", () => {
  it("removes the install owner while retaining other installs", () => {
    const other = createNpmInstallRecord("other-plugin");
    const { config, actions } = removePluginFromConfig(
      createPluginConfig({
        installs: { "my-plugin": createNpmInstallRecord(), "other-plugin": other },
      }),
      "my-plugin",
    );
    expect(config.plugins?.installs).toEqual({ "other-plugin": other });
    expect(actions.install).toBe(true);
  });

  it.each<[string[], string[] | undefined]>([
    [["/path/to/plugin", "/other/path"], ["/other/path"]],
    [["/path/to/plugin"], undefined],
  ])("removes linked paths and empty load configuration: %j", (loadPaths, expectedPaths) => {
    const { config, actions } = removePluginFromConfig(
      createPluginConfig({
        installs: { "my-plugin": createPathInstallRecord() },
        loadPaths,
      }),
      "my-plugin",
    );
    expect(config.plugins?.load?.paths).toEqual(expectedPaths);
    expect(actions.loadPath).toBe(true);
  });

  it.each([
    {
      name: "marketplace install path",
      installRecord: createMarketplaceInstallRecord("/managed/my-plugin"),
      loadPaths: ["/managed/my-plugin", "/managed/my-plugin/child", "/other/path"],
      expectedPaths: ["/managed/my-plugin/child", "/other/path"],
      expectedChanged: true,
    },
    {
      name: "absent load paths",
      installRecord: createMarketplaceInstallRecord("/managed/my-plugin"),
      loadPaths: undefined,
      expectedPaths: undefined,
      expectedChanged: false,
    },
    {
      name: "mismatched and child paths",
      installRecord: createNpmInstallRecord("my-plugin", "/managed/my-plugin"),
      loadPaths: ["/managed/my-plugin-other", "/managed/my-plugin/child"],
      expectedPaths: ["/managed/my-plugin-other", "/managed/my-plugin/child"],
      expectedChanged: false,
    },
  ])(
    "cleans only the exact $name from load.paths",
    ({ installRecord, loadPaths, expectedPaths, expectedChanged }) => {
      const config = createPluginConfig({
        installs: { "my-plugin": installRecord },
        loadPaths,
      });

      const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

      expect(result.plugins?.load?.paths).toEqual(expectedPaths);
      expect(actions.loadPath).toBe(expectedChanged);
    },
  );

  it("removes absolute load path for a workspace-relative install source path", async () => {
    const tempRoot = path.join(process.cwd(), ".tmp");
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-uninstall-portable-source-"));
    try {
      const pluginDir = path.join(tempDir, "plugins", "demo");
      await fs.mkdir(pluginDir, { recursive: true });
      const realPluginDir = await fs.realpath(pluginDir);
      const sourcePath = `./${toRepoRelativePath(process.cwd(), realPluginDir)}`;
      const config = createPluginConfig({
        installs: {
          "my-plugin": createPathInstallRecord(undefined, sourcePath),
        },
        loadPaths: [realPluginDir, "/other/path"],
      });

      const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

      expect(result.plugins?.load?.paths).toEqual(["/other/path"]);
      expect(actions.loadPath).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("cleans up empty slots object", () => {
    const config = createPluginConfig({ entries: createSinglePluginEntries(), slots: {} });

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins).toBeUndefined();
  });

  it("preserves other config values", () => {
    const config = createPluginConfig({
      enabled: true,
      deny: ["denied-plugin"],
      entries: createSinglePluginEntries(),
    });

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.enabled).toBe(true);
    expect(result.plugins?.deny).toEqual(["denied-plugin"]);
  });

  const metadata = { defaults: { groupPolicy: "opt-in" }, modelByChannel: { timbot: "model" } };
  it.each<
    [
      string,
      Record<string, unknown> | undefined,
      Record<string, unknown> | undefined,
      boolean,
      string[] | undefined,
      boolean,
    ]
  >([
    ["installed channel", { timbot: {}, telegram: {} }, { telegram: {} }, true, undefined, true],
    ["uninstalled channel", { timbot: {} }, { timbot: {} }, false, undefined, false],
    ["last channel", { timbot: {} }, undefined, true, undefined, true],
    ["missing channel config", undefined, undefined, false, undefined, true],
    [
      "explicit channel IDs",
      { alternate: {}, second: {}, telegram: {} },
      { telegram: {} },
      true,
      ["alternate", "second"],
      true,
    ],
    [
      "shared metadata keys",
      { timbot: {}, ...metadata },
      metadata,
      true,
      ["timbot", "defaults", "modelByChannel"],
      true,
    ],
    ["non-channel plugin", { timbot: {} }, { timbot: {} }, false, [], true],
  ])("cleans channel config: %s", (_name, channels, remaining, changed, channelIds, installed) => {
    const config = createPluginConfig({
      entries: createSinglePluginEntries("timbot"),
      ...(installed ? { installs: { timbot: createNpmInstallRecord("timbot") } } : {}),
      channels: channels as OpenClawConfig["channels"],
    });
    const result = removePluginFromConfig(
      config,
      "timbot",
      channelIds ? { channelIds } : undefined,
    );
    expect(result.config.channels).toEqual(remaining);
    expect(result.actions.channelConfig).toBe(changed);
  });
});

describe("uninstallPlugin", () => {
  let tempDir: string;
  let stateDir: string;
  let stateExtensionsDir: string;
  let npmDir: string;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    runCommandWithTimeoutMock.mockReset();
    runCommandWithTimeoutMock.mockResolvedValue(createCommandResult());
    tempDir = await makeTrackedTempDirAsync("uninstall-test", tempDirs);
    stateDir = path.join(tempDir, "state");
    stateExtensionsDir = path.join(stateDir, "extensions");
    npmDir = path.join(stateDir, "npm");
    const globalConfig = path.join(tempDir, "global-npmrc");
    await fs.writeFile(globalConfig, "", "utf8");
    vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", globalConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanupTrackedTempDirsAsync(tempDirs);
  });

  it("does not treat inherited prototype names as installed plugins", async () => {
    const result = await uninstallPlugin({
      config: createPluginConfig({ entries: {}, installs: {} }),
      pluginId: "constructor",
      deleteFiles: false,
    });

    expect(result).toEqual({ ok: false, error: "Plugin not found: constructor" });
  });

  it("uninstalls own prototype-named plugin records", async () => {
    const result = await uninstallPlugin({
      config: installedPlugin(createNpmInstallRecord("constructor"), "constructor"),
      pluginId: "constructor",
      deleteFiles: false,
    });

    const successfulResult = expectSuccessfulUninstall(result);
    expect(successfulResult.config.plugins?.entries).toEqual({
      constructor: { enabled: false },
    });
    expect(successfulResult.actions.entry).toBe(true);
    expect(successfulResult.actions.install).toBe(true);
  });

  it.each<{
    name: string;
    config: OpenClawConfig;
    expected: OpenClawConfig;
    actions: Parameters<typeof makeExpectedActions>[0];
  }>([
    {
      name: "entry only",
      config: createPluginConfig({ entries: createSinglePluginEntries() }),
      expected: {},
      actions: { entry: true },
    },
    {
      name: "install and channel without runtime",
      config: createPluginConfig({
        installs: { "my-plugin": createNpmInstallRecord() },
        channels: { "my-plugin": {}, discord: {} },
      }),
      expected: {
        plugins: { entries: { "my-plugin": { enabled: false } } },
        channels: { discord: {} },
      },
      actions: { install: true, channelConfig: true },
    },
    {
      name: "linked record with missing source",
      config: createPluginConfig({
        installs: { "my-plugin": createPathInstallRecord("/missing/plugin") },
        loadPaths: ["/missing/plugin", "/keep/plugin"],
      }),
      expected: {
        plugins: {
          entries: { "my-plugin": { enabled: false } },
          load: { paths: ["/keep/plugin"] },
        },
      },
      actions: { install: true, loadPath: true },
    },
    {
      name: "policy and slots only",
      config: createPluginConfig({
        allow: ["my-plugin", "other"],
        deny: ["my-plugin"],
        slots: { memory: "my-plugin", contextEngine: "my-plugin" },
      }),
      expected: { plugins: { allow: ["other"] } },
      actions: { allowlist: true, denylist: true, memorySlot: true, contextEngineSlot: true },
    },
  ])("uninstall teardown: $name", async ({ config, expected, actions }) => {
    const result = expectSuccessfulUninstall(
      await uninstallPlugin({
        config,
        pluginId: "my-plugin",
        deleteFiles: true,
        extensionsDir: path.join(tempDir, "extensions"),
      }),
    );
    expect(result.config).toEqual(expected);
    expect(result.actions).toEqual(makeExpectedActions(actions));
    expect(result.warnings).toEqual([]);
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("plans directory removal without deleting before commit", async () => {
    const {
      pluginId,
      extensionsDir: fixtureExtensionsDir,
      pluginDir,
      config,
    } = await createInstalledNpmPluginFixture({
      baseDir: tempDir,
    });

    const plan = requirePlan(
      planTestUninstall({
        config,
        pluginId,
        deleteFiles: true,
        extensionsDir: fixtureExtensionsDir,
      }),
    );
    expect(plan.directoryRemoval).toEqual({ target: pluginDir });
    expect(plan.actions.directory).toBe(false);
    await fs.access(pluginDir);

    const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
    expect(applied).toEqual({ directoryRemoved: true, warnings: [] });
    await expectPathAccessState(pluginDir, "missing");
  });

  it.each(["legacy", "ordinary", "generation"] as const)(
    "uninstalls a %s npm project at its owned root",
    async (layout) => {
      const npmRoot =
        layout === "legacy"
          ? npmDir
          : layout === "ordinary"
            ? resolvePluginNpmProjectDir({ npmDir, packageName: "@openclaw/kitchen-sink" })
            : resolvePluginNpmGenerationProjectDir({
                npmDir,
                packageName: "@openclaw/kitchen-sink",
                generationKey: "kitchen-sink-v2",
              });
      const pluginDir = await createPluginDirFixture(
        path.join(npmRoot, "node_modules", "@openclaw"),
        "kitchen-sink",
      );
      await writePackageJson(npmRoot, {
        private: true,
        dependencies: { "@openclaw/kitchen-sink": "1.0.0" },
      });
      const plan = requireRemovalPlan(planKitchenSinkUninstall(pluginDir, stateExtensionsDir));
      expect(plan.directoryRemoval.target).toBe(layout === "legacy" ? pluginDir : npmRoot);
      expect(await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval)).toEqual({
        directoryRemoved: true,
        warnings: [],
      });
      if (layout === "legacy") {
        expectNpmUninstallCommand({ packageName: "@openclaw/kitchen-sink", npmRoot });
      } else {
        expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
        await expectPathAccessState(npmRoot, "missing");
      }
      await expectPathAccessState(pluginDir, "missing");
    },
  );

  it.each([
    ["unrelated sibling", "noncanonical-sibling"],
    [
      "invalid generation suffix",
      `${resolvePluginNpmGenerationProjectDirPrefix("@openclaw/kitchen-sink")}g-0123456789abcde`,
    ],
  ])("preserves a noncanonical npm project root ($name)", async (_name, projectName) => {
    const npmRoot = path.join(stateDir, "npm", "projects", projectName);
    const pluginDir = kitchenSinkDir(npmRoot);
    const siblingFile = path.join(npmRoot, "must-remain.txt");
    await fs.mkdir(pluginDir, { recursive: true });
    await writePackageJson(npmRoot, {
      private: true,
      dependencies: {
        "@openclaw/kitchen-sink": "1.0.0",
      },
    });
    await fs.writeFile(path.join(pluginDir, "package.json"), "{}");
    await fs.writeFile(siblingFile, "preserve me");

    const plan = requirePlan(
      planKitchenSinkUninstall(
        pluginDir,
        stateExtensionsDir,
        createSinglePluginEntries("openclaw-kitchen-sink-fixture"),
      ),
    );
    expect(plan.directoryRemoval?.target).toBe(pluginDir);

    const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);

    expect(applied).toEqual({ directoryRemoved: true, warnings: [] });
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    await expectPathAccessState(pluginDir, "missing");
    await expect(fs.readFile(siblingFile, "utf8")).resolves.toBe("preserve me");
  });

  it.each(["projects", "project"] as const)(
    "does not follow a substituted npm %s directory",
    async (substitution) => {
      const projectRoot = resolvePluginNpmProjectDir({
        npmDir,
        packageName: "@openclaw/kitchen-sink",
      });
      const link = substitution === "projects" ? path.dirname(projectRoot) : projectRoot;
      const outside = path.join(tempDir, "outside");
      const outsideProject =
        substitution === "projects" ? path.join(outside, path.basename(projectRoot)) : outside;
      const sentinel = path.join(outsideProject, "must-remain.txt");
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.mkdir(kitchenSinkDir(outsideProject), { recursive: true });
      await fs.writeFile(sentinel, "preserve me");
      await fs.symlink(outside, link, "dir");
      const result = await uninstallPlugin({
        config: createKitchenSinkInstallConfig(
          kitchenSinkDir(projectRoot),
          createSinglePluginEntries("openclaw-kitchen-sink-fixture"),
        ),
        pluginId: "openclaw-kitchen-sink-fixture",
        deleteFiles: true,
        extensionsDir: stateExtensionsDir,
      });
      expectSuccessfulUninstallActions(result, { directory: false, warnings: [] });
      await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me");
    },
  );

  it("rejects a symlinked package inside a canonical npm project", async () => {
    const projectRoot = resolvePluginNpmProjectDir({
      npmDir,
      packageName: "@openclaw/kitchen-sink",
    });
    const pluginDir = kitchenSinkDir(projectRoot);
    const packageTarget = path.join(projectRoot, "node_modules", "package-target");
    const sentinel = path.join(projectRoot, "must-remain.txt");
    await fs.mkdir(path.dirname(pluginDir), { recursive: true });
    await fs.mkdir(packageTarget, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "package.json"), "{}\n");
    await fs.writeFile(sentinel, "preserve me");
    await fs.symlink(packageTarget, pluginDir, "dir");

    const plan = requireRemovalPlan(planKitchenSinkUninstall(pluginDir, stateExtensionsDir));
    expect(plan.directoryRemoval.target).toBe(pluginDir);

    const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);

    expect(applied).toEqual({
      directoryRemoved: false,
      warnings: [`Refused to remove npm path without verified package ownership: ${pluginDir}`],
    });
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me");
    await expect(fs.lstat(pluginDir).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
  });

  it.each(["canonical", "noncanonical"] as const)(
    "revalidates %s npm project ownership after the removal plan is created",
    async (layout) => {
      const projectRoot =
        layout === "canonical"
          ? resolvePluginNpmProjectDir({
              npmDir,
              packageName: "@openclaw/kitchen-sink",
            })
          : path.join(npmDir, "projects", "noncanonical-race");
      const pluginDir = kitchenSinkDir(projectRoot);
      await fs.mkdir(pluginDir, { recursive: true });
      const plan = requireRemovalPlan(planKitchenSinkUninstall(pluginDir, stateExtensionsDir));
      expect(plan.directoryRemoval.target).toBe(layout === "canonical" ? projectRoot : pluginDir);

      const outsideNpmDir = path.join(tempDir, "outside-npm-race");
      const outsideProjectRoot = path.join(outsideNpmDir, "projects", path.basename(projectRoot));
      const outsideTarget =
        layout === "canonical"
          ? outsideProjectRoot
          : path.join(outsideProjectRoot, "node_modules", "@openclaw", "kitchen-sink");
      const sentinel = path.join(outsideTarget, "must-remain.txt");
      await fs.mkdir(outsideTarget, { recursive: true });
      await fs.writeFile(sentinel, "preserve me");
      await fs.rename(npmDir, `${npmDir}-original`);
      await fs.symlink(outsideNpmDir, npmDir, "dir");

      const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);

      expect(applied.directoryRemoved).toBe(false);
      expect(applied.warnings).toEqual([
        `Refused to remove npm path without verified package ownership: ${plan.directoryRemoval.target}`,
      ]);
      await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me");
    },
  );

  it.each(["canonical", "noncanonical"] as const)(
    "refuses $layout npm cleanup through a substituted manifest",
    async (layout) => {
      const npmRoot =
        layout === "canonical"
          ? resolvePluginNpmProjectDir({
              npmDir,
              packageName: "@openclaw/kitchen-sink",
            })
          : path.join(npmDir, "projects", "noncanonical-manifest");
      const pluginDir = kitchenSinkDir(npmRoot);
      const manifestPath = path.join(npmRoot, "package.json");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(manifestPath, "{}\n");
      const plan = requireRemovalPlan(planKitchenSinkUninstall(pluginDir, stateExtensionsDir));
      const expectedTarget = layout === "canonical" ? npmRoot : pluginDir;
      expect(plan.directoryRemoval.target).toBe(expectedTarget);

      const outsideManifest = path.join(tempDir, "outside-package.json");
      await fs.writeFile(outsideManifest, '{"preserve":true}\n');
      await fs.rm(manifestPath);
      await fs.symlink(outsideManifest, manifestPath);

      const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);

      expect(applied.directoryRemoved).toBe(false);
      expect(applied.warnings).toEqual([
        `Refused to remove npm path without verified package ownership: ${expectedTarget}`,
      ]);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
      await expect(fs.readFile(outsideManifest, "utf8")).resolves.toBe('{"preserve":true}\n');
      await expectPathAccessState(pluginDir, "exists");
    },
  );

  it("repairs remaining npm plugin openclaw peer links after npm uninstall prunes them", async () => {
    const npmRoot = path.join(stateDir, "npm");
    const removedPluginDir = path.join(npmRoot, "node_modules", "removed-plugin");
    const peerPluginDir = path.join(npmRoot, "node_modules", "peer-plugin");
    const peerLink = path.join(peerPluginDir, "node_modules", "openclaw");
    await fs.mkdir(removedPluginDir, { recursive: true });
    await fs.mkdir(path.dirname(peerLink), { recursive: true });
    await writePackageJson(npmRoot, {
      private: true,
      dependencies: {
        "removed-plugin": "1.0.0",
        "peer-plugin": "1.0.0",
      },
    });
    await fs.writeFile(path.join(removedPluginDir, "package.json"), "{}\n");
    await writePackageJson(peerPluginDir, {
      name: "peer-plugin",
      version: "1.0.0",
      peerDependencies: { openclaw: ">=2026.0.0" },
    });
    await fs.symlink(tempDir, peerLink, "junction");
    runCommandWithTimeoutMock.mockImplementationOnce(async (argv: string[]) => {
      await fs.rm(peerLink, { recursive: true, force: true });
      if (!argv.includes("--legacy-peer-deps")) {
        await fs.mkdir(path.join(npmRoot, "node_modules", "openclaw"), { recursive: true });
      }
      return createCommandResult();
    });

    const applied = await applyPluginUninstallDirectoryRemoval({
      target: removedPluginDir,
      cleanup: {
        kind: "npm",
        npmRoot,
        packageName: "removed-plugin",
        rootKind: "legacy-shared",
      },
    });

    expect(applied).toEqual({ directoryRemoved: true, warnings: [] });
    await expectPathAccessState(removedPluginDir, "missing");
    await expectPathAccessState(path.join(npmRoot, "node_modules", "openclaw"), "missing");
    await expect(fs.lstat(peerLink).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
  });

  it("prunes managed peer dependencies after their owning npm plugin is uninstalled", async () => {
    const npmRoot = path.join(stateDir, "npm");
    const removedPluginDir = path.join(npmRoot, "node_modules", "removed-plugin");
    const runtimePeerDir = path.join(npmRoot, "node_modules", "runtime-peer");
    await fs.mkdir(removedPluginDir, { recursive: true });
    await fs.mkdir(runtimePeerDir, { recursive: true });
    await writePackageJson(npmRoot, {
      private: true,
      dependencies: {
        "removed-plugin": "1.0.0",
        "runtime-peer": "1.0.0",
      },
      openclaw: {
        managedPeerDependencies: ["runtime-peer"],
      },
    });
    await writePackageJson(removedPluginDir, {
      name: "removed-plugin",
      version: "1.0.0",
      peerDependencies: { "runtime-peer": "^1.0.0" },
    });
    await writePackageJson(runtimePeerDir, { name: "runtime-peer", version: "1.0.0" });
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[], options?: unknown) => {
      if (npmCommandArgs(argv)?.[0] === "uninstall") {
        expect(argv).toContain("--legacy-peer-deps");
        await fs.rm(removedPluginDir, { recursive: true, force: true });
        const rootManifest = JSON.parse(
          await fs.readFile(path.join(npmRoot, "package.json"), "utf8"),
        ) as { dependencies?: Record<string, string> };
        delete rootManifest.dependencies?.["removed-plugin"];
        await writePackageJson(npmRoot, rootManifest);
        return createCommandResult();
      }
      if (npmCommandArgs(argv)?.[0] === "install" && argv.includes("--package-lock-only")) {
        const cwd = (options as { cwd?: string } | undefined)?.cwd;
        expect(cwd).toBeTruthy();
        await fs.writeFile(
          path.join(cwd as string, "package-lock.json"),
          `${JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }, null, 2)}\n`,
        );
        return createCommandResult();
      }
      if (npmCommandArgs(argv)?.[0] === "install") {
        expect(argv).toContain("--legacy-peer-deps");
        expect(argv).toContain("--omit=peer");
        await fs.rm(runtimePeerDir, { recursive: true, force: true });
        return createCommandResult();
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const applied = await applyPluginUninstallDirectoryRemoval({
      target: removedPluginDir,
      cleanup: {
        kind: "npm",
        npmRoot,
        packageName: "removed-plugin",
        rootKind: "legacy-shared",
      },
    });

    expect(applied).toEqual({ directoryRemoved: true, warnings: [] });
    await expectPathAccessState(removedPluginDir, "missing");
    await expectPathAccessState(runtimePeerDir, "missing");
    const rootManifest = JSON.parse(
      await fs.readFile(path.join(npmRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      openclaw?: { managedPeerDependencies?: string[] };
    };
    expect(rootManifest.dependencies?.["removed-plugin"]).toBeUndefined();
    expect(rootManifest.dependencies?.["runtime-peer"]).toBeUndefined();
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain("runtime-peer");
  });

  it.each([false, true])(
    "removes stale managed peers after override normalization (alias retry: %s)",
    async (rejectAliases) => {
      const npmRoot = path.join(tempDir, "npm-override-cleanup");
      await fs.mkdir(npmRoot, { recursive: true });
      await writePackageJson(npmRoot, {
        private: true,
        dependencies: { "stale-peer": "1.0.0" },
        overrides: {
          axios: "1.18.1",
          "node-domexception": "npm:@nolyfill/domexception@1.0.28",
          "werift-ice@0.2.2>ip": "npm:neoip@3.1.0",
        },
        openclaw: {
          managedOverrides: ["axios", "node-domexception", "werift-ice@0.2.2>ip"],
          managedPeerDependencies: ["stale-peer"],
        },
      });

      let cleanupAttempts = 0;
      const runCommand: typeof runCommandWithTimeout = vi.fn(async (argv, optionsOrTimeout) => {
        const cwd = typeof optionsOrTimeout === "number" ? undefined : optionsOrTimeout.cwd;
        if (argv.includes("--package-lock-only")) {
          expect(cwd).toBeTruthy();
          const manifest = JSON.parse(
            await fs.readFile(path.join(cwd as string, "package.json"), "utf8"),
          ) as { overrides?: Record<string, unknown> };
          if (manifest.overrides?.["werift-ice@0.2.2>ip"]) {
            return createCommandResult({
              code: 1,
              stderr:
                'npm error code EINVALIDTAGNAME\nnpm error Invalid tag name "0.2.2>ip" of package "werift-ice@0.2.2>ip"',
            });
          }
          if (rejectAliases && manifest.overrides?.["node-domexception"]) {
            return createCommandResult({
              code: 1,
              stderr: "npm ERR! Invalid comparator: npm:@nolyfill/domexception@1.0.28",
            });
          }
          await fs.writeFile(
            path.join(cwd as string, "package-lock.json"),
            `${JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }, null, 2)}\n`,
          );
          return createCommandResult();
        }
        cleanupAttempts += 1;
        const manifest = JSON.parse(
          await fs.readFile(path.join(npmRoot, "package.json"), "utf8"),
        ) as { overrides?: Record<string, unknown> };
        expect(manifest.overrides?.["werift-ice@0.2.2>ip"]).toBeUndefined();
        if (rejectAliases && manifest.overrides?.["node-domexception"]) {
          return createCommandResult({
            code: 1,
            stderr: "npm ERR! Invalid comparator: npm:@nolyfill/domexception@1.0.28",
          });
        }
        return createCommandResult();
      });

      await expect(
        pruneManagedNpmPeerDependenciesAfterUninstall({
          npmRoot,
          packageName: "@openclaw/kitchen-sink",
          managedOverrides: {
            axios: "1.18.1",
            hono: "4.12.32",
            "node-domexception": "npm:@nolyfill/domexception@1.0.28",
          },
          runCommand,
        }),
      ).resolves.toBeUndefined();
      expect(cleanupAttempts).toBe(rejectAliases ? 2 : 1);
      const manifest = JSON.parse(
        await fs.readFile(path.join(npmRoot, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        overrides?: Record<string, unknown>;
        openclaw?: {
          managedOverrides?: string[];
          managedPeerDependencies?: string[];
        };
      };
      expect(manifest.dependencies).toEqual({});
      const expectedOverrides = {
        axios: "1.18.1",
        hono: "4.12.32",
        ...(!rejectAliases ? { "node-domexception": "npm:@nolyfill/domexception@1.0.28" } : {}),
      };
      expect(manifest.overrides).toEqual(expectedOverrides);
      expect(manifest.openclaw?.managedOverrides).toEqual(
        Object.keys(expectedOverrides).toSorted(),
      );
      expect(manifest.openclaw?.managedPeerDependencies).toBeUndefined();
    },
  );

  it("does not remove incompatible unmanaged overrides", async () => {
    const npmRoot = path.join(tempDir, "npm-unmanaged-override-cleanup");
    await fs.mkdir(npmRoot, { recursive: true });
    await writePackageJson(npmRoot, {
      private: true,
      overrides: {
        "unmanaged-parent@1.0.0>child": "2.0.0",
      },
    });

    let cleanupAttempts = 0;
    const runCommand: typeof runCommandWithTimeout = vi.fn(async (argv, optionsOrTimeout) => {
      const cwd = typeof optionsOrTimeout === "number" ? undefined : optionsOrTimeout.cwd;
      if (argv.includes("--package-lock-only")) {
        expect(cwd).toBeTruthy();
        await fs.writeFile(
          path.join(cwd as string, "package-lock.json"),
          `${JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }, null, 2)}\n`,
        );
        return createCommandResult();
      }
      cleanupAttempts += 1;
      return createCommandResult({
        code: 1,
        stderr:
          'npm error code EINVALIDTAGNAME\nnpm error Invalid tag name "1.0.0>child" of package "unmanaged-parent@1.0.0>child"',
      });
    });

    await expect(
      pruneManagedNpmPeerDependenciesAfterUninstall({
        npmRoot,
        packageName: "@openclaw/kitchen-sink",
        managedOverrides: { axios: "1.18.1" },
        runCommand,
      }),
    ).resolves.toContain(
      "Failed to prune managed peer dependencies after uninstalling @openclaw/kitchen-sink: npm error code EINVALIDTAGNAME",
    );
    expect(cleanupAttempts).toBe(1);
  });

  it("runs npm cleanup when the managed package directory is already absent", async () => {
    const npmRoot = path.join(stateDir, "npm");
    const pluginDir = path.join(npmRoot, "node_modules", "missing-plugin");
    const peerPluginDir = path.join(npmRoot, "node_modules", "peer-plugin");
    const peerLink = path.join(peerPluginDir, "node_modules", "openclaw");
    await fs.mkdir(path.dirname(peerLink), { recursive: true });
    await writePackageJson(npmRoot, {
      private: true,
      dependencies: {
        "missing-plugin": "1.0.0",
        "peer-plugin": "1.0.0",
      },
    });
    await writePackageJson(peerPluginDir, {
      name: "peer-plugin",
      version: "1.0.0",
      peerDependencies: { openclaw: ">=2026.0.0" },
    });

    const applied = await applyPluginUninstallDirectoryRemoval({
      target: pluginDir,
      cleanup: {
        kind: "npm",
        npmRoot,
        packageName: "missing-plugin",
        rootKind: "legacy-shared",
      },
    });

    expect(applied).toEqual({ directoryRemoved: false, warnings: [] });
    expectNpmUninstallCommand({ packageName: "missing-plugin", npmRoot });
    await expect(fs.lstat(peerLink).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
  });

  it("removes stale npm install config when the managed npm root is already absent", async () => {
    const npmRoot = path.join(stateDir, "npm");
    const pluginDir = path.join(npmRoot, "node_modules", "missing-plugin");

    const result = await uninstallPlugin({
      config: installedPlugin(
        createNpmInstallRecord("missing-plugin", pluginDir),
        "missing-plugin",
      ),
      pluginId: "missing-plugin",
      deleteFiles: true,
      extensionsDir: stateExtensionsDir,
    });

    const successfulResult = expectSuccessfulUninstall(result);
    expect(successfulResult.config.plugins?.entries).toEqual({
      "missing-plugin": { enabled: false },
    });
    expect(successfulResult.actions.entry).toBe(true);
    expect(successfulResult.actions.install).toBe(true);
    expect(successfulResult.actions.directory).toBe(false);
    expect(successfulResult.warnings).toStrictEqual([]);
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("warns and still removes npm package dirs when npm prune cleanup fails", async () => {
    runCommandWithTimeoutMock.mockResolvedValueOnce(
      createCommandResult({ code: 1, stderr: "registry unavailable" }),
    );
    const npmRoot = path.join(stateDir, "npm");
    const pluginDir = path.join(npmRoot, "node_modules", "demo-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await writePackageJson(npmRoot, {
      private: true,
      dependencies: {
        "demo-plugin": "1.0.0",
      },
    });

    const result = await uninstallPlugin({
      config: installedPlugin(
        {
          source: "npm",
          spec: "demo-plugin@1.0.0",
          installPath: pluginDir,
        },
        "demo-plugin",
      ),
      pluginId: "demo-plugin",
      deleteFiles: true,
      extensionsDir: stateExtensionsDir,
    });

    const successfulResult = expectSuccessfulUninstallActions(result, {
      directory: true,
    });
    expect(successfulResult.warnings).toEqual([
      "Failed to prune npm dependencies for plugin package demo-plugin: registry unavailable",
    ]);
    await expectPathAccessState(pluginDir, "missing");
  });

  it.each(["linked", "copied", "keep-files", "missing"] as const)(
    "handles %s install directories",
    async (kind) => {
      const extensionsDir = path.join(tempDir, "extensions");
      const sourceDir =
        kind === "missing" ? "/nonexistent/path" : await createPluginDirFixture(tempDir);
      const installDir =
        kind === "copied" ? await createPluginDirFixture(extensionsDir) : sourceDir;
      const record =
        kind === "linked" || kind === "copied"
          ? createPathInstallRecord(installDir, sourceDir)
          : createNpmInstallRecord("my-plugin", installDir);
      const result = await uninstallPlugin({
        config: installedPlugin(
          record,
          "my-plugin",
          kind === "linked" ? { loadPaths: [sourceDir] } : {},
        ),
        pluginId: "my-plugin",
        deleteFiles: kind !== "keep-files",
        extensionsDir,
      });
      expectSuccessfulUninstallActions(result, {
        directory: kind === "copied",
        ...(kind === "linked" ? { loadPath: true } : {}),
        ...(kind === "missing" ? { warnings: [] } : {}),
      });
      if (kind !== "missing") {
        await expectPathAccessState(installDir, kind === "copied" ? "missing" : "exists");
      }
      if (kind === "copied") {
        await expectPathAccessState(sourceDir, "exists");
      }
    },
  );

  it("returns a warning when directory deletion fails unexpectedly", async () => {
    const unlinkSpy = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("permission denied"));
    try {
      const { config, pluginId, extensionsDir } = await createInstalledNpmPluginFixture({
        baseDir: tempDir,
      });
      const result = await uninstallPlugin({ config, pluginId, extensionsDir, deleteFiles: true });

      const successfulResult = expectSuccessfulUninstallActions(result, {
        directory: false,
      });
      expect(successfulResult.warnings).toHaveLength(1);
      expect(successfulResult.warnings[0]).toContain("Failed to remove plugin directory");
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("never deletes arbitrary configured install paths", async () => {
    const outsideDir = path.join(tempDir, "outside-dir");
    const fixtureExtensionsDir = path.join(tempDir, "extensions");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "index.js"), "// keep me");

    const config = createSingleNpmInstallConfig(outsideDir);

    const result = await uninstallPlugin({
      config,
      pluginId: "my-plugin",
      deleteFiles: true,
      extensionsDir: fixtureExtensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: false,
    });
    await fs.access(outsideDir);
  });

  it("deletes tracked managed install paths even when they are not the default target", async () => {
    const fixtureExtensionsDir = path.join(tempDir, "extensions");
    const managedDir = path.join(fixtureExtensionsDir, "archive-installs", "my-plugin");
    await fs.mkdir(managedDir, { recursive: true });
    await fs.writeFile(path.join(managedDir, "index.js"), "// plugin");

    const result = await uninstallPlugin({
      config: createSingleNpmInstallConfig(managedDir),
      pluginId: "my-plugin",
      deleteFiles: true,
      extensionsDir: fixtureExtensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: true,
    });
    await expectPathAccessState(managedDir, "missing");
  });

  it("deletes tracked installs from a recorded managed extensions root", async () => {
    const currentExtensionsDir = path.join(tempDir, "current", "extensions");
    const recordedExtensionsDir = path.join(tempDir, "recorded", "extensions");
    const installPath = resolvePluginInstallDir("my-plugin", recordedExtensionsDir);
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(path.join(installPath, "index.js"), "// plugin");

    const result = await uninstallPlugin({
      config: createSingleNpmInstallConfig(installPath),
      pluginId: "my-plugin",
      deleteFiles: true,
      extensionsDir: currentExtensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: true,
    });
    await expectPathAccessState(installPath, "missing");
  });

  it("deletes managed ClawHub install directories", async () => {
    const installPath = resolvePluginInstallDir("clawpack-demo", stateExtensionsDir);
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(path.join(installPath, "index.js"), "// clawhub plugin");

    const result = await uninstallPlugin({
      config: installedPlugin(
        {
          source: "clawhub",
          spec: "clawhub:clawpack-demo@2026.5.1-beta.2",
          installPath,
        },
        "clawpack-demo",
      ),
      pluginId: "clawpack-demo",
      deleteFiles: true,
      extensionsDir: stateExtensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: true,
    });
    await expectPathAccessState(installPath, "missing");
  });

  it.each([false, true])(
    "deletes a managed git repo and preserves nonempty parent: %s",
    async (keepParent) => {
      const installParent = path.join(stateDir, "git", "git-abc123");
      const installPath = await createPluginDirFixture(installParent, "repo");
      const sentinel = path.join(installParent, "keep.txt");
      if (keepParent) {
        await fs.writeFile(sentinel, "keep");
      }
      const result = await uninstallPlugin({
        config: installedPlugin(createGitInstallRecord("my-plugin", installPath)),
        pluginId: "my-plugin",
        deleteFiles: true,
        extensionsDir: stateExtensionsDir,
      });
      expectSuccessfulUninstallActions(result, { directory: true });
      await expectPathAccessState(installPath, "missing");
      if (keepParent) {
        await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("keep");
      } else {
        await expectPathAccessState(installParent, "missing");
      }
    },
  );

  it("does not delete symlinked git install targets that resolve outside the managed git root", async () => {
    const linkParentDir = path.join(stateDir, "git", "git-abc123");
    const installPath = path.join(linkParentDir, "repo");
    const outsideDir = path.join(tempDir, "outside");
    await fs.mkdir(linkParentDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "index.js"), "// keep me");
    await fs.symlink(outsideDir, installPath, "dir");

    const result = await uninstallPlugin({
      config: installedPlugin(createGitInstallRecord("my-plugin", installPath)),
      pluginId: "my-plugin",
      deleteFiles: true,
      extensionsDir: stateExtensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: false,
    });
    await fs.access(outsideDir);
    const linkStat = await fs.lstat(installPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
