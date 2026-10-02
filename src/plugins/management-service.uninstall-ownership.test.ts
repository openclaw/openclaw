import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTestConfigFileStore } from "../commands/test-runtime-config-helpers.js";
import { resolveConfigWriteFollowUp } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";

const mocks = vi.hoisted(() => ({
  commitRecords: vi.fn(),
  installRecords: vi.fn(),
  metadata: vi.fn(),
  readConfig: vi.fn(),
  refreshRegistry: vi.fn(),
  replaceConfig: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => undefined,
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: (params: unknown) => mocks.replaceConfig(params),
}));

vi.mock("../config/io.factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.factory.js")>();
  return {
    ...actual,
    createConfigIO: (options: Parameters<typeof actual.createConfigIO>[0]) => ({
      ...actual.createConfigIO(options),
      readConfigFileSnapshotForWrite: () => mocks.readConfig(),
    }),
  };
});

vi.mock("./install-config.js", () => ({
  persistPluginInstall: vi.fn(),
}));

vi.mock("./install-config-mutation.js", () => ({
  resolveInstallConfigMutationPreflights: () => ({
    hookMutation: { mode: "allowed" },
    pluginMutation: { mode: "allowed" },
  }),
  selectInstallMutationWriteOptions: (writeOptions: unknown) => writeOptions,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: (...args: unknown[]) => mocks.installRecords(...args),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./install-record-commit.js", () => ({
  commitPluginInstallRecordsWithConfig: (...args: unknown[]) => mocks.commitRecords(...args),
}));

vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: (...args: unknown[]) => mocks.refreshRegistry(...args),
}));

const { uninstallManagedPlugin } = await import("./management-uninstall.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function mockConfig(
  configPath: string,
  source: OpenClawConfig | (() => OpenClawConfig),
  hash = "base-hash",
) {
  mocks.readConfig.mockImplementation(async () => {
    const config = typeof source === "function" ? source() : source;
    return {
      snapshot: {
        valid: true,
        parsed: typeof source === "function" ? config : {},
        path: configPath,
        sourceConfig: config,
        hash,
      },
      writeOptions: { expectedConfigPath: configPath },
    };
  });
}

function packageMetadata(
  owner: string,
  records: Record<string, PluginInstallRecord>,
  plugins: { id: string; enabled?: boolean; channels?: string[]; source?: string }[],
) {
  return {
    index: {
      plugins: plugins.map(({ id, enabled }) =>
        recordInstalledPluginIndexInstallOwner(
          { pluginId: id, origin: "global", enabled, rootDir: records[owner]?.installPath },
          owner,
        ),
      ),
      installRecords: records,
    },
    byPluginId: new Map(
      plugins.map(({ id, channels = [], source }) => [
        id,
        recordPluginManifestInstallOwner({ id, channels, ...(source ? { source } : {}) }, owner),
      ]),
    ),
    normalizePluginId: (id: string) => id,
  };
}

