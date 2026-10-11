import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../test/helpers/sqlite-parent-observer.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-reader.js";
import {
  RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
  RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON,
  RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
} from "../plugins/managed-npm-retention-contract.js";
import {
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "../plugins/managed-npm-retention.js";
import { getProcessPluginCache } from "../plugins/plugin-cache.js";
import { PLUGIN_LIFECYCLE_LEASE_IDENTITY } from "../plugins/plugin-lifecycle-lease-identity.js";
import * as metadataState from "../plugins/plugin-metadata-state-worker.js";
import {
  createPluginNativeCaptureRoot,
  retainPluginNativeCapturePath,
} from "../plugins/plugin-source-capture-directory.js";
import { resolvePluginSourceCapturesDirectory } from "../plugins/plugin-source-capture-path.js";
import {
  createInstalledPluginIndex,
  seedInstalledPluginIndex,
} from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupGatewayRetiredPluginArtifacts } from "./server-retained-plugin-cleanup.js";

it.each(["empty", "state", "temporary"] as const)(
  "leaves shared state and hot metadata untouched with only %s captures",
  async (placement) => {
    await withOpenClawTestState({ label: "gateway-retained-plugin-empty" }, async (state) => {
      const database = openOpenClawStateDatabase({ env: state.env });
      loadInstalledPluginIndexInstallRecordsSync();
      const cache = getProcessPluginCache();
      const fact = cache.persistedInstalledIndex.get(database.path);
      expect(fact).toBeDefined();
      const capture =
        placement === "empty"
          ? undefined
          : createPluginNativeCaptureRoot(state.stateDir, placement);
      const witness = new DatabaseSync(database.path, { readOnly: true });
      const version = () => witness.prepare("PRAGMA data_version").get()?.data_version;
      const before = version();
      const log = { info: vi.fn(), warn: vi.fn() };
      const observer = observeParentSqlite();
      try {
        try {
          await cleanupGatewayRetiredPluginArtifacts({
            log,
            startupInstallPaths: [],
            signal: new AbortController().signal,
            assertCurrent: () => {},
          });
          expect(observer.counts).toEqual(emptySqliteCounts());
        } finally {
          observer.restore();
        }
        expect(version()).toBe(before);
        expect(cache.persistedInstalledIndex.get(database.path)).toBe(fact);
        expect(log.info).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalled();
      } finally {
        witness.close();
        await capture?.disposeAsync();
      }
    });
  },
);

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
          reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
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
      const reads = vi.spyOn(metadataState, "readPluginMetadataStateRow");
      try {
        await cleanupGatewayRetiredPluginArtifacts({
          log,
          startupInstallPaths,
          signal: new AbortController().signal,
          assertCurrent: () => {},
        });
        expect(observer.counts).toEqual(emptySqliteCounts());
        expect(reads).toHaveBeenCalledTimes(1);
      } finally {
        observer.restore();
        reads.mockRestore();
      }

      expect(loadInstalledPluginIndexInstallRecordsSync()["obsolete-plugin"]?.installPath).toBe(
        obsoletePackage,
      );
      expect(fs.existsSync(startupPackage)).toBe(true);
      expect(fs.existsSync(desiredPackage)).toBe(true);
      expect(fs.existsSync(obsoletePackage)).toBe(false);
      expect(log.info).toHaveBeenCalledWith("cleaned 1 retained npm plugin generation(s)");
      expect(log.warn).not.toHaveBeenCalled();
    });
  },
);

it("runs the Gateway cleanup owner across invalid and staged markers", async () => {
  await withOpenClawTestState(
    { label: "gateway-retained-plugin-cleanup-boundary" },
    async (state) => {
      const invalidPackageDir = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "@openclaw/invalid-plugin",
        pluginId: "invalid-plugin",
        version: "1.0.0",
      });
      await markRetainedManagedNpmInstall({
        packageDir: invalidPackageDir,
        pluginId: "invalid-plugin",
        reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
      });
      fs.writeFileSync(resolveRetainedManagedNpmInstallMarkerPath(invalidPackageDir), "{", "utf8");

      const stagedPackageDir = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "@openclaw/codex",
        pluginId: "codex",
        version: "1.0.0",
      });
      await markRetainedManagedNpmInstall({
        packageDir: stagedPackageDir,
        pluginId: "codex",
        reason: RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON,
      });
      const log = { info: vi.fn(), warn: vi.fn() };

      await cleanupGatewayRetiredPluginArtifacts({
        log,
        startupInstallPaths: [],
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });

      expect(fs.existsSync(invalidPackageDir)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(invalidPackageDir)).toBe(true);
      expect(fs.existsSync(stagedPackageDir)).toBe(false);
      expect(log.warn).toHaveBeenCalledOnce();
      expect(log.info).toHaveBeenCalledWith("cleaned 1 retained npm plugin generation(s)");
    },
  );
});

