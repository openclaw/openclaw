import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { withRuntimePreload } from "../../test/helpers/runtime-preload.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import type { DoctorMaintenanceParams } from "../commands/doctor-maintenance-types.js";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { preserveDoctorOriginalState } from "../commands/doctor-original-capture.js";
import * as declarations from "../plugins/doctor-contract-preparation.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { retireIdleOpenClawStateReadWorkers } from "../state/openclaw-state-read-worker.js";
import * as retention from "./doctor-capture-retention.js";
import { findReusableDoctorCapture } from "./doctor-capture-reuse.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import * as snapshots from "./sqlite-snapshot-source.js";
import * as discoveryWorker from "./update-candidate-state.inspection.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import { resolveManagedUpdateLeaseDatabasePath } from "./update-managed-service-handoff-lease.js";
import * as backupReader from "./update-recovery-backup-reader.js";
import { UPDATE_STATE_INSPECTION_PROGRESS_PREFIX } from "./update-state-inspection-protocol.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    // Join the cached broker before removing its TMPDIR socket.
    const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
    expect(await retireIdleOpenClawStateReadWorkers(source)).toBe(true);
    expect(await source.retireIdleBroker()).toBe(true);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

async function fixture() {
  const root = await fs.realpath(dirs.make("doctor-capture-reuse-"));
  const stateDir = path.join(root, "state");
  const temporary = path.join(root, "tmp");
  const plugin = path.join(root, "plugin-data");
  await Promise.all([stateDir, temporary, plugin].map((dir) => fs.mkdir(dir)));
  const config = path.join(stateDir, "openclaw.json");
  await fs.writeFile(config, "{}");
  const file = path.join(plugin, "data.txt");
  await fs.writeFile(file, "before");
  const fixtureEnv = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: config,
    XDG_CACHE_HOME: path.join(root, "cache"),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    OPENCLAW_AGENT_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_UPDATE_IN_PROGRESS: undefined,
    OPENCLAW_UPDATE_RUN_ID: undefined,
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER: undefined,
  };
  for (const [key, value] of Object.entries(fixtureEnv)) {
    vi.stubEnv(key, value);
  }
  expect(resolveManagedUpdateLeaseDatabasePath().startsWith(`${temporary}${path.sep}`)).toBe(true);
  const resources: Array<{ path: string; kind: "file" | "directory" | "sqlite" }> = [
    { path: plugin, kind: "directory" },
  ];
  // Only plugin declarations are synthetic; capture and maintenance are real.
  vi.spyOn(declarations, "preparePluginDoctorMigrationBackupResources").mockImplementation(
    async () => ({ resources, deferredPluginIds: new Set(), notices: [], assertCurrent() {} }),
  );
  const runtime = { log() {}, error() {}, exit() {} };
  const maintain = async (beforeStateMutation: DoctorMaintenanceParams["beforeStateMutation"]) => {
    const maintenance = await beginDoctorMaintenance({
      options: { repair: true, nonInteractive: true },
      root,
      env: { ...process.env },
      runtime,
      beforeStateMutation,
    });
    await maintenance?.release();
  };
  const capture = async (fullIntegrityCheck?: boolean) => {
    let result: Awaited<ReturnType<typeof preserveDoctorOriginalState>> | undefined;
    await maintain(async ({ env, signal }) => {
      result = await preserveDoctorOriginalState({
        fullIntegrityCheck,
        root,
        env,
        runtime,
        signal,
        assertCurrent: getOpenClawDatabaseMaintenanceScope()!.assertAdmission,
      });
    });
    if (!result) {
      throw new Error("Doctor did not enter its admitted original-state capture boundary");
    }
    expect(result.warnings).toEqual([]);
    return captures();
  };
  const captures = async () =>
    (await fs.readdir(resolveUpdateCaptureRoot(stateDir))).filter((name) =>
      name.startsWith("doctor-"),
    );
  const reuse = () =>
    findReusableDoctorCapture({
      stateDir,
      installRoot: root,
      env: { ...process.env },
      assertCurrent() {},
    });
  const capturedFile = async (source: string, sqlite = false) => {
    const ref = await reuse();
    expect(ref).toBeDefined();
    const manifest = parseUpdateRecoveryBackupManifest(
      await fs.readFile(ref!.manifestPath, "utf8"),
    );
    const entry = manifest.entries.find((candidate) => candidate.sourcePath === source);
    if (entry?.kind !== "file" || (sqlite && !entry.sqlite)) {
      throw new Error("Expected captured file");
    }
    return { ref: ref!, payloadPath: path.join(ref!.directory, entry.archivePath) };
  };
  return {
    root,
    stateDir,
    plugin,
    file,
    config,
    resources,
    capture,
    captures,
    reuse,
    maintain,
    capturedFile,
  };
}

