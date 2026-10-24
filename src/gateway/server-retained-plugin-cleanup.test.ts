import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as sqlite from "../../test/helpers/sqlite-parent-observer.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-reader.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "../plugins/managed-npm-retention-contract.js";
import * as retention from "../plugins/managed-npm-retention.js";
import { markRetainedManagedNpmInstall as markInstall } from "../plugins/managed-npm-retention.js";
import { getProcessPluginCache } from "../plugins/plugin-cache.js";
import { PLUGIN_LIFECYCLE_LEASE_IDENTITY } from "../plugins/plugin-lifecycle-lease-identity.js";
import * as metadataState from "../plugins/plugin-metadata-state-worker.js";
import * as captures from "../plugins/plugin-source-capture-directory.js";
import { resolvePluginSourceCapturesDirectory } from "../plugins/plugin-source-capture-path.js";
import * as index from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { openOpenClawStateDatabase as openState } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { cleanupGatewayRetiredPluginArtifacts } from "./server-retained-plugin-cleanup.js";

const makeLog = () => ({ info: vi.fn(), warn: vi.fn() });
type Fixture = { state: OpenClawTestState; log: ReturnType<typeof makeLog> };
const withFixture =
  <T extends unknown[]>(run: (fixture: Fixture, ...args: T) => Promise<void>) =>
  (...args: T) =>
    withOpenClawTestState({ label: "retained-plugin-cleanup" }, (state) =>
      run({ state, log: makeLog() }, ...args),
    );
function expectWarning(log: ReturnType<typeof makeLog>, message?: string) {
  if (message) {
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(message));
  } else {
    expect(log.warn).not.toHaveBeenCalled();
  }
}
function replaceIndexField(field: string, value: unknown) {
  stateDb.runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      "UPDATE config_machine_state SET value_json = json_set(value_json, ?, json(?)) WHERE state_key = 'plugins.installedIndex'",
    ).run(`$.index.${field}`, JSON.stringify(value));
  });
}
const installRecord = (id: string, installPath: string) => ({
  [id]: { source: "npm" as const, spec: `@openclaw/${id}`, installPath },
});
async function withoutParentSqlite(run: () => Promise<void>) {
  const observer = sqlite.observeParentSqlite();
  try {
    await run();
    expect(observer.counts).toEqual(sqlite.emptySqliteCounts());
  } finally {
    observer.restore();
  }
}
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
  markInstall({ packageDir, pluginId: path.basename(packageDir), reason });
function nativeCapture(stateDir: string, name: string) {
  const capture = captures.createPluginNativeCaptureRoot(stateDir);
  const file = path.join(capture.directory, `${name}.node`);
  fs.writeFileSync(file, `synthetic ${name}`);
  return { capture, file };
}

it(
  "leaves shared state and hot metadata untouched with only state captures",
  withFixture(async ({ state, log }) => {
    const database = openState({ env: state.env });
    loadInstalledPluginIndexInstallRecordsSync();
    const cache = getProcessPluginCache();
    const fact = cache.persistedInstalledIndex.get(database.path);
    expect(fact).toBeDefined();
    const capture = captures.createPluginNativeCaptureRoot(state.stateDir, "state");
    const witness = new DatabaseSync(database.path, { readOnly: true });
    const version = () => witness.prepare("PRAGMA data_version").get()?.data_version;
    const before = version();
    try {
      await withoutParentSqlite(() => cleanup(log));
      expect(version()).toBe(before);
      expect(cache.persistedInstalledIndex.get(database.path)).toBe(fact);
      expect(log.info).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      witness.close();
      await capture.disposeAsync();
    }
  }),
);

