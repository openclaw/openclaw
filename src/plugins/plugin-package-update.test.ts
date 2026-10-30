import { assert, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import {
  capturePluginPackageUpdateSnapshot,
  pluginPackageUpdateMayMutateConfig,
  reconcilePluginPackageUpdateConfig,
} from "./plugin-package-update.js";
import { createIndexFixture } from "./test-helpers/installed-plugin-index-fixture.js";

const beforeRoot = "/packages/pack-v1";
const afterRoot = "/packages/pack-v2";
const enabled = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { enabled: true }]));

function record(
  pluginId: string,
  rootDir: string,
  contributions: { channels?: string[]; channelConfigs?: string[] } = {},
  owner = "pack",
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
    owner,
  );
}

function index(rootDir: string, plugins: InstalledPluginIndexRecord[]): InstalledPluginIndex {
  return createIndexFixture({
    installRecords: {
      pack: { source: "npm", installPath: rootDir, spec: "@openclaw/pack@latest" },
    },
    plugins,
  });
}

function captureSnapshot(pluginIndex: InstalledPluginIndex, installOwners = ["pack"]) {
  const result = capturePluginPackageUpdateSnapshot({ index: pluginIndex, installOwners });
  assert(result.ok);
  return result.value;
}

type UpdateParams = Parameters<typeof reconcilePluginPackageUpdateConfig>[0];
function reconcile(
  config: OpenClawConfig,
  beforeIndex: InstalledPluginIndex,
  afterIndex: InstalledPluginIndex,
  options: Partial<Pick<UpdateParams, "snapshot" | "installOwnerMigrations">> = {},
) {
  return reconcilePluginPackageUpdateConfig({
    config,
    beforeIndex,
    afterIndex,
    ...options,
    snapshot: options.snapshot ?? captureSnapshot(beforeIndex),
  });
}