it("reuses a sealed standalone baseline only while the complete source is unchanged", async () => {
  const f = await fixture();
  const first = await f.capture();
  expect(first).toHaveLength(1);
  expect(await f.capture()).toEqual(first);
  // Same-size writes with restored mtime are not evidence of equality.
  const stat = await fs.stat(f.file);
  await fs.writeFile(f.file, "after!");
  await fs.utimes(f.file, stat.atime, stat.mtime);
  // A fresh capture replaces the superseded original rather than adding to it.
  const changed = await f.capture();
  expect(changed).toHaveLength(1);
  expect(changed).not.toEqual(first);
  const full = await f.capture(true);
  expect(full, "explicit full integrity verification does not reuse").toHaveLength(1);
  expect(full).not.toEqual(changed);
});

it("captures declared SQLite sidecar roots through their database image and reuses it", async () => {
  const f = await fixture();
  // Mirrors memory-core's legacy index declarations: the database plus every sidecar suffix.
  const legacy = path.join(f.stateDir, "memory", "main.sqlite");
  await fs.mkdir(path.dirname(legacy));
  {
    using db = new DatabaseSync(legacy);
    db.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY); INSERT INTO chunks VALUES (1)");
  }
  const sidecars = ["-wal", "-shm", "-journal"].map((suffix) => `${legacy}${suffix}`);
  f.resources.push(
    { path: legacy, kind: "file" },
    ...sidecars.map((sidecar) => ({ path: sidecar, kind: "file" as const })),
  );
  const first = await f.capture();
  expect(first).toHaveLength(1);
  const { ref } = await f.capturedFile(legacy, true);
  const manifest = parseUpdateRecoveryBackupManifest(await fs.readFile(ref.manifestPath, "utf8"));
  expect(manifest.roots).toContain(legacy);
  expect(manifest.roots.filter((root) => sidecars.includes(root))).toEqual([]);
  expect(await f.capture(), "an unchanged sidecar declaration reuses the baseline").toEqual(first);
});

it("rejects an ineligible retained capture before verifying its payloads", async () => {
  const f = await fixture();
  await f.capture();
  const verifyPayloads = vi.spyOn(backupReader, "withVerifiedUpdateRecoveryBackup");
  const reused = await findReusableDoctorCapture({
    stateDir: f.stateDir,
    installRoot: path.join(f.root, "different-install"),
    env: { ...process.env },
    assertCurrent() {},
  });
  expect(reused).toBeUndefined();
  expect(
    verifyPayloads,
    "an ineligible capture must stream zero payload hashes",
  ).not.toHaveBeenCalled();
});

it("rejects a changed database before hashing retained payloads or imaging current databases", async () => {
  const f = await fixture();
  const file = path.join(f.plugin, "plugin.sqlite");
  {
    using db = new DatabaseSync(file);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('retained')",
    );
  }
  const originals = await f.capture();
  expect(await f.capture(), "an unchanged WAL-mode database is still reused").toEqual(originals);
  const verifyPayloads = vi.spyOn(backupReader, "withVerifiedUpdateRecoveryBackup");
  const imageDatabases = vi.spyOn(discoveryWorker, "runUpdateStateInspectionWorker");
  const expectNoComparison = (reason: string) => {
    expect(verifyPayloads, `${reason}: zero payload hashes`).not.toHaveBeenCalled();
    expect(imageDatabases, `${reason}: no database image`).not.toHaveBeenCalled();
  };
  {
    // A Gateway writing between Doctor runs typically adds pages.
    using db = new DatabaseSync(file);
    db.exec("INSERT INTO payload VALUES(zeroblob(65536))");
  }
  expect(await f.reuse(), "grown database").toBeUndefined();
  expectNoComparison("grown database");

  // The fresh capture replaces the superseded original rather than adding to it.
  const fresh = await f.capture();
  expect(fresh).toHaveLength(1);
  expect(fresh).not.toEqual(originals);
  expect(await f.capture(), "the fresh capture is reusable while unchanged").toEqual(fresh);
  const { payloadPath } = await f.capturedFile(file, true);
  {
    // A database at its steady size: rows change in place, as a lease renewal does.
    using db = new DatabaseSync(file);
    db.exec("UPDATE payload SET value = 'replaced' WHERE value = 'retained'");
  }
  expect((await fs.stat(file)).size).toBe((await fs.stat(payloadPath)).size);
  verifyPayloads.mockClear();
  imageDatabases.mockClear();
  expect(await f.reuse(), "same-size change").toBeUndefined();
  expectNoComparison("same-size page change");
});