it.each([
  ["project", false],
  ["project", true],
  ["legacy", false],
  ["legacy", true],
] as const)(
  "preserves uninstalled %s package files when its marker is malformed: %s",
  withFixture(async ({ state, log }, layout: "project" | "legacy", malformed: boolean) => {
    const packageDir = writePlugin(state.stateDir, "kept", layout);
    await markRetained(packageDir, RETAINED_MANAGED_NPM_KEEP_FILES_REASON);
    if (malformed) {
      fs.writeFileSync(
        retention.resolveRetainedManagedNpmInstallMarkerPath(packageDir),
        '{"reason":',
      );
    }
    await cleanup(log);

    expect(fs.existsSync(packageDir)).toBe(true);
    expect(retention.hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
    expect(log.info).not.toHaveBeenCalled();
    expectWarning(log, malformed ? "retired plugin cleanup unavailable" : undefined);
  }),
);

it.each(["project", "legacy"] as const)(
  "refreshes %s cleanup records without caller-thread SQLite and protects live packages",
  withFixture(async ({ state, log }, layout: "project" | "legacy") => {
    const startup = writePlugin(state.stateDir, "startup", layout);
    const desired = writePlugin(state.stateDir, "desired", layout);
    const obsolete = writePlugin(state.stateDir, "obsolete", layout);
    const startupInstallPaths = [path.join(startup, "dist", "index.js")];
    await index.seedInstalledPluginIndex(installRecord("obsolete", obsolete), {
      env: state.env,
      candidates: [],
    });
    for (const packageDir of [startup, desired, obsolete]) {
      await markRetained(packageDir);
    }
    expect(loadInstalledPluginIndexInstallRecordsSync()["obsolete"]?.installPath).toBe(obsolete);
    // Advance the durable ledger without publishing the install-record cache.
    replaceIndexField("installRecords", installRecord("desired", desired));
    {
      using reads = vi.spyOn(metadataState, "readPluginMetadataStateRow");
      await withoutParentSqlite(() => cleanup(log, startupInstallPaths));
      expect(reads).toHaveBeenCalledTimes(1);
    }

    expect(loadInstalledPluginIndexInstallRecordsSync()["obsolete"]?.installPath).toBe(obsolete);
    expect(fs.existsSync(startup)).toBe(true);
    expect(fs.existsSync(desired)).toBe(true);
    expect(fs.existsSync(obsolete)).toBe(false);
    expect(log.info).toHaveBeenCalledWith("cleaned 1 retained npm plugin generation(s)");
    expect(log.warn).not.toHaveBeenCalled();
  }),
);

it.each([false, true])(
  "checks partially retained native roots without losing malformed receipt protection (%s)",
  withFixture(async ({ state, log }, malformed: boolean) => {
    const { capture: retained, file: retainedFile } = nativeCapture(state.stateDir, "retained");
    const { capture: orphan, file: orphanFile } = nativeCapture(state.stateDir, "orphan");
    retained.commit();
    orphan.commit();
    const release = captures.retainPluginNativeCapturePath(retainedFile);
    await retained.disposeAsync();
    await orphan.disposeAsync();
    const { capture: live, file: liveFile } = nativeCapture(state.stateDir, "live");
    await index.seedInstalledPluginIndex({}, { env: state.env, candidates: [] });
    if (malformed) {
      const plugin = index.createInstalledPluginIndex().plugins[0];
      replaceIndexField("plugins", [{ ...plugin, sourceAdmissions: { malformed: true } }]);
    }
    try {
      using reads = vi.spyOn(metadataState, "readPluginMetadataStateRow");
      await cleanup(log);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(retainedFile, "utf8")).toBe("synthetic retained");
      expect(fs.readFileSync(liveFile, "utf8")).toBe("synthetic live");
      expect(fs.existsSync(orphanFile)).toBe(malformed);
      expectWarning(log, malformed ? "Plugin native admission receipts are invalid" : undefined);
    } finally {
      release();
      await live.disposeAsync();
    }
  }),
);

it(
  "reports an unreadable candidate root instead of declaring cleanup empty",
  withFixture(async ({ state, log }) => {
    const root = resolvePluginSourceCapturesDirectory(state.stateDir);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.writeFileSync(root, "not a directory");
    await cleanup(log);
    expectWarning(log, "retired plugin cleanup unavailable");
    expect(fs.readFileSync(root, "utf8")).toBe("not a directory");
  }),
);

it.each(["lease", "caller"] as const)(
  "preserves native and npm artifacts when %s authority is revoked during inventory read",
  withFixture(async ({ state, log }, revocation: "lease" | "caller") => {
    const packageDir = writePlugin(state.stateDir, "retired");
    await markRetained(packageDir);
    const { capture, file: capturedFile } = nativeCapture(state.stateDir, "retired");
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
            openState({ env: state.env })
              .db.prepare(
                "UPDATE state_leases SET expires_at = 0 WHERE scope = ? AND lease_key = ?",
              )
              .run(PLUGIN_LIFECYCLE_LEASE_IDENTITY.scope, PLUGIN_LIFECYCLE_LEASE_IDENTITY.key);
          }
        }
        return result;
      });
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
      expect(fs.readFileSync(capturedFile, "utf8")).toBe("synthetic retired");
      expect(fs.existsSync(packageDir)).toBe(true);
    } finally {
      inspection.mockRestore();
    }
  }),
);
