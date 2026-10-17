import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import {
  capturePluginPackageUpdateSnapshot,
  pluginPackageUpdateMayMutateConfig,
  reconcilePluginPackageUpdateConfig,
} from "./plugin-package-update.js";

type Contributions = { channels?: string[]; channelConfigs?: string[] };
function record(
  pluginId: string,
  rootDir: string,
  contributions: Contributions = {},
  installOwner = "pack",
): InstalledPluginIndexRecord {
  return recordInstalledPluginIndexInstallOwner(
    {
      pluginId,
      manifestPath: `${rootDir}/openclaw.plugin.json`,
      manifestHash: pluginId,
      source: `${rootDir}/${pluginId.split("/").at(-1)}.js`,
      rootDir,
      origin: "global",
      enabled: true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      contributions: {
        channels: contributions.channels ?? [],
        channelConfigs: contributions.channelConfigs ?? [],
        providers: [],
        modelCatalogProviders: [],
        modelSupportPrefixes: [],
        modelSupportPatterns: [],
        autoEnableProviderIds: [],
        commandAliases: [],
        contracts: {},
      },
      compat: [],
    },
    installOwner,
  );
}

function install(installPath: string, spec = "@openclaw/pack@latest") {
  return { source: "npm" as const, installPath, spec };
}

function index(
  rootDir: string,
  children: Record<string, Contributions>,
  installOwner = "pack",
  installs: InstalledPluginIndex["installRecords"] = { [installOwner]: install(rootDir) },
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: installs,
    plugins: Object.entries(children).map(([id, contributions]) =>
      record(id, rootDir, contributions, installOwner),
    ),
    diagnostics: [],
  };
}

function captureSnapshot(pluginIndex: InstalledPluginIndex, installOwners = ["pack"]) {
  const result = capturePluginPackageUpdateSnapshot({ index: pluginIndex, installOwners });
  assert(result.ok === true);
  return result.value;
}

type UpdateOptions = Partial<
  Pick<
    Parameters<typeof reconcilePluginPackageUpdateConfig>[0],
    "snapshot" | "installOwnerMigrations"
  >
>;
function update(
  beforeIndex: InstalledPluginIndex,
  afterIndex: InstalledPluginIndex,
  config: OpenClawConfig,
  options: UpdateOptions = {},
) {
  return reconcilePluginPackageUpdateConfig({
    beforeIndex,
    afterIndex,
    config,
    ...options,
    snapshot: options.snapshot ?? captureSnapshot(beforeIndex),
  });
}

function updatedConfig(result: ReturnType<typeof update>) {
  assert(result.ok === true);
  return result.config;
}

const enabled = (...names: string[]) =>
  Object.fromEntries(names.map((name) => [name, { enabled: true }]));