it("leaves FULL auto-vacuum databases to the full comparison", async () => {
  const f = await fixture();
  const file = path.join(f.plugin, "plugin.sqlite");
  {
    // Journal normalization may rewrite pages here, so page equality proves nothing.
    using db = new DatabaseSync(file);
    db.exec(
      "PRAGMA auto_vacuum=FULL; CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('retained')",
    );
  }
  const originals = await f.capture();
  expect(await f.capture(), "an unchanged FULL auto-vacuum database is reused").toEqual(originals);
  {
    using db = new DatabaseSync(file);
    db.exec("UPDATE payload SET value = 'replaced'");
  }
  const verifyPayloads = vi.spyOn(backupReader, "withVerifiedUpdateRecoveryBackup");
  expect(await f.reuse(), "same-size change").toBeUndefined();
  expect(verifyPayloads, "only the full comparison decides").toHaveBeenCalled();
});

it("rediscovers files, declared paths, config includes, links, permissions, and new agent databases", async () => {
  const f = await fixture();
  const missing = path.join(f.root, "not-created");
  f.resources.push({ path: missing, kind: "file" });
  const link = path.join(f.plugin, "link");
  await fs.symlink("data.txt", link);
  await fs.chmod(f.file, 0o600);
  await f.capture();
  expect(await f.reuse()).toBeDefined();

  const added = path.join(f.plugin, "new.txt");
  await fs.writeFile(added, "new data");
  expect(await f.reuse(), "added directory child").toBeUndefined();
  await fs.rm(added);
  await fs.rm(f.file);
  expect(await f.reuse(), "removed directory child").toBeUndefined();
  await fs.writeFile(f.file, "before", { mode: 0o600 });
  await fs.chmod(f.file, 0o644);
  expect(await f.reuse(), "changed permissions").toBeUndefined();
  await fs.chmod(f.file, 0o600);
  await fs.rm(link);
  await fs.symlink("elsewhere.txt", link);
  expect(await f.reuse(), "changed link target").toBeUndefined();
  await fs.rm(link);
  await fs.symlink("data.txt", link);
  await fs.writeFile(missing, "new data");
  expect(await f.reuse(), "previously missing resource").toBeUndefined();
  await fs.rm(missing);
  f.resources.push({ path: path.join(f.root, "new-declaration"), kind: "file" });
  expect(await f.reuse(), "new plugin declaration even when absent").toBeUndefined();
  f.resources.pop();
  const include = path.join(f.stateDir, "included.json");
  await fs.writeFile(include, "{}");
  await fs.writeFile(f.config, '{"$include":"included.json"}');
  expect(await f.reuse(), "new configured include").toBeUndefined();
  await fs.writeFile(f.config, "{}");
  await fs.rm(include);
  const agent = path.join(f.stateDir, "agents/new-agent/agent/openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(agent), { recursive: true });
  {
    using db = new DatabaseSync(agent);
    db.exec("CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('new agent')");
  }
  expect(await f.reuse(), "new on-disk database outside original roots").toBeUndefined();
  await fs.rm(agent);
  // The newly discovered agent directory itself adds a missing database root.
  expect(await f.reuse(), "new agent inventory survives database removal").toBeUndefined();
  await fs.rm(path.join(f.stateDir, "agents/new-agent"), { recursive: true });
  expect(await f.reuse(), "restored source despite timestamp drift").toBeDefined();
});

it("verifies retained payloads and seals without changing them, then replaces an unusable original", async () => {
  const f = await fixture();
  const original = await f.capture();
  const { ref, payloadPath } = await f.capturedFile(f.file);
  const partial = `${ref.manifestPath}.partial`;
  await fs.writeFile(partial, "unfinished");
  expect(await f.reuse()).toBeUndefined();
  await fs.rm(partial);
  await fs.mkdir(path.join(ref.directory, "candidate"));
  expect(await f.reuse()).toBeUndefined();
  await fs.rm(path.join(ref.directory, "candidate"), { recursive: true });
  await fs.writeFile(payloadPath, "broken");
  expect(await f.reuse()).toBeUndefined();
  expect(await fs.readFile(payloadPath, "utf8")).toBe("broken");
  const fresh = await f.capture();
  expect(fresh).toHaveLength(1);
  expect(fresh).not.toEqual(original);
});

it("accepts only exact consolidated SQLite bytes and rejects durable WAL data and changed databases", async () => {
  const f = await fixture();
  const file = path.join(f.plugin, "plugin.sqlite");
  {
    using db = new DatabaseSync(file);
    db.exec("CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('retained')");
  }
  const [name] = await f.capture();
  const { payloadPath } = await f.capturedFile(file, true);
  const payload = await fs.readFile(payloadPath);
  expect(await fs.readFile(file)).toEqual(payload);
  expect(await f.capture()).toEqual([name]);
  expect(await f.reuse()).toBeDefined();
  await fs.writeFile(`${file}-wal`, "");
  await fs.writeFile(`${file}-shm`, "disposable index");
  expect(await f.reuse()).toBeDefined();
  await fs.rm(`${file}-wal`);
  await fs.rm(`${file}-shm`);
  let retainedWal: Buffer | undefined;
  {
    using writer = new DatabaseSync(file);
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO payload VALUES('newer')",
    );
    retainedWal = await fs.readFile(`${file}-wal`);
    expect(retainedWal.length).toBeGreaterThan(0);
    expect(await f.reuse(), "uncheckpointed data is not in the main-file digest").toBeUndefined();
  }
  expect(await f.reuse(), "checkpointed changed data").toBeUndefined();
  await fs.writeFile(file, payload);
  await fs.writeFile(`${file}-wal`, retainedWal!);
  expect(await fs.readFile(file)).toEqual(payload);
  expect(await f.reuse(), "retained WAL with exact main-file match").toBeUndefined();
  await fs.rm(`${file}-wal`);
  await fs.writeFile(`${file}-journal`, "retained journal");
  expect(await f.reuse(), "unresolved rollback journal").toBeUndefined();
  await fs.rm(`${file}-journal`);
  expect(await f.reuse()).toBeDefined();
});