describe("plugin management uninstall channel ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const configFiles = createTestConfigFileStore();
    mocks.commitRecords.mockImplementation(
      async ({
        nextConfig,
        writeOptions,
      }: Parameters<
        typeof import("./install-record-commit.js").commitPluginInstallRecordsWithConfig
      >[0]) => {
        const configPath = expectDefined(
          writeOptions?.ownedConfigPathForWrite ?? writeOptions?.expectedConfigPath,
          "fixture config write path",
        );
        const afterWrite = writeOptions?.afterWrite ?? { mode: "auto" as const };
        return {
          configWrite: {
            ...configFiles.write(nextConfig, configPath),
            persistedHash: "committed",
            persistedSourceConfig: nextConfig,
            afterWrite,
            followUp: resolveConfigWriteFollowUp(afterWrite),
          },
        };
      },
    );
  });

  it.each([
    { label: "an enabled non-channel plugin", enabled: true, channelIds: [] },
    {
      label: "a disabled channel plugin",
      enabled: false,
      channelIds: ["owned-channel", "owned-channel-backup"],
    },
  ])(
    "preserves manifest channel ownership when uninstalling $label",
    async ({ enabled, channelIds }) => {
      const root = tempDirs.make("openclaw-managed-linked-uninstall-");
      const configPath = path.join(root, "openclaw.json");
      const pluginId = "custom-plugin";
      const installPath = "/tmp/openclaw-managed-linked-custom-plugin";
      const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
      const channels = {
        [pluginId]: { enabled: true },
        "owned-channel": { enabled: true },
        "owned-channel-backup": { enabled: true },
        discord: { enabled: true },
      };
      mockConfig(configPath, { plugins: { entries: { [pluginId]: { enabled } } }, channels });
      mocks.installRecords.mockResolvedValue({ [pluginId]: installRecord });
      mocks.metadata.mockReturnValue(
        packageMetadata(pluginId, { [pluginId]: installRecord }, [
          { id: pluginId, enabled, channels: channelIds },
        ]),
      );

      const result = await uninstallManagedPlugin({
        pluginId,
        env: { OPENCLAW_STATE_DIR: root },
      });

      const ownedChannelIds = channelIds;
      expect(mocks.commitRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          nextConfig: expect.objectContaining({
            channels: Object.fromEntries(
              Object.entries(channels).filter(
                ([channelId]) => !ownedChannelIds.includes(channelId),
              ),
            ),
          }),
          nextInstallRecords: {},
        }),
      );
      expect(result.removed).toEqual([
        "plugin settings",
        "install record",
        ...(ownedChannelIds.length > 0 ? ["channel config"] : []),
      ]);
    },
  );

  it("fails closed when an owner record has no authoritative child metadata", async () => {
    const pluginId = "custom-plugin";
    const installPath = "/tmp/openclaw-managed-missing-children";
    const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
    mockConfig("/tmp/openclaw.json", { plugins: { entries: { [pluginId]: { enabled: true } } } });
    mocks.installRecords.mockResolvedValue({ [pluginId]: installRecord });
    mocks.metadata.mockReturnValue({
      index: {
        plugins: [{ pluginId, origin: "global", enabled: true, rootDir: installPath }],
        installRecords: { [pluginId]: installRecord },
      },
      byPluginId: new Map(),
      normalizePluginId: (rawPluginId: string) => rawPluginId,
    });

    await expect(uninstallManagedPlugin({ pluginId, env: {} })).rejects.toThrow(
      "no authoritative package-owner metadata",
    );
    expect(mocks.commitRecords).not.toHaveBeenCalled();
  });

  it("fails closed when an orphan record path overlaps a discovered plugin", async () => {
    const pluginId = "orphaned-plugin";
    const installPath = "/tmp/openclaw-managed-conflicting-orphan";
    const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
    mockConfig("/tmp/openclaw.json", {});
    mocks.installRecords.mockResolvedValue({ [pluginId]: installRecord });
    mocks.metadata.mockReturnValue({
      index: {
        plugins: [
          recordInstalledPluginIndexInstallOwner(
            { pluginId: "other", origin: "global", enabled: true, rootDir: installPath },
            "other",
          ),
        ],
        installRecords: { [pluginId]: installRecord },
      },
      byPluginId: new Map(),
      normalizePluginId: (rawPluginId: string) => rawPluginId,
    });

    await expect(uninstallManagedPlugin({ pluginId, env: {} })).rejects.toThrow(
      "no authoritative runtime child list",
    );
    expect(mocks.commitRecords).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves another channel owner during managed orphan uninstall: %s",
    async (claimed) => {
      const root = tempDirs.make("openclaw-managed-orphan-uninstall-");
      const configPath = path.join(root, "openclaw.json");
      const configFiles = createTestConfigFileStore();
      const pluginId = "orphaned-plugin";
      const installRecord = {
        source: "path",
        sourcePath: path.join(root, "missing-orphan-source"),
        installPath: path.join(root, "missing-orphan-install"),
      } as const;
      let config: OpenClawConfig = {
        plugins: { entries: { [pluginId]: { enabled: true } } },
        channels: { [pluginId]: { enabled: true }, unknown: { enabled: true } },
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      mockConfig(configPath, () => config);
      mocks.replaceConfig.mockImplementation(
        async ({ sourceConfig }: { sourceConfig: OpenClawConfig }) => {
          config = sourceConfig;
          await fs.writeFile(configPath, JSON.stringify(config));
          return configFiles.write(config, configPath);
        },
      );
      mocks.installRecords.mockResolvedValue({ [pluginId]: installRecord });
      mocks.metadata.mockReturnValue({
        index: {
          plugins: claimed
            ? [
                {
                  pluginId: "bridge",
                  rootDir: "/tmp/bridge",
                  startup: { agentHarnesses: [] },
                  contributions: { channels: [pluginId] },
                },
              ]
            : [],
          installRecords: { [pluginId]: installRecord },
        },
        byPluginId: new Map(),
        normalizePluginId: (rawPluginId: string) => rawPluginId,
      });

      const result = await uninstallManagedPlugin({
        pluginId,
        env: { OPENCLAW_STATE_DIR: root },
      });

      expect(mocks.commitRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          nextConfig: {
            channels: {
              ...(claimed ? { [pluginId]: { enabled: true } } : {}),
              unknown: { enabled: true },
            },
            plugins: {
              entries: {
                [pluginId]: { enabled: false },
              },
            },
          },
          nextInstallRecords: {},
        }),
      );
      expect(result.pluginId).toBe(pluginId);
      expect(result.removed).toContain("install record");
    },
  );

  it("resolves a child request to one package owner and removes every sibling policy", async () => {
    const root = tempDirs.make("openclaw-managed-child-uninstall-");
    const configPath = path.join(root, "openclaw.json");
    const installPath = "/tmp/openclaw-managed-linked-pack";
    const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
    mockConfig(
      configPath,
      {
        plugins: {
          allow: ["pack/one", "pack/two", "other"],
          entries: {
            "pack/one": { enabled: true },
            "pack/two": { enabled: false },
            other: { enabled: true },
          },
        },
      },
      "pack-hash",
    );
    mocks.installRecords.mockResolvedValue({ pack: installRecord });
    mocks.metadata.mockReturnValue(
      packageMetadata("pack", { pack: installRecord }, [
        { id: "pack/one", enabled: true },
        { id: "pack/two", enabled: false },
      ]),
    );

    const result = await uninstallManagedPlugin({
      pluginId: "pack/two",
      env: { OPENCLAW_STATE_DIR: root },
    });

    expect(mocks.commitRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        nextInstallRecords: {},
        nextConfig: {
          channels: undefined,
          plugins: {
            allow: ["other"],
            entries: {
              other: { enabled: true },
              "pack/one": { enabled: false },
              "pack/two": { enabled: false },
            },
          },
        },
      }),
    );
    expect(result.pluginId).toBe("pack");
    expect(result.warnings).toContain(
      'Uninstalled package "pack" and all owned plugin entries: pack/one, pack/two.',
    );
  });

  it.each([
    { mode: "keep-files", keepFiles: true, linked: false },
    { mode: "linked", keepFiles: false, linked: true },
    { mode: "remove-files", keepFiles: false, linked: false },
  ])(
    "retains uninstall ownership when runtime drain rejects for $mode",
    async ({ keepFiles, linked }) => {
      const root = await fs.realpath(tempDirs.make("uninstall-runtime-refusal-"));
      const configPath = path.join(root, "openclaw.json");
      const configFiles = createTestConfigFileStore();
      const sourcePath = path.join(root, "source");
      const installPath = linked ? sourcePath : path.join(root, "extensions", "demo");
      await fs.mkdir(installPath, { recursive: true });
      await fs.writeFile(path.join(installPath, "index.js"), "export default {};\n");
      const installRecord = { source: "path" as const, sourcePath, installPath };
      let records: Record<string, PluginInstallRecord> = { demo: installRecord };
      let config: OpenClawConfig = {
        plugins: { entries: { demo: { enabled: true } }, load: { paths: [installPath] } },
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      mockConfig(configPath, () => config, "current");
      mocks.installRecords.mockImplementation(async () => records);
      mocks.replaceConfig.mockImplementation(
        async ({ sourceConfig }: { sourceConfig: OpenClawConfig }) => {
          config = sourceConfig;
          await fs.writeFile(configPath, JSON.stringify(config));
          return {
            ...configFiles.write(config, configPath),
            persistedHash: "disabled",
            persistedSourceConfig: config,
          };
        },
      );
      mocks.commitRecords.mockImplementation(
        async ({
          nextConfig,
          nextInstallRecords,
          writeOptions,
        }: Parameters<
          typeof import("./install-record-commit.js").commitPluginInstallRecordsWithConfig
        >[0]) => {
          config = nextConfig;
          records = nextInstallRecords;
          await fs.writeFile(configPath, JSON.stringify(config));
          const afterWrite = writeOptions?.afterWrite ?? { mode: "auto" as const };
          return {
            configWrite: {
              ...configFiles.write(config, configPath),
              persistedHash: "removed",
              persistedSourceConfig: config,
              afterWrite,
              followUp: resolveConfigWriteFollowUp(afterWrite),
            },
          };
        },
      );
      mocks.metadata.mockImplementation(() =>
        packageMetadata(
          "demo",
          records,
          records.demo
            ? [
                {
                  id: "demo",
                  enabled: config.plugins?.entries?.demo?.enabled,
                  source: path.join(installPath, "index.js"),
                },
              ]
            : [],
        ),
      );
      const failure = new Error("synthetic runtime replacement refused");
      let reject = true;
      let generation = 0;
      const applyRuntime = vi.fn<
        NonNullable<Parameters<typeof uninstallManagedPlugin>[0]["applyRuntime"]>
      >(async () => {
        if (reject) {
          throw failure;
        }
        return { operationId: "uninstall", generation: ++generation, pluginIds: ["demo"] };
      });
      const request = {
        pluginId: "demo",
        keepFiles,
        env: { OPENCLAW_STATE_DIR: root },
        applyRuntime,
      };
      await expect(uninstallManagedPlugin(request)).rejects.toBe(failure);
      expect(config.plugins?.entries?.demo?.enabled).toBe(false);
      expect(records.demo).toEqual(installRecord);
      expect(mocks.commitRecords).not.toHaveBeenCalled();
      expect((await fs.stat(installPath)).isDirectory()).toBe(true);

      reject = false;
      const result = await uninstallManagedPlugin(request);
      expect(result.pluginId).toBe("demo");
      expect(records.demo).toBeUndefined();
      expect(config.plugins?.entries?.demo?.enabled).toBe(false);
      expect(config.plugins?.load?.paths ?? []).not.toContain(installPath);
      expect(mocks.commitRecords).toHaveBeenCalledOnce();
      if (keepFiles || linked) {
        expect((await fs.stat(installPath)).isDirectory()).toBe(true);
      } else {
        await expect(fs.stat(installPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("keeps config readable after removing an aliased package and preserves intervening edits", async () => {
    const root = await fs.realpath(tempDirs.make("openclaw-managed-uninstall-alias-"));
    const configPath = path.join(root, "openclaw.json");
    const configFiles = createTestConfigFileStore();
    const sourcePath = path.join(root, "source");
    const installPath = path.join(root, "extensions", "demo");
    const aliasPath = path.join(root, "alias");
    const unrelatedPath = path.join(root, "unrelated");
    const addedPath = path.join(root, "added");
    await Promise.all(
      [sourcePath, installPath, unrelatedPath, addedPath].map((dir) =>
        fs.mkdir(dir, { recursive: true }),
      ),
    );
    await fs.symlink(installPath, aliasPath, "dir");
    const installRecord = { source: "path" as const, sourcePath, installPath };
    let currentConfig: OpenClawConfig = {
      plugins: {
        entries: { demo: { enabled: true } },
        load: { paths: [aliasPath, unrelatedPath] },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(currentConfig));
    mocks.readConfig.mockImplementation(async () => {
      for (const loadPath of currentConfig.plugins?.load?.paths ?? []) {
        await fs.stat(loadPath);
      }
      return {
        snapshot: {
          valid: true,
          parsed: currentConfig,
          path: configPath,
          sourceConfig: currentConfig,
          hash: "current-hash",
        },
        writeOptions: { expectedConfigPath: configPath },
      };
    });
    mocks.replaceConfig.mockImplementation(
      async ({ sourceConfig }: { sourceConfig: OpenClawConfig }) => {
        expect(sourceConfig.plugins?.load?.paths).toEqual([unrelatedPath]);
        currentConfig = {
          ...sourceConfig,
          logging: { level: "debug" },
          plugins: { ...sourceConfig.plugins, load: { paths: [unrelatedPath, addedPath] } },
        };
        await fs.writeFile(configPath, JSON.stringify(currentConfig));
        return configFiles.write(currentConfig, configPath);
      },
    );
    mocks.installRecords.mockResolvedValue({ demo: installRecord });
    mocks.metadata.mockReturnValue(
      packageMetadata("demo", { demo: installRecord }, [
        {
          id: "demo",
          enabled: true,
          source: path.join(installPath, "index.js"),
        },
      ]),
    );

    const cleanupWarning = "Previous plugin cleanup failed.";
    const finalApplication = { operationId: "final", generation: 2, pluginIds: ["demo"] };
    const applyRuntime = vi
      .fn()
      .mockResolvedValueOnce({
        operationId: "disable",
        generation: 1,
        pluginIds: ["demo"],
        warnings: [cleanupWarning],
      })
      .mockResolvedValueOnce(finalApplication);
    const result = await uninstallManagedPlugin({
      pluginId: "demo",
      env: { OPENCLAW_STATE_DIR: root },
      applyRuntime,
    });

    expect(result.application).toEqual({ ...finalApplication, warnings: [cleanupWarning] });
    expect(result.warnings).toContain(cleanupWarning);
    expect(result.removed).toContain("load path");
    expect(mocks.commitRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        nextInstallRecords: {},
        nextConfig: expect.objectContaining({
          logging: { level: "debug" },
          plugins: {
            entries: { demo: { enabled: false } },
            load: { paths: [unrelatedPath, addedPath] },
          },
        }),
      }),
    );
    await expect(fs.stat(installPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(sourcePath)).isDirectory()).toBe(true);
  });
});
