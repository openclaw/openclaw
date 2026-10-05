import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../test/helpers/sqlite-parent-observer.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-reader.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "../plugins/managed-npm-retention-contract.js";
import {
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
} from "../plugins/managed-npm-retention.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupRetainedPluginInstallGenerations } from "./server-retained-plugin-cleanup.js";

it("preserves package files retained by plugin uninstall", async () => {
  await withOpenClawTestState({ label: "gateway-retained-plugin-cleanup" }, async (state) => {
    const packageDir = writeManagedNpmPlugin({
      stateDir: state.stateDir,
      packageName: "@openclaw/kept-plugin",
      pluginId: "kept-plugin",
      version: "1.0.0",
    });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "kept-plugin",
      reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    await cleanupRetainedPluginInstallGenerations({ log, startupInstallPaths: [] });

    expect(fs.existsSync(packageDir)).toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

it.each(["project", "legacy"] as const)(
  "refreshes %s cleanup records without caller-thread SQLite and protects live packages",
  async (layout) => {
    await withOpenClawTestState({ label: "gateway-retained-plugin-update" }, async (state) => {
      const writePlugin = (pluginId: string) =>
        writeManagedNpmPlugin({
          stateDir: state.stateDir,
          packageName: `@openclaw/${pluginId}`,
          pluginId,
          version: "1.0.0",
          layout,
        });
      const startupPackage = writePlugin("startup-plugin");
      const desiredPackage = writePlugin("desired-plugin");
      const obsoletePackage = writePlugin("obsolete-plugin");
      const startupInstallPaths = [path.join(startupPackage, "dist", "index.js")];
      await seedInstalledPluginIndex(
        {
          "obsolete-plugin": {
            source: "npm",
            spec: "@openclaw/obsolete-plugin",
            installPath: obsoletePackage,
          },
        },
        { env: state.env, candidates: [] },
      );
      for (const packageDir of [startupPackage, desiredPackage, obsoletePackage]) {
        await markRetainedManagedNpmInstall({
          packageDir,
          pluginId: path.basename(packageDir),
          reason: "replaced-plugin-generation",
        });
      }
      expect(loadInstalledPluginIndexInstallRecordsSync()["obsolete-plugin"]?.installPath).toBe(
        obsoletePackage,
      );
      // Advance the durable ledger without publishing the install-record cache.
      runOpenClawStateWriteTransaction(({ db }) => {
        db.prepare(
          "UPDATE config_machine_state SET value_json = json_set(value_json, '$.index.installRecords', json(?)) WHERE state_key = 'plugins.installedIndex'",
        ).run(
          JSON.stringify({
            "desired-plugin": {
              source: "npm",
              spec: "@openclaw/desired-plugin",
              installPath: desiredPackage,
            },
          }),
        );
      });
      const log = { info: vi.fn(), warn: vi.fn() };
      const observer = observeParentSqlite();
      try {
        await cleanupRetainedPluginInstallGenerations({ log, startupInstallPaths });
        expect(observer.counts).toEqual(emptySqliteCounts());
      } finally {
        observer.restore();
      }

      expect(fs.existsSync(startupPackage)).toBe(true);
      expect(fs.existsSync(desiredPackage)).toBe(true);
      expect(fs.existsSync(obsoletePackage)).toBe(false);
      expect(log.info).toHaveBeenCalledWith("cleaned 1 retained npm plugin generation(s)");
      expect(log.warn).not.toHaveBeenCalled();
    });
  },
);