it("reuses large unchanged originals instead of falling back because of their byte size", async () => {
  const f = await fixture();
  const large = path.join(f.plugin, "history.bin");
  await using source = await fs.open(large, "wx");
  await source.truncate(257 * 1024 * 1024);
  await source.write("retained history", 0, "utf8");
  await source.sync();
  const first = await f.capture();
  expect(first).toHaveLength(1);
  expect(await f.capture()).toEqual(first);
});

it.each(["selection", "discovery", "comparison"] as const)(
  "cancels large shared-database reuse during %s and settles private work before cleanup",
  async (phase) => {
    const f = await fixture();
    const shared = openOpenClawStateDatabase().path;
    await closeOpenClawStateDatabaseAsync();
    {
      using database = new DatabaseSync(shared);
      // WAL mode requires private normalization, exercising the comparison worker.
      if (phase === "comparison") {
        database.exec("PRAGMA journal_mode=WAL");
      }
      database.exec(
        "CREATE TABLE doctor_capture_fixture(payload BLOB); INSERT INTO doctor_capture_fixture VALUES(zeroblob(68157440));",
      );
    }
    const originals = await f.capture();
    if (phase === "comparison") {
      expect(await f.capture(), "reuse normalized WAL image").toEqual(originals);
    }
    const controller = new AbortController();
    const cancellation = new Error("cancel large shared-state comparison");
    const scratchRoot = resolvePrivateSqliteSnapshotStagingRoot();
    const scratchBefore = (await fs.readdir(scratchRoot)).toSorted();
    let staging: string | undefined;
    let comparing = false;
    let selected = false;
    let preparation: ReturnType<typeof snapshots.startSqliteReadOnlyLocationAsync> | undefined;
    if (phase === "selection") {
      const collect = retention.collectStandaloneDoctorCaptures;
      vi.spyOn(retention, "collectStandaloneDoctorCaptures").mockImplementation((params) => {
        selected ||= comparing;
        return collect(params);
      });
      const start = snapshots.startSqliteReadOnlyLocationAsync;
      vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync").mockImplementation((...args) => {
        const pending = start(...args);
        if (comparing && args[0] === shared && !preparation) {
          preparation = pending;
          queueMicrotask(() => controller.abort(cancellation));
        }
        return pending;
      });
    } else {
      const preload = path.join(f.root, "interrupt-snapshot-allocation.mjs");
      if (phase === "discovery") {
        // Stop the real child between mkdir and native-token creation, rather than
        // depending on signal delivery racing those adjacent filesystem calls.
        await fs.writeFile(
          preload,
          `import fs from "node:fs";
           import path from "node:path";
           const allocated = (directory) => {
             if (path.dirname(directory) !== process.env.XDG_CACHE_HOME ||
                 !path.basename(directory).startsWith("openclaw-sqlite-readonly-v2-")) return;
             fs.writeSync(2, ${JSON.stringify(UPDATE_STATE_INSPECTION_PROGRESS_PREFIX)} +
               JSON.stringify({phase: "snapshot directory allocated", path: ${JSON.stringify(shared)}}) + "\\n");
             Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
           };
           const mkdtemp = fs.mkdtempSync;
           fs.mkdtempSync = (...args) => {
             const directory = mkdtemp(...args);
             allocated(directory);
             return directory;
           };
           const mkdir = fs.mkdirSync;
           fs.mkdirSync = (...args) => {
             const result = mkdir(...args);
             allocated(String(args[0]));
             return result;
           };`,
        );
      }
      const runWorker = discoveryWorker.runUpdateStateInspectionWorker;
      // Cancel the real child at progress, without replacing its work or settlement.
      vi.spyOn(discoveryWorker, "runUpdateStateInspectionWorker").mockImplementation((params) =>
        runWorker({
          ...params,
          ...(phase === "discovery"
            ? { sourceEnv: withRuntimePreload(params.sourceEnv, preload) }
            : {}),
          onProgress: (progress) => {
            params.onProgress?.(progress);
            const mode = phase === "comparison" ? "database-backup" : "discover";
            if (
              params.input.mode === mode &&
              progress.path === shared &&
              (phase !== "discovery" || progress.phase === "snapshot directory allocated")
            ) {
              staging = params.stagingRoot;
              controller.abort(cancellation);
            }
          },
        }),
      );
    }
    await expect(
      f.maintain(async ({ env }) => {
        comparing = true;
        await findReusableDoctorCapture({
          stateDir: f.stateDir,
          installRoot: f.root,
          env,
          signal: controller.signal,
          assertCurrent: getOpenClawDatabaseMaintenanceScope()!.assertAdmission,
        });
      }),
    ).rejects.toThrow(cancellation.message);
    if (phase === "selection") {
      // Cancellation must precede synchronous ledger reads.
      expect(selected).toBe(false);
      expect(preparation).toBeDefined();
      expect(preparation!.startClose().read().status).toBe("fulfilled");
    } else {
      expect(staging).toBeDefined();
      expect(await fs.stat(staging!).catch(() => undefined)).toBeUndefined();
    }
    expect((await fs.readdir(scratchRoot)).toSorted()).toEqual(scratchBefore);
    expect(await f.captures()).toEqual(originals);
    using source = new DatabaseSync(shared, { readOnly: true });
    const row = source.prepare("SELECT length(payload) AS size FROM doctor_capture_fixture").get();
    expect(row).toEqual({ size: 68157440 });
  },
);

it("treats the verification entry bound as a cache miss and still creates a fresh baseline", async () => {
  const f = await fixture();
  // Empty real directories reach the inspection bound without large payloads.
  for (let i = 0; i < 4096; i++) {
    await fs.mkdir(path.join(f.plugin, String(i)));
  }
  const first = await f.capture();
  expect(await f.reuse()).toBeUndefined();
  const fresh = await f.capture();
  expect(fresh).toHaveLength(1);
  expect(fresh).not.toEqual(first);
});
