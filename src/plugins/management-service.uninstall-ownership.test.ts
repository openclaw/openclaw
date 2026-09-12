import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import { resolvePluginPackageUninstallPlan } from "./uninstall-package-plan.js";

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

vi.mock("./install-persistence.js", () => ({
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

vi.mock("./uninstall.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./uninstall.js")>();
  return { ...original, planPluginUninstall: vi.fn(original.planPluginUninstall) };
});

const { listManagedPlugins } = await import("./management-service.js");
const { uninstallManagedPlugin } = await import("./management-uninstall.js");
const { planPluginUninstall } = await import("./uninstall.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin management uninstall channel ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.commitRecords.mockImplementation(
      async ({
        nextConfig,
        writeOptions,
      }: Parameters<
        typeof import("./install-record-commit.js").commitPluginInstallRecordsWithConfig
      >[0]) => ({
        configWrite: {
          path: expectDefined(writeOptions?.expectedConfigPath, "fixture config write path"),
          nextConfig,
          persistedHash: "committed",
          persistedSourceConfig: nextConfig,
        },
      }),
    );
  });

  it.each([
    { label: "a disabled non-channel plugin", enabled: false, channelIds: [] },
    { label: "an enabled non-channel plugin", enabled: true, channelIds: [] },
    {
      label: "a disabled channel plugin",
      enabled: false,
      channelIds: ["owned-channel", "owned-channel-backup"],
    },
    { label: "an enabled channel plugin", enabled: true, channelIds: ["owned-channel"] },
  ])(
    "preserves manifest channel ownership when uninstalling $label",
    async ({ enabled, channelIds }) => {
      const pluginId = "custom-plugin";
      const installPath = "/tmp/openclaw-managed-linked-custom-plugin";
      const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
      const channels = {
        [pluginId]: { enabled: true },
        "owned-channel": { enabled: true },
        "owned-channel-backup": { enabled: true },
        discord: { enabled: true },
      };
      mocks.readConfig.mockResolvedValue({
        snapshot: {
          valid: true,
          parsed: {},
          path: "/tmp/openclaw.json",
          sourceConfig: { plugins: { entries: { [pluginId]: { enabled } } }, channels },
          hash: "base-hash",
        },
        writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
      });
      mocks.installRecords.mockResolvedValue({ [pluginId]: installRecord });
      const manifest = recordPluginManifestInstallOwner(
        { id: pluginId, channels: channelIds },
        pluginId,
      );
      mocks.metadata.mockReturnValue({
        index: {
          plugins: [
            recordInstalledPluginIndexInstallOwner(
              { pluginId, origin: "global", enabled, rootDir: installPath },
              pluginId,
            ),
          ],
          installRecords: { [pluginId]: installRecord },
        },
        byPluginId: new Map([[pluginId, manifest]]),
        normalizePluginId: (rawPluginId: string) => rawPluginId,
      });

      const result = await uninstallManagedPlugin({ pluginId, env: {} });

      const ownedChannelIds = channelIds;
      expect(planPluginUninstall).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId,
          channelIds,
        }),
      );
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
    mocks.readConfig.mockResolvedValue({
      snapshot: {
        valid: true,
        parsed: {},
        path: "/tmp/openclaw.json",
        sourceConfig: { plugins: { entries: { [pluginId]: { enabled: true } } } },
        hash: "base-hash",
      },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
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
    mocks.readConfig.mockResolvedValue({
      snapshot: {
        valid: true,
        parsed: {},
        path: "/tmp/openclaw.json",
        sourceConfig: {},
        hash: "base-hash",
      },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
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
      const pluginId = "orphaned-plugin";
      const installRecord = {
        source: "path",
        sourcePath: "/tmp/missing-orphan-source",
        installPath: "/tmp/missing-orphan-install",
      } as const;
      mocks.readConfig.mockResolvedValue({
        snapshot: {
          valid: true,
          parsed: {},
          path: "/tmp/openclaw.json",
          sourceConfig: {
            plugins: { entries: { [pluginId]: { enabled: true } } },
            channels: { [pluginId]: { enabled: true }, unknown: { enabled: true } },
          },
          hash: "base-hash",
        },
        writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
      });
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

      const result = await uninstallManagedPlugin({ pluginId, env: {} });

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
    const installPath = "/tmp/openclaw-managed-linked-pack";
    const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
    mocks.readConfig.mockResolvedValue({
      snapshot: {
        valid: true,
        parsed: {},
        path: "/tmp/openclaw.json",
        sourceConfig: {
          plugins: {
            allow: ["pack/one", "pack/two", "other"],
            entries: {
              "pack/one": { enabled: true },
              "pack/two": { enabled: false },
              other: { enabled: true },
            },
          },
        },
        hash: "pack-hash",
      },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
    mocks.installRecords.mockResolvedValue({ pack: installRecord });
    const manifests: Array<[string, { id: string; channels: string[] }]> = [
      ["pack/one", recordPluginManifestInstallOwner({ id: "pack/one", channels: [] }, "pack")],
      ["pack/two", recordPluginManifestInstallOwner({ id: "pack/two", channels: [] }, "pack")],
    ];
    mocks.metadata.mockReturnValue({
      index: {
        plugins: [
          recordInstalledPluginIndexInstallOwner(
            {
              pluginId: "pack/one",
              origin: "global",
              enabled: true,
              rootDir: installPath,
            },
            "pack",
          ),
          recordInstalledPluginIndexInstallOwner(
            {
              pluginId: "pack/two",
              origin: "global",
              enabled: false,
              rootDir: installPath,
            },
            "pack",
          ),
        ],
        installRecords: { pack: installRecord },
      },
      byPluginId: new Map(manifests),
      normalizePluginId: (pluginId: string) => pluginId,
    });

    const result = await uninstallManagedPlugin({ pluginId: "pack/two", env: {} });

    expect(planPluginUninstall).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "pack",
      }),
    );
    expect(
      resolvePluginPackageUninstallPlan(vi.mocked(planPluginUninstall).mock.calls[0]![0]),
    ).toEqual({
      runtimePluginIds: ["pack/one", "pack/two"],
      runtimeLoadPaths: [],
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

  it("marks every child removable through its package install owner", async () => {
    const installRecord = {
      source: "path",
      sourcePath: "/tmp/pack",
      installPath: "/tmp/pack",
    };
    const manifests = ["pack/one", "pack/two"].map((id) => ({
      id,
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "global",
      rootDir: "/tmp/pack",
      source: `/tmp/pack/${id.endsWith("one") ? "one" : "two"}.js`,
      manifestPath: "/tmp/pack/openclaw.plugin.json",
    }));
    mocks.metadata.mockReturnValue({
      index: {
        plugins: manifests.map((manifest, index) =>
          recordInstalledPluginIndexInstallOwner(
            {
              pluginId: manifest.id,
              packageName: "@acme/pack",
              origin: "global",
              enabled: index === 0,
              rootDir: "/tmp/pack",
            },
            "pack",
          ),
        ),
        installRecords: { pack: installRecord },
      },
      byPluginId: new Map(manifests.map((manifest) => [manifest.id, manifest])),
      diagnostics: [],
      normalizePluginId: (pluginId: string) => pluginId,
    });

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });

    expect(catalog.plugins.map(({ id, removable }) => ({ id, removable }))).toEqual([
      { id: "pack/one", removable: true },
      { id: "pack/two", removable: true },
    ]);
  });

  it.each([
    { mode: "keep-files", keepFiles: true, linked: false },
    { mode: "linked", keepFiles: false, linked: true },
    { mode: "remove-files", keepFiles: false, linked: false },
  ])(
    "retains uninstall ownership when runtime drain rejects for $mode",
    async ({ keepFiles, linked }) => {
      const root = await fs.realpath(tempDirs.make("uninstall-runtime-refusal-"));
      const sourcePath = path.join(root, "source");
      const installPath = linked ? sourcePath : path.join(root, "extensions", "demo");
      await fs.mkdir(installPath, { recursive: true });
      await fs.writeFile(path.join(installPath, "index.js"), "export default {};\n");
      const installRecord = { source: "path" as const, sourcePath, installPath };
      let records: Record<string, typeof installRecord> = { demo: installRecord };
      let config: OpenClawConfig = {
        plugins: { entries: { demo: { enabled: true } }, load: { paths: [installPath] } },
      };
      mocks.readConfig.mockImplementation(async () => ({
        snapshot: {
          valid: true,
          parsed: config,
          path: path.join(root, "openclaw.json"),
          sourceConfig: config,
          hash: "current",
        },
        writeOptions: { expectedConfigPath: path.join(root, "openclaw.json") },
      }));
      mocks.installRecords.mockImplementation(async () => records);
      mocks.replaceConfig.mockImplementation(
        async ({ sourceConfig }: { sourceConfig: OpenClawConfig }) => {
          config = sourceConfig;
          return { persistedHash: "disabled", persistedSourceConfig: config };
        },
      );
      mocks.commitRecords.mockImplementation(async ({ nextConfig, nextInstallRecords }) => {
        config = nextConfig;
        records = nextInstallRecords;
        return {
          configWrite: {
            path: path.join(root, "openclaw.json"),
            persistedHash: "removed",
            persistedSourceConfig: config,
          },
        };
      });
      mocks.metadata.mockImplementation(() => ({
        index: {
          plugins: records.demo
            ? [
                recordInstalledPluginIndexInstallOwner(
                  {
                    pluginId: "demo",
                    origin: "global",
                    enabled: config.plugins?.entries?.demo?.enabled,
                    rootDir: installPath,
                  },
                  "demo",
                ),
              ]
            : [],
          installRecords: records,
        },
        byPluginId: new Map(
          records.demo
            ? [
                [
                  "demo",
                  recordPluginManifestInstallOwner(
                    {
                      id: "demo",
                      channels: [],
                      source: path.join(installPath, "index.js"),
                    },
                    "demo",
                  ),
                ],
              ]
            : [],
        ),
        normalizePluginId: (id: string) => id,
      }));
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
    mocks.readConfig.mockImplementation(async () => {
      for (const loadPath of currentConfig.plugins?.load?.paths ?? []) {
        await fs.stat(loadPath);
      }
      return {
        snapshot: {
          valid: true,
          parsed: currentConfig,
          path: path.join(root, "openclaw.json"),
          sourceConfig: currentConfig,
          hash: "current-hash",
        },
        writeOptions: { expectedConfigPath: path.join(root, "openclaw.json") },
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
      },
    );
    mocks.installRecords.mockResolvedValue({ demo: installRecord });
    mocks.metadata.mockReturnValue({
      index: {
        plugins: [
          recordInstalledPluginIndexInstallOwner(
            { pluginId: "demo", origin: "global", enabled: true, rootDir: installPath },
            "demo",
          ),
        ],
        installRecords: { demo: installRecord },
      },
      byPluginId: new Map([
        [
          "demo",
          recordPluginManifestInstallOwner(
            { id: "demo", channels: [], source: path.join(installPath, "index.js") },
            "demo",
          ),
        ],
      ]),
      normalizePluginId: (id: string) => id,
    });

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