// Root bypasses mode bits, so chmod cannot model an unreadable marker there.
it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "warns when a legacy retained marker cannot be read",
  async () => {
    await withOpenClawTestState(
      { label: "gateway-retained-plugin-cleanup-access-error" },
      async (state) => {
        const packageDir = writeManagedNpmPlugin({
          stateDir: state.stateDir,
          packageName: "@openclaw/inaccessible-plugin",
          pluginId: "inaccessible-plugin",
          version: "1.0.0",
          layout: "legacy",
        });
        await markRetainedManagedNpmInstall({
          packageDir,
          pluginId: "inaccessible-plugin",
          reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
        });
        const markerPath = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
        const markerDir = path.dirname(markerPath);
        const log = { info: vi.fn(), warn: vi.fn() };
        fs.chmodSync(markerDir, 0o000);

        try {
          await cleanupGatewayRetiredPluginArtifacts({
            log,
            startupInstallPaths: [],
            signal: new AbortController().signal,
            assertCurrent: () => {},
          });
        } finally {
          fs.chmodSync(markerDir, 0o700);
        }

        expect(fs.existsSync(packageDir)).toBe(true);
        expect(fs.existsSync(markerPath)).toBe(true);
        expect(log.info).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledOnce();
        // Candidate discovery refuses unreadable roots before admitting the cleanup lease.
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringMatching(/^retired plugin cleanup unavailable: Error: (?:EACCES|EPERM):/),
        );
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(markerDir));
      },
    );
  },
);

it.each([false, true])(
  "checks partially retained native roots without losing malformed receipt protection (%s)",
  async (malformed) => {
    await withOpenClawTestState({ label: "gateway-retained-native-mixed" }, async (state) => {
      const retained = createPluginNativeCaptureRoot(state.stateDir);
      const orphan = createPluginNativeCaptureRoot(state.stateDir);
      const retainedFile = path.join(retained.directory, "retained.node");
      const orphanFile = path.join(orphan.directory, "orphan.node");
      fs.writeFileSync(retainedFile, "synthetic retained native artifact");
      fs.writeFileSync(orphanFile, "synthetic orphan native artifact");
      retained.commit();
      orphan.commit();
      const release = retainPluginNativeCapturePath(retainedFile);
      await retained.disposeAsync();
      await orphan.disposeAsync();
      const live = createPluginNativeCaptureRoot(state.stateDir);
      const liveFile = path.join(live.directory, "live.node");
      fs.writeFileSync(liveFile, "synthetic live native artifact");
      await seedInstalledPluginIndex({}, { env: state.env, candidates: [] });
      if (malformed) {
        const plugin = createInstalledPluginIndex().plugins[0];
        runOpenClawStateWriteTransaction(({ db }) => {
          db.prepare(
            "UPDATE config_machine_state SET value_json = json_set(value_json, '$.index.plugins', json(?)) WHERE state_key = 'plugins.installedIndex'",
          ).run(JSON.stringify([{ ...plugin, sourceAdmissions: { malformed: true } }]));
        });
      }
      const log = { info: vi.fn(), warn: vi.fn() };
      const reads = vi.spyOn(metadataState, "readPluginMetadataStateRow");
      try {
        await cleanupGatewayRetiredPluginArtifacts({
          log,
          startupInstallPaths: [],
          signal: new AbortController().signal,
          assertCurrent: () => {},
        });
        expect(reads).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(retainedFile, "utf8")).toBe("synthetic retained native artifact");
        expect(fs.readFileSync(liveFile, "utf8")).toBe("synthetic live native artifact");
        expect(fs.existsSync(orphanFile)).toBe(malformed);
        if (malformed) {
          expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining("Plugin native admission receipts are invalid"),
          );
        } else {
          expect(log.warn).not.toHaveBeenCalled();
        }
      } finally {
        reads.mockRestore();
        release();
        await live.disposeAsync();
      }
    });
  },
);

it("reports an unreadable candidate root instead of declaring cleanup empty", async () => {
  await withOpenClawTestState({ label: "gateway-retained-plugin-unreadable" }, async (state) => {
    const root = resolvePluginSourceCapturesDirectory(state.stateDir);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.writeFileSync(root, "synthetic non-directory capture root");
    const log = { info: vi.fn(), warn: vi.fn() };
    await cleanupGatewayRetiredPluginArtifacts({
      log,
      startupInstallPaths: [],
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("retired plugin cleanup unavailable"),
    );
    expect(fs.readFileSync(root, "utf8")).toBe("synthetic non-directory capture root");
  });
});

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
        reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
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