describe("plugin package update policy reconciliation", () => {
  it("removes retired child policy while preserving retained, new, and unrelated state", () => {
    const beforeRoot = "/packages/pack-v1";
    const afterRoot = "/packages/pack-v2";
    const before = index(beforeRoot, {
      "pack/one": { channels: ["shared"] },
      "pack/two": { channels: ["two-channel", "shared"] },
      "pack/old": { channelConfigs: ["old-config"] },
    });
    const after = index(afterRoot, { "pack/one": { channels: ["shared"] }, "pack/renamed": {} });
    const config: OpenClawConfig = {
      plugins: {
        allow: ["pack/one", "pack/two", "pack/old", "other"],
        deny: ["pack/two", "pack/old", "other-denied"],
        entries: { ...enabled("pack/one", "pack/old", "other"), "pack/two": { enabled: false } },
        load: {
          paths: [`${beforeRoot}/two.js`, `${beforeRoot}/old.js`, "/plugins/unrelated.js"],
        },
        slots: { memory: "pack/two", contextEngine: "pack/old" },
      },
      channels: enabled("two-channel", "old-config", "shared", "discord"),
    };

    const result = updatedConfig(update(before, after, config));
    expect(result.plugins).toEqual({
      allow: ["pack/one", "other"],
      deny: ["other-denied"],
      entries: enabled("pack/one", "other"),
      load: { paths: ["/plugins/unrelated.js"] },
    });
    expect(result.channels).toEqual(enabled("shared", "discord"));
  });

  it("fails closed when the replacement package has no authoritative child rows", () => {
    const before = index("/packages/pack-v1", [record("pack/one", "/packages/pack-v1")]);
    const snapshot = captureSnapshot(before);
    const result = reconcilePluginPackageUpdateConfig({
      config: { plugins: { entries: { "pack/one": { enabled: true } } } },
      beforeIndex: before,
      afterIndex: index("/packages/pack-v2", []),
      snapshot,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("skips an exact tombstone while reconciling another package update", () => {
    const orphanRecord = {
      source: "path",
      sourcePath: "/missing/orphan-source",
      installPath: "/missing/orphan-install",
    } as const;
    const beforePack = index("/packages/pack-v1", { "pack/one": {} });
    const afterPack = index("/packages/pack-v2", { "pack/one": {} });
    const before = {
      ...beforePack,
      installRecords: { orphan: orphanRecord, ...beforePack.installRecords },
    };
    const after = {
      ...afterPack,
      installRecords: { orphan: orphanRecord, ...afterPack.installRecords },
    };
    const snapshot = captureSnapshot(before, ["orphan", "pack"]);
    const config = { plugins: { entries: enabled("pack/one") } };

    expect(update(before, after, config, { snapshot })).toEqual({ ok: true, config });
  });

  it("fails closed when a tombstone replacement still has no authoritative child rows", () => {
    const before = index("/packages/pack-v1", {});
    const snapshot = captureSnapshot(before);
    const after = {
      ...index("/packages/pack-v2", {}),
      installRecords: {
        pack: {
          ...before.installRecords.pack!,
          installPath: "/packages/pack-v2",
          version: "2.0.0",
        },
      },
    };

    expect(update(before, after, {}, { snapshot })).toMatchObject({ ok: false });
  });

  it("follows catalog-alias install-owner migrations without pruning QQ config", () => {
    const rootDir = "/packages/qqbot";
    const before = index(rootDir, { qqbot: { channels: ["qqbot"] } }, "qqbot", {
      qqbot: install(rootDir, "@openclaw/qqbot@1.9.0"),
      "openclaw-qqbot": install(`${rootDir}-canonical`, "@tencent-connect/openclaw-qqbot@2.0.1"),
    });
    const after = index(
      `${rootDir}-canonical`,
      { "openclaw-qqbot": { channels: ["qqbot"] } },
      "openclaw-qqbot",
      {
        "openclaw-qqbot": install(`${rootDir}-canonical`, "@tencent-connect/openclaw-qqbot@2.0.3"),
      },
    );
    const snapshot = captureSnapshot(before, ["qqbot"]);
    const qqbotConfig = {
      enabled: true,
      appId: "root-app",
      clientSecret: "root-secret",
      accounts: {
        primary: { appId: "primary-app", clientSecret: "primary-secret" },
        secondary: { appId: "secondary-app", clientSecret: "secondary-secret" },
      },
    };
    const config = {
      channels: { qqbot: qqbotConfig },
      plugins: {
        load: { paths: [rootDir, `${rootDir}/qqbot.js`, "/plugins/unrelated.js"] },
      },
    } satisfies OpenClawConfig;
    const missingMigration = update(before, after, config, { snapshot });
    assert(missingMigration.ok === false);
    expect(missingMigration.error).toContain(
      'Plugin "qqbot" is not associated with a tracked package install',
    );
    const migrated = updatedConfig(
      update(before, after, config, {
        snapshot,
        installOwnerMigrations: { qqbot: "openclaw-qqbot" },
      }),
    );
    expect(migrated.channels?.qqbot).toEqual(qqbotConfig);
    expect(migrated.plugins?.load?.paths).toEqual(["/plugins/unrelated.js"]);
  });

  it("keeps a shared package root while removing a retired child entry path", () => {
    const rootDir = "/packages/shared-pack";
    const before = index(rootDir, { "pack/one": {}, "pack/old": {} });
    const after = index(rootDir, { "pack/one": {} });
    const result = updatedConfig(
      update(before, after, {
        plugins: {
          load: { paths: [rootDir, `${rootDir}/old.js`, "/plugins/unrelated.js"] },
        },
      }),
    );
    expect(result.plugins?.load?.paths).toEqual([rootDir, "/plugins/unrelated.js"]);
  });

  it("detects exact entry load-path cleanup before an update starts", () => {
    const rootDir = "/packages/pack-v1";
    const before = index(rootDir, { "pack/one": {} });
    const snapshot = captureSnapshot(before);
    expect(
      pluginPackageUpdateMayMutateConfig({
        config: {
          plugins: { load: { paths: [`${rootDir}/one.js`] } },
        },
        index: before,
        snapshot,
      }),
    ).toBe(true);
  });
});
