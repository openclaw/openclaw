import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { admitOpenClawMaintenanceLiveAuthorityReads } from "../state/openclaw-state-maintenance-context.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import * as durability from "./directory-durability.js";
import * as diskSpace from "./disk-space.js";
import * as fileDescriptor from "./file-descriptor.js";
import * as sqliteIntegrity from "./sqlite-integrity.js";
import * as sqliteSource from "./sqlite-snapshot-source.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";
import * as inspection from "./update-candidate-state.inspection.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import * as databaseSizes from "./update-candidate-state.sizes.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import {
  createUpdateDatabaseBackup,
  createUpdateDatabaseBackupInProcess,
} from "./update-database-backup.js";
import * as databaseGenerations from "./update-physical-database-generations.js";
import type { UpdateRecoveryBaselineRef } from "./update-recovery-baseline-capture.js";
import type { UpdateRecoveryCaptureAcquisition } from "./update-recovery-capture-acquisition.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
});

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const readFiles = (files: string[]) => Promise.all(files.map((file) => fs.readFile(file)));
function maintenanceScope() {
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
    assertDatabaseAccess: () => {},
  });
  return Object.assign(scope, { [Symbol.asyncDispose]: () => scope.close() });
}

const readManifest = async (ref: UpdateRecoveryBaselineRef) => {
  const raw = await fs.readFile(ref.manifestPath, "utf8");
  expect(digest(raw)).toBe(ref.manifestSha256);
  return parseUpdateRecoveryBackupManifest(raw);
};
const expectMissing = (file: string) =>
  expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
function expectRows(file: string, values = ["retained"]) {
  using db = new DatabaseSync(file, { readOnly: true });
  expect(db.prepare("SELECT rowid,value FROM payload ORDER BY rowid").all()).toEqual(
    values.map((value, index) => ({ rowid: 42 + index, value })),
  );
}
async function expectSnapshot(
  entry: { snapshotPath: string; sha256: string; sizeBytes: number },
  values = ["retained"],
) {
  const bytes = await fs.readFile(entry.snapshotPath);
  expect(entry).toMatchObject({ sha256: digest(bytes), sizeBytes: bytes.length });
  expectRows(entry.snapshotPath, values);
}

