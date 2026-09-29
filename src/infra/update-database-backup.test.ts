import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as diskSpace from "./disk-space.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
});

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
    const db = new DatabaseSync(file);
    try {
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
    } finally {
      db.close();
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
    capture: () => createUpdateDatabaseBackupInProcess({ ...input, inspectionPlan }),
  };
}

it.each(["", "-wal", "-shm", "-journal"])(
  "refuses a hard-linked database family file %s before publishing any rollback snapshot",
  async (suffix) => {
    const f = await fixture();
    const source = `${f.shared}${suffix}`;
    if (suffix) {
      await fs.writeFile(source, "");
    }
    const alias = path.join(f.root, "outside-alias");
    await fs.link(source, alias);
    expect((await fs.lstat(source)).nlink).toBe(2);
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
  const configPath = path.join(f.stateDir, "openclaw.json");
  const authoredConfig = path.join(f.stateDir, "authored.json5");
  const include = path.join(f.stateDir, "settings.json5");
  const plugin = path.join(f.root, "plugin-data");
  const workshop = path.join(f.root, "workshop");
  await fs.mkdir(plugin);
  await fs.mkdir(workshop);
  const applicationFile = path.join(plugin, "credential.bin");
  const skill = path.join(workshop, "SKILL.md");
  const bytes = new Map([
    [authoredConfig, Buffer.from('// authored root\n{ $include: "./settings.json5" }\n')],
    [include, Buffer.from('// authored include\n{ gateway: { mode: "local" } }\n')],
    [applicationFile, Buffer.from([0, 255, 19, 10, 128])],
    [skill, Buffer.from("# Original skill\nKeep these authored bytes.\n")],
  ]);
  for (const [file, raw] of bytes) {
    await fs.writeFile(file, raw);
  }
  await fs.symlink(path.basename(authoredConfig), configPath);
  const skillLink = path.join(workshop, "current.md");
  await fs.symlink("SKILL.md", skillLink);
  const pluginDatabase = path.join(plugin, "state.sqlite");
  await fs.copyFile(f.shared, pluginDatabase);
  const missingFile = path.join(plugin, "future.bin");
  const missingDatabase = path.join(plugin, "future.sqlite");
  const missingDirectory = path.join(f.root, "future-workshop");

  // Retain a real committed WAL family after closing its fixture writer. A native
  // source open can alter/remove these sidecars even though it requests read-only.
  const db = new DatabaseSync(f.shared);
  let family: Buffer[];
  const familyPaths = [f.shared, `${f.shared}-wal`, `${f.shared}-shm`];
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE state_leases(token TEXT);
      INSERT INTO state_leases(rowid,token) VALUES(87,'original-lease');
    `);
    family = await Promise.all(familyPaths.map((file) => fs.readFile(file)));
  } finally {
    db.close();
  }
  for (const [index, file] of familyPaths.entries()) {
    await fs.writeFile(file, family[index]!);
  }

  // Only declaration producers are synthetic; acquisition, copying, revalidation,
  // manifest parsing, and publication all use their production owners.
  const registry = await import("../plugins/doctor-contract-registry.js");
  vi.spyOn(registry, "preparePluginDoctorMigrationBackupResources").mockResolvedValue({
    resources: [
      { path: plugin, kind: "directory" },
      { path: missingFile, kind: "file" },
      { path: missingDatabase, kind: "sqlite" },
    ],
    deferredPluginIds: new Set(),
    notices: [],
    assertCurrent: () => {},
  });
  const workshopOwner = await import("../commands/doctor-update-rehearsal-workshop.js");
  vi.spyOn(workshopOwner, "collectDoctorSkillWorkshopBackupResources").mockResolvedValue([
    { path: workshop, kind: "directory" },
    { path: missingDirectory, kind: "directory" },
  ]);
  const { captureUpdateRecoveryBaseline } = await import("./update-recovery-baseline-capture.js");
  const env = {
    ...process.env,
    HOME: f.root,
    USERPROFILE: f.root,
    OPENCLAW_HOME: f.root,
    OPENCLAW_STATE_DIR: f.stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_AGENT_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
  };
  return {
    ...f,
    bytes,
    family,
    familyPaths,
    configPath,
    authoredConfig,
    include,
    skillLink,
    pluginDatabase,
    missingFile,
    missingDatabase,
    missingDirectory,
    captureOriginal: (runId: string) =>
      captureUpdateRecoveryBaseline({
        runId,
        installRoot: f.root,
        env,
        drivers: [],
        assertCurrent: () => {},
      }),
  };
}

it("seals original bytes and declared resources without changing the SQLite source family", async () => {
  const f = await originalCaptureFixture(true);
  const externalBytes = await Promise.all(f.external.map((source) => fs.readFile(source)));
  const result = await f.captureOriginal("original");
  const raw = await fs.readFile(result.ref.manifestPath, "utf8");
  const { parseUpdateRecoveryBackupManifest } =
    await import("../commands/backup-verify-manifest.js");
  const manifest = parseUpdateRecoveryBackupManifest(raw);
  expect(createHash("sha256").update(raw).digest("hex")).toBe(result.ref.manifestSha256);
  expect(manifest).toMatchObject({ schemaVersion: 2, generation: { kind: "baseline" } });
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
  for (const source of [f.shared, f.pluginDatabase, ...f.external]) {
    expect(entries.get(source)).toMatchObject({ kind: "file", sqlite: true });
    const snapshot = new DatabaseSync(payload(source), { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT rowid,value FROM payload").all()).toEqual([
        {
          rowid: 42,
          value: f.external.includes(source) ? path.basename(path.dirname(source)) : "retained",
        },
      ]);
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
    } finally {
      snapshot.close();
    }
  }
  expect(await Promise.all(f.familyPaths.map((file) => fs.readFile(file)))).toEqual(f.family);
  expect(await Promise.all(f.external.map((source) => fs.readFile(source)))).toEqual(externalBytes);
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
    await expect(fs.lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(manifest.entries.some((entry) => /-(wal|shm|journal)$/.test(entry.sourcePath))).toBe(
    false,
  );
});

it("retains an unsealed capture when the database changes after its snapshot", async () => {
  const f = await originalCaptureFixture();
  const owner = await import("./update-database-backup.js");
  const capture = owner.createUpdateDatabaseBackup;
  vi.spyOn(owner, "createUpdateDatabaseBackup").mockImplementationOnce(async (params) => {
    const captured = await capture(params);
    const writer = new DatabaseSync(f.shared);
    try {
      writer.exec("INSERT INTO payload VALUES ('later')");
    } finally {
      writer.close();
    }
    return captured;
  });
  await expect(f.captureOriginal("changed")).rejects.toMatchObject({
    cause: expect.objectContaining({ message: expect.stringContaining("generation changed") }),
  });
  const directory = path.join(`${f.stateDir}.update-captures`, "changed");
  await expect(fs.lstat(path.join(directory, "manifest.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await fs.readdir(path.join(directory, "payload"))).length).toBeGreaterThan(0);
  const source = new DatabaseSync(f.shared, { readOnly: true });
  try {
    expect(source.prepare("SELECT value FROM payload ORDER BY rowid").all()).toEqual([
      { value: "retained" },
      { value: "later" },
    ]);
  } finally {
    source.close();
  }
});

it.each(["insufficient", "unknown"] as const)(
  "preflights a separate source volume whose available capacity is %s",
  async (capacity) => {
    const f = await fixture(true);
    const externalDirectories = f.external.map((file) => path.dirname(file));
    const sizes = await Promise.all(f.external.map(async (file) => (await fs.stat(file)).size));
    const largest = Math.max(...sizes);
    const headroom = 64 * 1024 * 1024;
    // Enough for either agent separately; insufficient for both retained originals plus publication.
    const available = headroom + 2 * largest;
    expect(available).toBeLessThan(
      headroom + sizes.reduce((total, size) => total + size, 0) + largest,
    );
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
    const originals = await Promise.all([f.shared, ...f.external].map((file) => fs.readFile(file)));
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
        const db = new DatabaseSync(entry.snapshotPath, { readOnly: true });
        try {
          expect(db.prepare("SELECT rowid,value FROM payload").all()).toEqual([
            {
              rowid: 42,
              value: entry.path === f.shared ? "retained" : path.basename(path.dirname(entry.path)),
            },
          ]);
          if (entry.path !== f.shared) {
            expect(db.prepare("SELECT agent_id FROM schema_meta").get()).toEqual({
              agent_id: "main",
            });
          }
        } finally {
          db.close();
        }
      }
    }
    expect(await Promise.all([f.shared, ...f.external].map((file) => fs.readFile(file)))).toEqual(
      originals,
    );
  },
);