describe("plugin package update policy reconciliation", () => {
  it.each([false, true])(
    "cleans a retired engine unless ownership transferred: %s",
    (transferred) => {
      const before = index(beforeRoot, [
        record("pack/retained", beforeRoot),
        record("pack/retired", beforeRoot),
      ]);
      before.installRecords.pack!.contextEngineIdsByPlugin = { "pack/retired": ["engine"] };
      const retained = record("pack/retained", afterRoot);
      if (transferred) {
        retained.contextEngineIds = ["engine"];
      }
      const after = index(afterRoot, [retained]);
      if (transferred) {
        after.installRecords.pack!.contextEngineIdsByPlugin = { "pack/retained": ["engine"] };
      }
      const result = reconcile(
        {
          plugins: {
            installs: { ...after.installRecords },
            slots: { contextEngine: "engine" },
            entries: { "pack/retired": { enabled: true } },
          },
        },
        before,
        after,
      );
      assert(result.ok);
      expect(result.config.plugins?.entries?.["pack/retired"]).toBeUndefined();
      expect(result.config.plugins?.slots?.contextEngine).toBe(transferred ? "engine" : undefined);
    },
  );

  it.each([beforeRoot, afterRoot])(
    "cleans retired child policy while preserving shared state at %s",
    (nextRoot) => {
      const before = index(beforeRoot, [
        record("pack/one", beforeRoot, { channels: ["shared"] }),
        record("pack/two", beforeRoot, { channels: ["two-channel", "shared"] }),
        record("pack/old", beforeRoot, { channelConfigs: ["old-config"] }),
      ]);
      const after = index(nextRoot, [
        record("pack/one", nextRoot, { channels: ["shared"] }),
        record("pack/renamed", nextRoot),
      ]);
      const config: OpenClawConfig = {
        plugins: {
          allow: ["pack/one", "pack/two", "pack/old", "other"],
          deny: ["pack/two", "pack/old", "other-denied"],
          entries: {
            ...enabled("pack/one", "pack/old", "other"),
            "pack/two": { enabled: false },
          },
          load: {
            paths: [
              beforeRoot,
              `${beforeRoot}/two.js`,
              `${beforeRoot}/old.js`,
              "/plugins/unrelated.js",
            ],
          },
          slots: { memory: "pack/two", contextEngine: "pack/old" },
        },
        channels: enabled("two-channel", "old-config", "shared", "discord"),
      };

      const result = reconcile(config, before, after);
      assert(result.ok);
      expect(result.config.plugins).toEqual({
        allow: ["pack/one", "other"],
        deny: ["other-denied"],
        entries: enabled("pack/one", "other"),
        load: {
          paths: [...(nextRoot === beforeRoot ? [beforeRoot] : []), "/plugins/unrelated.js"],
        },
      });
      expect(result.config.channels).toEqual(enabled("shared", "discord"));
    },
  );

  it.each(["package", "tombstone"])(
    "fails closed when a replacement %s has no authoritative child rows",
    (kind) => {
      const before = index(beforeRoot, kind === "package" ? [record("pack/one", beforeRoot)] : []);
      const result = reconcile(
        { plugins: { entries: { "pack/one": { enabled: true } } } },
        before,
        index(afterRoot, []),
      );
      expect(result).toMatchObject({ ok: false });
    },
  );

  it("skips an exact tombstone while reconciling another package update", () => {
    const orphanRecord = {
      source: "path",
      sourcePath: "/missing/orphan-source",
      installPath: "/missing/orphan-install",
    } as const;
    const beforePack = index(beforeRoot, [record("pack/one", beforeRoot)]);
    const afterPack = index(afterRoot, [record("pack/one", afterRoot)]);
    const before = {
      ...beforePack,
      installRecords: { orphan: orphanRecord, ...beforePack.installRecords },
    };
    const after = {
      ...afterPack,
      installRecords: { orphan: orphanRecord, ...afterPack.installRecords },
    };
    const snapshot = captureSnapshot(before, ["orphan", "pack"]);
    const config = { plugins: { entries: { "pack/one": { enabled: true } } } };

    const result = reconcile(config, before, after, { snapshot });

    expect(result).toEqual({ ok: true, config });
  });

  it("follows catalog-alias install-owner migrations without pruning QQ config", () => {
    const rootDir = "/packages/qqbot";
    const before: InstalledPluginIndex = {
      ...index(rootDir, [record("qqbot", rootDir, { channels: ["qqbot"] }, "qqbot")]),
      installRecords: {
        qqbot: { source: "npm", installPath: rootDir, spec: "@openclaw/qqbot@1.9.0" },
        "openclaw-qqbot": {
          source: "npm",
          installPath: `${rootDir}-canonical`,
          spec: "@tencent-connect/openclaw-qqbot@2.0.1",
        },
      },
    };
    const after: InstalledPluginIndex = {
      ...index(`${rootDir}-canonical`, [
        record("openclaw-qqbot", `${rootDir}-canonical`, { channels: ["qqbot"] }, "openclaw-qqbot"),
      ]),
      installRecords: {
        "openclaw-qqbot": {
          source: "npm",
          installPath: `${rootDir}-canonical`,
          spec: "@tencent-connect/openclaw-qqbot@2.0.3",
        },
      },
    };
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
    const missingMigration = reconcile(config, before, after, { snapshot });
    assert(!missingMigration.ok);
    expect(missingMigration.error).toContain(
      'Plugin "qqbot" is not associated with a tracked package install',
    );
    const migrated = reconcile(config, before, after, {
      snapshot,
      installOwnerMigrations: { qqbot: "openclaw-qqbot" },
    });
    assert(migrated.ok);
    expect(migrated.config.channels?.qqbot).toEqual(qqbotConfig);
    expect(migrated.config.plugins?.load?.paths).toEqual(["/plugins/unrelated.js"]);
  });

  it("detects exact entry load-path cleanup before an update starts", () => {
    const rootDir = "/packages/pack-v1";
    const before = index(rootDir, [record("pack/one", rootDir)]);
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