async function retainedWal(file: string, sql: string) {
  const files = [file, `${file}-wal`, `${file}-shm`];
  let bytes: Buffer[];
  {
    using db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode=WAL; ${sql}`);
    bytes = await readFiles(files);
  }
  await Promise.all(files.map((target, index) => fs.writeFile(target, bytes[index]!)));
  return { files, bytes };
}

async function fixture(externalAgents = false) {
  const root = await fs.realpath(dirs.make("update-database-backup-preflight-"));
  const stateDir = path.join(root, "state");
  const shared = path.join(stateDir, "state/openclaw.sqlite");
  const backupRoot = path.join(root, "retained-package");
  const directory = `${backupRoot}.databases`;
  const stagingRoot = path.join(root, "scratch");
  const external = externalAgents
    ? [path.join(root, "external-a/agent.sqlite"), path.join(root, "external-b/agent.sqlite")]
    : [];
  for (const parent of [
    path.dirname(shared),
    directory,
    stagingRoot,
    ...external.map((file) => path.dirname(file)),
  ]) {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  }
  for (const file of [shared, ...external]) {
    using db = new DatabaseSync(file);
    db.exec(
      "PRAGMA user_version=17; CREATE TABLE payload(value TEXT); INSERT INTO payload(rowid,value) VALUES(42,'retained');",
    );
    if (file === shared) {
      db.exec("CREATE TABLE agent_databases(path TEXT)");
      for (const agent of external) {
        db.prepare("INSERT INTO agent_databases VALUES (?)").run(agent);
      }
    } else {
      db.exec(
        "CREATE TABLE schema_meta(meta_key TEXT, role TEXT, agent_id TEXT); INSERT INTO schema_meta VALUES ('primary','agent','main');",
      );
      db.prepare("UPDATE payload SET value = ?").run(path.basename(path.dirname(file)));
    }
  }
  const input = { backupRoot, stateDir, config: {}, env: {}, stagingRoot };
  const inspectionPlan = await discoverUpdateStateSchemaInspectionInProcess(input);
  return {
    root,
    stateDir,
    shared,
    directory,
    external,
    input,
    inspectionPlan,
    capture: (options: Partial<Parameters<typeof createUpdateDatabaseBackupInProcess>[0]> = {}) =>
      createUpdateDatabaseBackupInProcess({ ...input, inspectionPlan, ...options }),
  };
}

it.each(["legacy", "current"] as const)(
  "captures the %s parent's database inventory including retained custom state",
  async (dialect) => {
    const f = await fixture();
    const customRoot = path.join(f.root, "custom-calls");
    const custom = path.join(customRoot, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(custom), { recursive: true });
    await fs.copyFile(f.shared, custom);
    const input = {
      ...f.input,
      config: {
        plugins: { enabled: false, entries: { "voice-call": { config: { store: customRoot } } } },
      },
    };
    const inspectionPlan = await discoverUpdateStateSchemaInspectionInProcess(input);
    // Released drivers parse these owners before invoking the candidate's capture code.
    const releasedOwner = z.discriminatedUnion("role", [
      z.object({ role: z.literal("global") }),
      z.object({ role: z.literal("agent"), agentId: z.string().min(1) }),
    ]);
    for (const [, database] of inspectionPlan.files) {
      expect(z.array(releasedOwner).optional().safeParse(database.owners).success).toBe(true);
    }
    if (dialect === "legacy") {
      // Released parents parse only spellings and discard the candidate's optional ownership fields.
      for (const [, database] of inspectionPlan.files) {
        delete database.owners;
      }
    }
    const before = await fs.readFile(f.shared);
    const backup = await f.capture({ ...input, inspectionPlan });
    expect(backup.sourcePaths).toEqual(
      inspectionPlan.files.flatMap(([, database]) => database.spellings).toSorted(),
    );
    expect(backup.databaseOwners).toEqual(
      dialect === "legacy"
        ? undefined
        : [
            { path: f.shared, role: "global" },
            {
              path: path.join(f.stateDir, "agents/main/agent/openclaw-agent.sqlite"),
              role: "agent",
              agentId: "main",
            },
          ].toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    );
    expect(backup.databases.map((entry) => entry.path).toSorted()).toEqual(
      [custom, f.shared].toSorted(),
    );
    await expectSnapshot(backup.databases[0]!);
    expect(await fs.readFile(f.shared)).toEqual(before);
  },
);

it.each([undefined, "quick"] as const)(
  "checks manual captures with requested integrity %s and keeps generic backups full",
  async (integrityCheck) => {
    const f = await fixture();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const backup = await f.capture({
      preserveSourceArtifacts: true,
      originalCaptureSourcePaths: [f.shared],
      integrityCheck,
    });
    expect(
      prepare.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => /^PRAGMA (?:quick_check|integrity_check|foreign_key_check)\b/u.test(sql)),
    ).toEqual([
      `PRAGMA ${integrityCheck === "quick" ? "quick" : "integrity"}_check(2147483647);`,
      "PRAGMA foreign_key_check;",
    ]);
    expectRows(backup.databases[0]!.snapshotPath);
  },
);

it.each(["auto", "off"] as const)(
  "captures stopped databases without a payload audit (native copy %s)",
  async (mode) => {
    const f = await fixture(true);
    const previous = getFsSafeNativeConfig();
    const audit = vi.spyOn(sqliteIntegrity, "assertSqliteIntegrity");
    try {
      configureFsSafeNative({ mode });
      const backup = await f.capture({ stopped: true });
      expect(audit).not.toHaveBeenCalled();
      expect(backup.databases).toHaveLength(3);
      for (const entry of backup.databases) {
        const bytes = await fs.readFile(entry.snapshotPath);
        expect(entry).toMatchObject({
          userVersion: 17,
          sha256: digest(bytes),
          sizeBytes: bytes.length,
        });
        const source = new DatabaseSync(entry.path);
        source.exec("DELETE FROM payload");
        source.close();
        using retained = new DatabaseSync(entry.snapshotPath, { readOnly: true });
        expect(retained.prepare("SELECT rowid FROM payload").all()).toEqual([{ rowid: 42 }]);
      }
    } finally {
      configureFsSafeNative(previous);
    }
  },
);

it.each([
  "reader",
  "reader-new-shm",
  "reader-empty-wal",
  "wal-writer",
  "checkpoint-writer",
] as const)(
  "captures stopped WAL state with a concurrent %s without accepting writes",
  async (activity) => {
    const f = await fixture();
    const files = [f.shared, `${f.shared}-wal`, `${f.shared}-shm`];
    let before: Buffer[];
    {
      using database = new DatabaseSync(f.shared);
      database.exec("PRAGMA journal_mode=WAL; INSERT INTO payload VALUES ('checkpoint pending');");
      before = await readFiles(files);
    }
    if (activity === "reader-empty-wal") {
      // A fully checkpointed WAL-mode database has no sidecars until a reader opens it.
      before = [await fs.readFile(f.shared), Buffer.alloc(0)];
    } else {
      // Retain WAL without a live native connection whose POSIX locks copying could release.
      for (const [index, file] of files.entries()) {
        if (activity !== "reader-new-shm" || index !== 2) {
          await fs.writeFile(file, before[index]!);
        }
      }
    }
    const reader = activity.startsWith("reader");
    const capture = f.capture({
      stopped: true,
      onProgress: ({ phase, path: source }) => {
        if (phase !== "pre-migration database backup" || source !== f.shared) {
          return;
        }
        const probe = spawnSync(
          resolveTestNodeExecPath(),
          [
            "--input-type=module",
            "-e",
            `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1], { readOnly: ${reader} });
        ${reader ? "" : "db.exec(\"INSERT INTO payload VALUES ('external write')\");"}
        ${activity === "checkpoint-writer" ? "db.exec('PRAGMA wal_checkpoint(TRUNCATE)');" : ""}
        db.prepare('SELECT rowid,value FROM payload ORDER BY rowid').all();
        process.exit(0);
      `,
            f.shared,
          ],
          { encoding: "utf8" },
        );
        expect(probe.status, probe.stderr).toBe(0);
      },
    });
    if (!reader) {
      await expect(capture).rejects.toThrow(
        /Update database file changed during backup: .*openclaw\.sqlite(?:-wal)?\./u,
      );
      return;
    }
    const backup = await capture;
    expect(await Promise.all(files.slice(0, 2).map((file) => fs.readFile(file)))).toEqual(
      before.slice(0, 2),
    );
    const entry = backup.databases[0]!;
    const restored = path.join(f.root, "restored.sqlite");
    await sqliteSnapshot.publishVerifiedSqliteFile({
      sourcePath: entry.snapshotPath,
      sourceIdentity: await fs.lstat(entry.snapshotPath, { bigint: true }),
      targetPath: restored,
      expectedContent: entry,
    });
    expect(await fs.readFile(restored)).toEqual(await fs.readFile(entry.snapshotPath));
    expect(await fs.readdir(path.dirname(entry.snapshotPath))).toEqual([
      path.basename(entry.snapshotPath),
    ]);
    expectRows(restored, ["retained", "checkpoint pending"]);
  },
);

it.each(["original-custody", "rollback", "ordinary", "maintenance"] as const)(
  "preserves committed WAL and generation attribution during %s capture",
  async (mode) => {
    const f = await fixture();
    const { files, bytes: family } = await retainedWal(
      f.shared,
      "INSERT INTO payload VALUES ('checkpoint pending');",
    );
    const parentImages = vi.spyOn(sqliteSource, "prepareSqliteReadOnlyLocationSync");
    await using scope =
      mode === "ordinary" || mode === "maintenance" ? maintenanceScope() : undefined;
    const input = { ...f.input, preserveSourceArtifacts: true };
    const backup = scope
      ? await scope.run(() =>
          createUpdateDatabaseBackup({
            ...input,
            backupRoot: path.join(f.root, "maintenance-rollback"),
            acquisition: mode === "maintenance" ? { mode: "maintenance-owner" } : undefined,
          }),
        )
      : await f.capture({
          preserveSourceArtifacts: true,
          originalCaptureSourcePaths: mode === "original-custody" ? [f.shared] : undefined,
        });
    if (scope) {
      // Parent SQLite opens require maintenance custody: even read-only opens can release locks.
      expect(parentImages.mock.calls.map(([file]) => file)).toEqual(
        mode === "maintenance" ? [f.shared] : [],
      );
      expect(backup.originalCaptureSourcePaths).toBeUndefined();
    }
    expect(await readFiles(files)).toEqual(family);
    expect(backup.databases).toHaveLength(1);
    await expectSnapshot(backup.databases[0]!, ["retained", "checkpoint pending"]);
    if (mode === "original-custody") {
      expect(backup.sourceGenerations[f.shared]).toBeUndefined();
    } else {
      expect(backup.sourceGenerations[f.shared]).toBe(
        (await databaseGenerations.readUpdatePhysicalDatabaseGenerations([f.shared]))[f.shared],
      );
      expect(backup.sourceGenerations[f.shared]).toEqual(expect.any(String));
    }
  },
);

it("keeps the verified digest when a snapshot is replaced before backup metadata is recorded", async () => {
  const f = await fixture();
  const createSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
  let published: Buffer | undefined;
  vi.spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot").mockImplementationOnce(
    async (options) => {
      const result = await createSnapshot(options);
      published = await fs.readFile(result.path);
      const changed = Buffer.from(published);
      const offset = changed.indexOf("retained");
      assert(offset >= 0, "Snapshot must contain the captured row");
      changed.write("modified", offset);
      const replacement = `${result.path}.replacement`;
      await fs.writeFile(replacement, changed);
      await fs.rename(replacement, result.path);
      return result;
    },
  );

  const backup = await f.capture();
  assert(published, "Snapshot publication must complete before the injected change");
  expect(backup.databases[0]).toMatchObject({
    sha256: digest(published),
    sizeBytes: published.length,
  });
  expect(await fs.readFile(backup.databases[0]!.snapshotPath)).not.toEqual(published);
});

it.each(["path", "owner"] as const)(
  "still refuses a changed database %s after discovery",
  async (change) => {
    const f = await fixture(true);
    const db = new DatabaseSync(f.shared);
    db.exec("ALTER TABLE agent_databases ADD COLUMN agent_id TEXT");
    db.prepare("UPDATE agent_databases SET agent_id = ?").run("before");
    db.close();
    const inspectionPlan = await discoverUpdateStateSchemaInspectionInProcess(f.input);
    {
      using changed = new DatabaseSync(f.shared);
      if (change === "owner") {
        changed.prepare("UPDATE agent_databases SET agent_id = ?").run("after");
      } else {
        changed.exec("DELETE FROM agent_databases");
      }
    }
    await expect(f.capture({ inspectionPlan })).rejects.toThrow(
      "Update database inventory changed during backup",
    );
  },
);

it.each(["", "-wal"])(
  "refuses a hard-linked database family file %s before publishing any rollback snapshot",
  async (suffix) => {
    const f = await fixture();
    const source = `${f.shared}${suffix}`;
    if (suffix) {
      await fs.writeFile(source, "");
    }
    const alias = path.join(f.root, "outside-alias");
    await fs.link(source, alias);
    const before = await fs.readFile(f.shared);

    await expect(f.capture()).rejects.toThrow(
      `Update database rollback requires a regular file with one link: ${source}`,
    );

    expect(await fs.readdir(f.directory)).toEqual([]);
    expect(await fs.readFile(f.shared)).toEqual(before);
    expect((await fs.lstat(alias)).ino).toBe((await fs.lstat(source)).ino);
  },
);

async function originalCaptureFixture(externalAgents = false) {
  const f = await fixture(externalAgents);
  const registryOnly = path.join(f.root, "registry-only", "agent.sqlite");
  if (externalAgents) {
    await fs.mkdir(path.dirname(registryOnly));
    await fs.copyFile(f.external[0]!, registryOnly);
    using shared = new DatabaseSync(f.shared);
    shared.exec("ALTER TABLE agent_databases ADD COLUMN agent_id TEXT");
    shared
      .prepare("INSERT INTO agent_databases(path, agent_id) VALUES (?, ?)")
      .run(registryOnly, "registry-only");
  }
  const plugin = path.join(f.root, "plugin-data");
  const workshop = path.join(f.root, "workshop");
  await Promise.all([plugin, workshop].map((directory) => fs.mkdir(directory)));
  const paths = {
    configPath: path.join(f.stateDir, "openclaw.json"),
    authoredConfig: path.join(f.stateDir, "authored.json5"),
    include: path.join(f.stateDir, "settings.json5"),
    applicationFile: path.join(plugin, "credential.bin"),
    skillLink: path.join(workshop, "current.md"),
    pluginDatabase: path.join(plugin, "state.sqlite"),
    missingFile: path.join(plugin, "future.bin"),
    missingDatabase: path.join(plugin, "future.sqlite"),
    missingDirectory: path.join(f.root, "future-workshop"),
  };
  const bytes = new Map([
    [paths.authoredConfig, Buffer.from('// authored root\n{ $include: "./settings.json5" }\n')],
    [paths.include, Buffer.from('// authored include\n{ gateway: { mode: "local" } }\n')],
    [paths.applicationFile, Buffer.from([0, 255, 19, 10, 128])],
    [
      path.join(workshop, "SKILL.md"),
      Buffer.from("# Original skill\nKeep these authored bytes.\n"),
    ],
  ]);
  for (const [file, raw] of bytes) {
    await fs.writeFile(file, raw);
  }
  await fs.symlink(path.basename(paths.authoredConfig), paths.configPath);
  await fs.symlink("SKILL.md", paths.skillLink);
  await fs.copyFile(f.shared, paths.pluginDatabase);

  // Retain a real committed WAL family after closing its fixture writer. A native
  // source open can alter/remove these sidecars even though it requests read-only.
  const { files: familyPaths, bytes: family } = await retainedWal(
    f.shared,
    "PRAGMA wal_autocheckpoint=0; CREATE TABLE state_leases(token TEXT); INSERT INTO state_leases(rowid,token) VALUES(87,'original-lease');",
  );

  // Only declaration producers are synthetic; acquisition, copying, revalidation,
  // manifest parsing, and publication all use their production owners.
  const registry = await import("../plugins/doctor-contract-registry.js");
  vi.spyOn(registry, "preparePluginDoctorMigrationBackupResources").mockResolvedValue({
    resources: [
      { path: plugin, kind: "directory" },
      { path: paths.missingFile, kind: "file" },
      { path: paths.missingDatabase, kind: "sqlite" },
      { path: workshop, kind: "directory" },
      { path: paths.missingDirectory, kind: "directory" },
    ],
    deferredPluginIds: new Set(),
    notices: [],
    assertCurrent: () => {},
  });
  const { captureUpdateRecoveryBaseline } = await import("./update-recovery-baseline-capture.js");
  const env = {
    ...process.env,
    HOME: f.root,
    USERPROFILE: f.root,
    OPENCLAW_HOME: f.root,
    OPENCLAW_STATE_DIR: f.stateDir,
    OPENCLAW_CONFIG_PATH: paths.configPath,
    OPENCLAW_AGENT_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
  };
  return {
    ...f,
    ...paths,
    registryOnly,
    bytes,
    family,
    familyPaths,
    captureOriginal: (runId: string, acquisition?: UpdateRecoveryCaptureAcquisition) =>
      captureUpdateRecoveryBaseline({
        runId,
        installRoot: f.root,
        env,
        drivers: [],
        assertCurrent: () => {},
        acquisition,
      }),
  };
}

async function expectOriginalDatabase(ref: UpdateRecoveryBaselineRef, sourcePath: string) {
  const manifest = await readManifest(ref);
  const entry = manifest.entries.find((candidate) => candidate.sourcePath === sourcePath);
  assert(entry?.kind === "file" && entry.sqlite);
  const payloadPath = path.join(ref.directory, entry.archivePath);
  const bytes = await fs.readFile(payloadPath);
  expect(entry).toMatchObject({
    sha256: digest(bytes),
    size: bytes.length,
  });
  using retained = new DatabaseSync(payloadPath, { readOnly: true });
  expect(retained.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expectRows(payloadPath);
}

it("refuses an original capture before writing when its payload will not fit", async () => {
  const f = await originalCaptureFixture();
  const payloadBytes = 2 * 1024 * 1024;
  await fs.truncate(f.applicationFile, payloadBytes);
  const store = resolveUpdateCaptureRoot(f.stateDir);
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
    targetPath,
    checkedPath: targetPath,
    availableBytes: 65 * 1024 * 1024,
    totalBytes: 1024 * 1024 * 1024,
  }));

  await expect(f.captureOriginal("capacity")).rejects.toThrow(
    `Original update capture needs 66 MiB near ${store}, but only 65 MiB is available`,
  );
  await expectMissing(store);
  expect((await fs.stat(f.applicationFile)).size).toBe(payloadBytes);
});

it("seals equivalent original bytes under isolated and maintenance-owned capture", async () => {
  const f = await originalCaptureFixture(true);
  const retainedState = path.join(f.stateDir, "voice-calls", "state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(retainedState), { recursive: true });
  await fs.copyFile(f.pluginDatabase, retainedState);
  const externalBytes = await readFiles(f.external);
  const result = await f.captureOriginal("original");
  const manifest = await readManifest(result.ref);
  expect(manifest).toMatchObject({ schemaVersion: 2, generation: { kind: "baseline" } });
  expect(manifest.databases?.filter((database) => database.role === "global")).toEqual([
    { path: f.shared, role: "global" },
  ]);
  const entries = new Map(manifest.entries.map((entry) => [entry.sourcePath, entry]));
  const payload = (source: string) => {
    const entry = entries.get(source);
    assert(entry?.kind === "file", `Missing captured file: ${source}`);
    return path.join(result.ref.directory, entry.archivePath);
  };
  for (const [source, bytes] of f.bytes) {
    expect(await fs.readFile(payload(source))).toEqual(bytes);
    expect(await fs.readFile(source)).toEqual(bytes);
  }
  for (const source of [f.shared, retainedState, f.pluginDatabase, ...f.external]) {
    expect(entries.get(source)).toMatchObject({ kind: "file", sqlite: true });
    expectRows(payload(source), [
      f.external.includes(source) ? path.basename(path.dirname(source)) : "retained",
    ]);
    using snapshot = new DatabaseSync(payload(source), { readOnly: true });
    if (source === f.shared) {
      expect(snapshot.prepare("SELECT rowid,token FROM state_leases").all()).toEqual([
        { rowid: 87, token: "original-lease" },
      ]);
    }
    if (f.external.includes(source)) {
      expect(snapshot.prepare("SELECT agent_id FROM schema_meta").get()).toEqual({
        agent_id: "main",
      });
    }
  }
  expect(await readFiles(f.familyPaths)).toEqual(f.family);
  expect(await readFiles(f.external)).toEqual(externalBytes);
  expect(manifest.databases?.filter((database) => f.external.includes(database.path))).toEqual([]);
  expect(manifest.configPaths).toEqual(
    expect.arrayContaining([f.configPath, f.authoredConfig, f.include]),
  );
  expect(entries.get(f.configPath)).toMatchObject({
    kind: "symlink",
    target: "authored.json5",
    contentPath: f.authoredConfig,
  });
  expect(entries.get(f.skillLink)).toMatchObject({ kind: "symlink", target: "SKILL.md" });
  for (const [sourcePath, sqlite, directory] of [
    [f.missingFile, false, false],
    [f.missingDatabase, true, false],
    [f.missingDirectory, false, true],
  ] as const) {
    expect(entries.get(sourcePath)).toEqual({ kind: "missing", sourcePath, sqlite, directory });
    await expectMissing(sourcePath);
  }
  expect(manifest.entries.some((entry) => /-(wal|shm|journal)$/.test(entry.sourcePath))).toBe(
    false,
  );

  await using scope = maintenanceScope();
  const maintained = await scope.run(() =>
    f.captureOriginal("maintenance-owned", { mode: "maintenance-owner" }),
  );
  const maintainedManifest = await readManifest(maintained.ref);
  expect((await fs.lstat(maintained.ref.manifestPath)).nlink).toBe(1);
  await expectMissing(`${maintained.ref.manifestPath}.partial`);
  for (const entry of maintainedManifest.entries) {
    if (entry.kind !== "file") {
      continue;
    }
    const payloadPath = path.join(maintained.ref.directory, entry.archivePath);
    expect((await fs.lstat(payloadPath)).nlink).toBe(1);
    expect(digest(await fs.readFile(payloadPath))).toBe(entry.sha256);
  }
  for (const field of ["entries", "databases", "configPaths", "roots", "protectedPaths"] as const) {
    expect(maintainedManifest[field], field).toEqual(manifest[field]);
  }
  expect(maintainedManifest.databases).toContainEqual(
    expect.objectContaining({ path: f.registryOnly, role: "agent", agentId: "registry-only" }),
  );
  expect(maintainedManifest.entries).toContainEqual(
    expect.objectContaining({ sourcePath: f.registryOnly, kind: "file", sqlite: true }),
  );
  expect(await readFiles(f.familyPaths)).toEqual(f.family);
  expect(await readFiles(f.external)).toEqual(externalBytes);
});

it.each(["large", "live-reads-admitted"] as const)(
  "keeps maintenance capture isolated for %s sources",
  async (mode) => {
    const f = await originalCaptureFixture();
    let originalManifest: ReturnType<typeof parseUpdateRecoveryBackupManifest> | undefined;
    if (mode === "large") {
      await fs.truncate(f.shared, 65 * 1024 * 1024);
    } else {
      const original = await f.captureOriginal("isolated-steps");
      originalManifest = await readManifest(original.ref);
    }
    const worker = vi.spyOn(inspection, "runUpdateStateInspectionWorker");
    const isolatedSizes = vi.spyOn(databaseSizes, "readUpdateStateDatabaseSizes");
    await using scope = maintenanceScope();
    const captured = await scope.run(() => {
      if (mode === "live-reads-admitted") {
        admitOpenClawMaintenanceLiveAuthorityReads(f.shared);
      }
      return f.captureOriginal(mode, { mode: "maintenance-owner" });
    });
    const manifest = await readManifest(captured.ref);
    if (mode === "large") {
      expect(worker.mock.calls.map(([request]) => request.input.mode)).toEqual([
        "discover",
        "database-backup",
      ]);
      expect(manifest.entries).toContainEqual(
        expect.objectContaining({ sourcePath: f.shared, kind: "file", sqlite: true }),
      );
    } else {
      assert(originalManifest);
      expect(manifest.entries).toEqual(originalManifest.entries);
      expect(isolatedSizes).toHaveBeenCalled();
      expect(worker).toHaveBeenCalledTimes(2);
    }
  },
);

it("rejects an already-aborted in-process size inventory", async () => {
  const signal = AbortSignal.abort(new Error("inventory aborted"));
  await expect(
    databaseSizes.readUpdateStateDatabaseSizesInProcess(["never-read.sqlite"], signal),
  ).rejects.toBe(signal.reason);
});

it.each([
  { change: "link", phase: "during" },
  { change: "unlink", phase: "after" },
  { change: "content", phase: "during" },
  { change: "content", phase: "after" },
] as const)("validates $change changes $phase original file capture", async ({ change, phase }) => {
  const f = await originalCaptureFixture();
  const source = f.applicationFile;
  const timestamp = new Date("2000-01-01T00:00:00.000Z");
  await fs.utimes(source, timestamp, timestamp);
  const before = await fs.stat(source, { bigint: true });
  const alias = path.join(f.root, "outside-native-capture");
  if (change === "unlink") {
    await fs.link(source, alias);
  }
  let changed = false;
  const mutate = async () => {
    changed = true;
    if (change === "link") {
      await fs.link(source, alias);
    } else if (change === "unlink") {
      await fs.unlink(alias);
    } else {
      await fs.writeFile(source, Buffer.alloc(Number(before.size), 7));
      await fs.utimes(source, timestamp, timestamp);
    }
  };
  if (phase === "during") {
    const copy = fileDescriptor.copyFileHandle;
    vi.spyOn(fileDescriptor, "copyFileHandle").mockImplementation(async (...args) => {
      const stat = await args[0].stat({ bigint: true });
      if (stat.dev === before.dev && stat.ino === before.ino) {
        await mutate();
      }
      return copy(...args);
    });
  } else {
    const publish = durability.publishFileExclusive;
    vi.spyOn(durability, "publishFileExclusive").mockImplementation(async (...args) => {
      if (path.basename(args[0].targetPath) === "manifest.json") {
        await mutate();
      }
      return publish(...args);
    });
  }
  const capture = f.captureOriginal(`${change}-${phase}`);
  if (change === "content" && phase === "during") {
    await expect(capture).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/Original update (file|resource) changed/),
      }),
    });
  } else {
    const { ref } = await capture;
    const manifest = await readManifest(ref);
    const entry = manifest.entries.find((candidate) => candidate.sourcePath === source);
    assert(entry?.kind === "file");
    expect(await fs.readFile(path.join(ref.directory, entry.archivePath))).toEqual(
      f.bytes.get(source),
    );
  }
  expect(changed).toBe(true);
  const after = await fs.stat(source, { bigint: true });
  expect(after).toMatchObject({
    dev: before.dev,
    ino: before.ino,
    size: before.size,
    mtimeNs: before.mtimeNs,
  });
  expect(after.ctimeNs).not.toBe(before.ctimeNs);
});

it.each(["-wal", "-journal"] as const)(
  "refuses to seal an original capture when an absent database retains %s data",
  async (suffix) => {
    const f = await originalCaptureFixture();
    const sidecar = `${f.missingDatabase}${suffix}`;
    const recoveryBytes = Buffer.from("retained database recovery bytes");
    await fs.writeFile(sidecar, recoveryBytes);
    await using scope = maintenanceScope();
    const runId = `missing${suffix}`;
    await expect(
      scope.run(() => f.captureOriginal(runId, { mode: "maintenance-owner" })),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining(
          `Database is absent but retained journal data exists: ${f.missingDatabase}`,
        ),
      }),
    });
    const directory = path.join(`${f.stateDir}.update-captures`, runId);
    await expectMissing(path.join(directory, "manifest.json"));
    await expectMissing(f.missingDatabase);
    expect(await fs.readFile(sidecar)).toEqual(recoveryBytes);
  },
);

it("seals the chosen manual image without discarding later live writes", async () => {
  const f = await originalCaptureFixture();
  const owner = await import("./update-database-backup.js");
  const capture = owner.createUpdateDatabaseBackup;
  vi.spyOn(owner, "createUpdateDatabaseBackup").mockImplementationOnce(async (params) => {
    const captured = await capture(params);
    {
      using writer = new DatabaseSync(f.shared);
      writer.exec("INSERT INTO payload VALUES ('later')");
    }
    return captured;
  });
  const captured = await f.captureOriginal("changed");
  await expectOriginalDatabase(captured.ref, f.shared);
  using source = new DatabaseSync(f.shared, { readOnly: true });
  expect(source.prepare("SELECT value FROM payload ORDER BY rowid").all()).toEqual([
    { value: "retained" },
    { value: "later" },
  ]);
});

it("seals a verified manual image with its unavailable-generation warnings", async () => {
  const f = await originalCaptureFixture();
  const owner = await import("./update-database-backup.js");
  const capture = owner.createUpdateDatabaseBackup;
  const producerWarnings = [
    `Database write generation unavailable for ${f.shared}: SQLITE_BUSY: database is locked`,
    `Database changed during capture; its snapshot requires manual recovery: ${f.shared}`,
  ];
  vi.spyOn(owner, "createUpdateDatabaseBackup").mockImplementationOnce(async (params) => {
    const captured = await capture(params);
    const { [f.shared]: _unverified, ...sourceGenerations } = captured.sourceGenerations;
    return {
      ...captured,
      sourceGenerations,
      warnings: [
        ...captured.warnings,
        "Available disk space could not be measured near /elsewhere; database backup will be attempted.",
        ...producerWarnings,
      ],
    };
  });
  const captured = await f.captureOriginal("unverified");
  await expectOriginalDatabase(captured.ref, f.shared);
  expect(captured.diagnostics.databaseWarnings).toEqual(expect.arrayContaining(producerWarnings));
  expect(await readFiles(f.familyPaths)).toEqual(f.family);
});

it.each(["insufficient", "unknown"] as const)(
  "preflights a separate source volume whose available capacity is %s",
  async (capacity) => {
    const f = await fixture(true);
    const externalDirectories = f.external.map((file) => path.dirname(file));
    const largest = Math.max(
      ...(await Promise.all(f.external.map(async (file) => (await fs.stat(file)).size))),
    );
    // Enough for either agent separately; insufficient for both retained originals plus publication.
    const available = 64 * 1024 * 1024 + 2 * largest;
    const stat = fs.stat;
    const backupDevice = (await stat(f.directory, { bigint: true })).dev;
    const deviceQueries = new Set(externalDirectories);
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const info = await stat(...args);
      // Only the volume inventory sees synthetic device identities; native file publication stays real.
      if (deviceQueries.delete(String(args[0]))) {
        assert(info, "Fixture source volume must exist");
        Object.defineProperty(info, "dev", {
          value: typeof info.dev === "bigint" ? backupDevice + 1n : Number(backupDevice + 1n),
        });
      }
      return info;
    });
    vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => {
      const external = externalDirectories.includes(targetPath);
      if (external && capacity === "unknown") {
        return null;
      }
      return {
        targetPath,
        checkedPath: targetPath,
        availableBytes: external ? available : 1024 * 1024 * 1024,
        totalBytes: 2 * 1024 * 1024 * 1024,
      };
    });
    const originals = await readFiles([f.shared, ...f.external]);
    if (capacity === "insufficient") {
      await expect(f.capture()).rejects.toThrow(`near ${externalDirectories[0]}`);
      expect(await fs.readdir(f.directory)).toEqual([]);
    } else {
      const backup = await f.capture();
      expect(backup.databases.map((entry) => entry.path).toSorted()).toEqual(
        [f.shared, ...f.external].toSorted(),
      );
      expect(backup.warnings).toContain(
        `Available disk space could not be measured near ${externalDirectories[0]}; database backup will be attempted.`,
      );
      const retainedAgentFiles = (await fs.readdir(backup.directory, { recursive: true }))
        .filter((file) => file.endsWith("agent.sqlite"))
        .toSorted();
      expect(retainedAgentFiles).toEqual([
        expect.stringMatching(/[\\/]external-a[\\/]agent\.sqlite$/u),
        expect.stringMatching(/[\\/]external-b[\\/]agent\.sqlite$/u),
      ]);
      for (const entry of backup.databases) {
        await expectSnapshot(entry, [
          entry.path === f.shared ? "retained" : path.basename(path.dirname(entry.path)),
        ]);
        if (entry.path !== f.shared) {
          using db = new DatabaseSync(entry.snapshotPath, { readOnly: true });
          expect(db.prepare("SELECT agent_id FROM schema_meta").get()).toEqual({
            agent_id: "main",
          });
        }
      }
    }
    expect(await readFiles([f.shared, ...f.external])).toEqual(originals);
  },
);
