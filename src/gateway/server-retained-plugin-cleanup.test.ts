import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const makeLog = () => ({ info: vi.fn(), warn: vi.fn() });
const cleanup = (
  log: ReturnType<typeof makeLog>,
  startupInstallPaths: string[] = [],
  assertCurrent = () => {},
) =>
  cleanupGatewayRetiredPluginArtifacts({
    log,
    startupInstallPaths,
    assertCurrent,
    signal: new AbortController().signal,
  });
const writePlugin = (
  stateDir: string,
  pluginId: string,
  layout: "project" | "legacy" = "project",
) =>
  writeManagedNpmPlugin({
    stateDir,
    packageName: `@openclaw/${pluginId}`,
    pluginId,
    version: "1.0.0",
    layout,
  });
const markRetained = (packageDir: string, reason = "replaced-plugin-generation") =>
  markRetainedManagedNpmInstall({ packageDir, pluginId: path.basename(packageDir), reason });
function nativeCapture(
  stateDir: string,
  name: string,
  contents = `synthetic ${name} native artifact`,
) {
  const capture = createPluginNativeCaptureRoot(stateDir);
  const file = path.join(capture.directory, `${name}.node`);
  fs.writeFileSync(file, contents);
  return { capture, file };
}

it("leaves shared state and hot metadata untouched with only state captures", async () => {
  await withOpenClawTestState({ label: "gateway-retained-plugin-empty" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    loadInstalledPluginIndexInstallRecordsSync();
    const cache = getProcessPluginCache();
    const fact = cache.persistedInstalledIndex.get(database.path);
    expect(fact).toBeDefined();
    const capture = createPluginNativeCaptureRoot(state.stateDir, "state");
    const witness = new DatabaseSync(database.path, { readOnly: true });
    const version = () => witness.prepare("PRAGMA data_version").get()?.data_version;
    const before = version();
    const log = makeLog();
    const observer = observeParentSqlite();
    try {
      try {
        await cleanup(log);
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
      await capture.disposeAsync();
    }
  });
});

it.each([
  ["project", false],
  ["project", true],
  ["legacy", false],
  ["legacy", true],
] as const)(
  "preserves uninstalled %s package files when its marker is malformed: %s",
  async (layout, malformed) => {
    await withOpenClawTestState({ label: "gateway-retained-plugin-cleanup" }, async (state) => {
      const packageDir = writePlugin(state.stateDir, "kept-plugin", layout);
      await markRetained(packageDir, RETAINED_MANAGED_NPM_KEEP_FILES_REASON);
      if (malformed) {
        fs.writeFileSync(resolveRetainedManagedNpmInstallMarkerPath(packageDir), '{"reason":');
      }
      const log = makeLog();
      await cleanup(log);

      expect(fs.existsSync(packageDir)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
      expect(log.info).not.toHaveBeenCalled();
      if (malformed) {
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringContaining("retired plugin cleanup unavailable"),
        );
      } else {
        expect(log.warn).not.toHaveBeenCalled();
      }
    });
  },
);

it.each(["project", "legacy"] as const)(
  "refreshes %s cleanup records without caller-thread SQLite and protects live packages",
  async (layout) => {
    await withOpenClawTestState({ label: "gateway-retained-plugin-update" }, async (state) => {
      const startupPackage = writePlugin(state.stateDir, "startup-plugin", layout);
      const desiredPackage = writePlugin(state.stateDir, "desired-plugin", layout);
      const obsoletePackage = writePlugin(state.stateDir, "obsolete-plugin", layout);
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
        await markRetained(packageDir);
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
      const log = makeLog();
      const observer = observeParentSqlite();
      const reads = vi.spyOn(metadataState, "readPluginMetadataStateRow");
      try {
        await cleanup(log, startupInstallPaths);
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

it.each([false, true])(
  "checks partially retained native roots without losing malformed receipt protection (%s)",
  async (malformed) => {
    await withOpenClawTestState({ label: "gateway-retained-native-mixed" }, async (state) => {
      const { capture: retained, file: retainedFile } = nativeCapture(state.stateDir, "retained");
      const { capture: orphan, file: orphanFile } = nativeCapture(state.stateDir, "orphan");
      retained.commit();
      orphan.commit();
      const release = retainPluginNativeCapturePath(retainedFile);
      await retained.disposeAsync();
      await orphan.disposeAsync();
      const { capture: live, file: liveFile } = nativeCapture(state.stateDir, "live");
      await seedInstalledPluginIndex({}, { env: state.env, candidates: [] });
      if (malformed) {
        const plugin = createInstalledPluginIndex().plugins[0];
        runOpenClawStateWriteTransaction(({ db }) => {
          db.prepare(
            "UPDATE config_machine_state SET value_json = json_set(value_json, '$.index.plugins', json(?)) WHERE state_key = 'plugins.installedIndex'",
          ).run(JSON.stringify([{ ...plugin, sourceAdmissions: { malformed: true } }]));
        });
      }
      const log = makeLog();
      const reads = vi.spyOn(metadataState, "readPluginMetadataStateRow");
      try {
        await cleanup(log);
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
    const log = makeLog();
    await cleanup(log);
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
      const packageDir = writePlugin(state.stateDir, "retired");
      await markRetained(packageDir);
      const { capture, file: capturedFile } = nativeCapture(
        state.stateDir,
        "retired",
        "synthetic retained native artifact",
      );
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
      const log = makeLog();
      try {
        const pending = cleanup(log, [], () => {
          if (!current) {
            throw refused;
          }
        });
        if (revocation === "caller") {
          await expect(pending).rejects.toBe(refused);
        } else {
          await expect(pending).resolves.toBeUndefined();
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
