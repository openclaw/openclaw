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
import { PLUGIN_LIFECYCLE_LEASE_IDENTITY } from "../plugins/plugin-lifecycle-lease-identity.js";
import * as metadataState from "../plugins/plugin-metadata-state-worker.js";
import { createPluginNativeCaptureRoot } from "../plugins/plugin-source-capture-directory.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupGatewayRetiredPluginArtifacts } from "./server-retained-plugin-cleanup.js";

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

    await cleanupGatewayRetiredPluginArtifacts({
      log,
      startupInstallPaths: [],
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });

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
        await cleanupGatewayRetiredPluginArtifacts({
          log,
          startupInstallPaths,
          signal: new AbortController().signal,
          assertCurrent: () => {},
        });
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

it.each(["lease", "caller"] as const)(
  "preserves native and npm artifacts when %s authority is revoked during inventory read",
  async (revocation) => {
    await withOpenClawTestState({ label: "gateway-retired-plugin-authority" }, async (state) => {
      const packageDir = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "@openclaw/retired",
        pluginId: "retired",
        version: "1.0.0",
      });
      await markRetainedManagedNpmInstall({
        packageDir,
        pluginId: "retired",
        reason: "replaced-plugin-generation",
      });
      const capture = createPluginNativeCaptureRoot(state.stateDir);
      const capturedFile = path.join(capture.directory, "retired.node");
      fs.writeFileSync(capturedFile, "synthetic retained native artifact");
      capture.commit();
      await capture.disposeAsync();
      const read = metadataState.readPluginMetadataStateRow;
      const refused = new Error("cleanup caller retired");
      let current = true;
      let revoked = false;
      const inspection = vi
        .spyOn(metadataState, "readPluginMetadataStateRow")
        .mockImplementation(async (...args) => {
          const result = await read(...args);
          if (!revoked) {
            revoked = true;
            if (revocation === "caller") {
              current = false;
            } else {
              openOpenClawStateDatabase({ env: state.env })
                .db.prepare(
                  "UPDATE state_leases SET expires_at = 0 WHERE scope = ? AND lease_key = ?",
                )
                .run(PLUGIN_LIFECYCLE_LEASE_IDENTITY.scope, PLUGIN_LIFECYCLE_LEASE_IDENTITY.key);
            }
          }
          return result;
        });
      const log = { info: vi.fn(), warn: vi.fn() };
      try {
        const cleanup = cleanupGatewayRetiredPluginArtifacts({
          log,
          startupInstallPaths: [],
          signal: new AbortController().signal,
          assertCurrent: () => {
            if (!current) {
              throw refused;
            }
          },
        });
        if (revocation === "caller") {
          await expect(cleanup).rejects.toBe(refused);
        } else {
          await expect(cleanup).resolves.toBeUndefined();
          expect(log.warn).toHaveBeenCalled();
        }
        expect(revoked).toBe(true);
        expect(fs.readFileSync(capturedFile, "utf8")).toBe("synthetic retained native artifact");
        expect(fs.existsSync(packageDir)).toBe(true);
      } finally {
        inspection.mockRestore();
      }
    });
  },
);
