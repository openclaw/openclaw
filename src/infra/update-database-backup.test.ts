import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { admitOpenClawMaintenanceLiveAuthorityReads } from "../state/openclaw-state-maintenance-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as diskSpace from "./disk-space.js";
import * as fileDescriptor from "./file-descriptor.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";
import * as inspection from "./update-candidate-state.inspection.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import * as candidateState from "./update-candidate-state.js";
import * as databaseSizes from "./update-candidate-state.sizes.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";
import { retireExpiredStandaloneDoctorCaptures } from "./update-recovery-baseline-capture.js";
import type { UpdateRecoveryCaptureAcquisition } from "./update-recovery-capture-acquisition.js";
import { getUpdateRunAsync } from "./update-run-reader.js";

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
    capture: () => createUpdateDatabaseBackupInProcess({ ...input, inspectionPlan }),
  };
}

it.each(["legacy", "current"] as const)(
  "captures the %s parent's database inventory",
  async (dialect) => {
    const f = await fixture();
    const inspectionPlan = structuredClone(f.inspectionPlan);
    if (dialect === "legacy") {
      // Released parents parse only spellings and discard the candidate's optional ownership fields.
      for (const [, database] of inspectionPlan.files) {
        delete database.owners;
      }
    }
    const before = await fs.readFile(f.shared);
    const backup = await createUpdateDatabaseBackupInProcess({ ...f.input, inspectionPlan });
    expect(backup.sourcePaths).toEqual(
      f.inspectionPlan.files.flatMap(([, database]) => database.spellings).toSorted(),
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
    expect(backup.databases).toHaveLength(1);
    const published = await fs.readFile(backup.databases[0]!.snapshotPath);
    expect(backup.databases[0]).toMatchObject({
      sha256: createHash("sha256").update(published).digest("hex"),
      sizeBytes: published.length,
    });
    {
      using snapshot = openNodeSqliteDatabase(backup.databases[0]!.snapshotPath, {
        readOnly: true,
      });
      expect(snapshot.prepare("SELECT rowid,value FROM payload").all()).toEqual([
        { rowid: 42, value: "retained" },
      ]);
    }
    expect(await fs.readFile(f.shared)).toEqual(before);
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
    sha256: createHash("sha256").update(published).digest("hex"),
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
    await expect(
      createUpdateDatabaseBackupInProcess({ ...f.input, inspectionPlan }),
    ).rejects.toThrow("Update database inventory changed during backup");
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
  let family: Buffer[];
  const familyPaths = [f.shared, `${f.shared}-wal`, `${f.shared}-shm`];
  {
    using db = new DatabaseSync(f.shared);
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE state_leases(token TEXT);
      INSERT INTO state_leases(rowid,token) VALUES(87,'original-lease');
    `);
    family = await Promise.all(familyPaths.map((file) => fs.readFile(file)));
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
    registryOnly,
    bytes,
    family,
    familyPaths,
    configPath,
    authoredConfig,
    include,
    applicationFile,
    skillLink,
    pluginDatabase,
    missingFile,
    missingDatabase,
    missingDirectory,
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

it("seals equivalent original bytes under isolated steps and one maintenance-owned database child", async () => {
  const f = await originalCaptureFixture(true);
  const externalBytes = await Promise.all(f.external.map((source) => fs.readFile(source)));
  const result = await f.captureOriginal("original");
  const raw = await fs.readFile(result.ref.manifestPath, "utf8");
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
    using snapshot = new DatabaseSync(payload(source), { readOnly: true });
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

  const worker = vi.spyOn(inspection, "runUpdateStateInspectionWorker");
  const parentDiscovery = vi.spyOn(candidateState, "discoverUpdateStateSchemaInspectionInProcess");
  const isolatedGenerations = vi.spyOn(candidateState, "readUpdateDatabaseGenerationsIsolated");
  const isolatedSizes = vi.spyOn(databaseSizes, "readUpdateStateDatabaseSizes");
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
    assertDatabaseAccess: () => {},
  });
  try {
    const maintained = await scope.run(() =>
      f.captureOriginal("maintenance-owned", { mode: "maintenance-owner" }),
    );
    const maintainedManifest = parseUpdateRecoveryBackupManifest(
      await fs.readFile(maintained.ref.manifestPath, "utf8"),
    );
    for (const field of [
      "entries",
      "databases",
      "configPaths",
      "roots",
      "protectedPaths",
    ] as const) {
      expect(maintainedManifest[field], field).toEqual(manifest[field]);
    }
    expect(worker).toHaveBeenCalledOnce();
    expect(parentDiscovery).toHaveBeenCalledOnce();
    expect(parentDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ preserveSourceArtifacts: true }),
    );
    const backupRequest = worker.mock.calls[0]![0];
    expect(backupRequest.input).toMatchObject({
      mode: "database-backup",
      inspectionPlan: {
        files: expect.arrayContaining([
          [expect.any(String), expect.objectContaining({ spellings: [f.registryOnly] })],
        ]),
      },
    });
    expect(backupRequest.databases).toContainEqual({
      path: f.registryOnly,
      sizeBytes: (await fs.stat(f.registryOnly, { bigint: true })).size,
    });
    expect(maintainedManifest.databases).toContainEqual(
      expect.objectContaining({ path: f.registryOnly, role: "agent", agentId: "registry-only" }),
    );
    expect(maintainedManifest.entries).toContainEqual(
      expect.objectContaining({ sourcePath: f.registryOnly, kind: "file", sqlite: true }),
    );
    expect(isolatedGenerations).not.toHaveBeenCalled();
    expect(isolatedSizes).not.toHaveBeenCalled();
    expect(await Promise.all(f.familyPaths.map((file) => fs.readFile(file)))).toEqual(f.family);
    expect(await Promise.all(f.external.map((source) => fs.readFile(source)))).toEqual(
      externalBytes,
    );
  } finally {
    await scope.close();
  }
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
      originalManifest = parseUpdateRecoveryBackupManifest(
        await fs.readFile(original.ref.manifestPath, "utf8"),
      );
    }
    const worker = vi.spyOn(inspection, "runUpdateStateInspectionWorker");
    const isolatedGenerations = vi.spyOn(candidateState, "readUpdateDatabaseGenerationsIsolated");
    const isolatedSizes = vi.spyOn(databaseSizes, "readUpdateStateDatabaseSizes");
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => {},
      assertDatabaseAccess: () => {},
    });
    try {
      const captured = await scope.run(() => {
        if (mode === "live-reads-admitted") {
          admitOpenClawMaintenanceLiveAuthorityReads(f.shared);
        }
        return f.captureOriginal(mode, { mode: "maintenance-owner" });
      });
      const manifest = parseUpdateRecoveryBackupManifest(
        await fs.readFile(captured.ref.manifestPath, "utf8"),
      );
      if (mode === "large") {
        expect(worker.mock.calls.map(([request]) => request.input.mode)).toEqual([
          "discover",
          "database-backup",
        ]);
        expect(isolatedGenerations).not.toHaveBeenCalled();
        expect(manifest.entries).toContainEqual(
          expect.objectContaining({ sourcePath: f.shared, kind: "file", sqlite: true }),
        );
      } else {
        assert(originalManifest);
        expect(manifest.entries).toEqual(originalManifest.entries);
        expect(isolatedGenerations).toHaveBeenCalledOnce();
        expect(isolatedSizes).toHaveBeenCalled();
        expect(worker).toHaveBeenCalledTimes(3);
      }
    } finally {
      await scope.close();
    }
  },
);

it("rejects an already-aborted in-process size inventory", async () => {
  const signal = AbortSignal.abort(new Error("inventory aborted"));
  await expect(
    databaseSizes.readUpdateStateDatabaseSizesInProcess(["never-read.sqlite"], signal),
  ).rejects.toBe(signal.reason);
});

it("retires only expired sealed standalone Doctor captures and preserves incomplete or linked copies", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    const day = 24 * 60 * 60_000;
    const store = resolveUpdateCaptureRoot(state.stateDir);
    const sealed = async (runId: string, ageDays: number, directory = path.join(store, runId)) => {
      const manifest = {
        schemaVersion: 2,
        kind: "update-recovery",
        generation: { kind: "baseline" },
        databases: [],
        runId,
        installRoot: state.root,
        stateDir: state.stateDir,
        configPath: state.configPath,
        configPaths: [state.configPath],
        creator: { host: "fixture", pid: 1, startIdentity: "1" },
        drivers: [],
        createdAt: new Date(now - ageDays * day).toISOString(),
        roots: [state.configPath],
        excludedRoots: [],
        protectedPaths: [state.configPath],
        entries: [
          { kind: "missing", sourcePath: state.configPath, sqlite: false, directory: false },
        ],
      };
      const raw = JSON.stringify(manifest);
      parseUpdateRecoveryBackupManifest(raw);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "manifest.json"), raw);
      expect(await getUpdateRunAsync(runId)).toBeUndefined();
      return directory;
    };
    const expired = await sealed(`doctor-${randomUUID()}`, 31);
    const recent = await sealed(`doctor-${randomUUID()}`, 1);
    const incomplete = path.join(store, `doctor-${randomUUID()}`);
    await fs.mkdir(incomplete);
    const update = await sealed(randomUUID(), 40);
    const linkedId = `doctor-${randomUUID()}`;
    const linkedTarget = await sealed(linkedId, 31, state.path("linked-capture"));
    const linked = path.join(store, linkedId);
    await fs.symlink(linkedTarget, linked, "dir");
    const assertCurrent = vi.fn();

    const result = await retireExpiredStandaloneDoctorCaptures({
      stateDir: state.stateDir,
      keepRunId: path.basename(recent),
      now,
      assertCurrent,
    });

    expect(result).toEqual({ retired: [expired], warnings: [] });
    expect(assertCurrent).toHaveBeenCalled();
    await expect(fs.lstat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    for (const retained of [recent, incomplete, update, linkedTarget]) {
      expect((await fs.lstat(retained)).isDirectory()).toBe(true);
    }
    expect((await fs.lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(linked)).toBe(linkedTarget);
  });
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
    const readGenerations = candidateState.readUpdateDatabaseGenerationsIsolated;
    vi.spyOn(candidateState, "readUpdateDatabaseGenerationsIsolated").mockImplementationOnce(
      async (...args) => {
        await mutate();
        return readGenerations(...args);
      },
    );
  }
  const capture = f.captureOriginal(`${change}-${phase}`);
  if (change === "content") {
    await expect(capture).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/Original update (file|resource) changed/),
      }),
    });
  } else {
    const { ref } = await capture;
    const manifest = parseUpdateRecoveryBackupManifest(await fs.readFile(ref.manifestPath, "utf8"));
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

it("retains an unsealed capture when the database changes after its snapshot", async () => {
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
  await expect(f.captureOriginal("changed")).rejects.toMatchObject({
    cause: expect.objectContaining({ message: expect.stringContaining("generation changed") }),
  });
  const directory = path.join(`${f.stateDir}.update-captures`, "changed");
  await expect(fs.lstat(path.join(directory, "manifest.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await fs.readdir(path.join(directory, "payload"))).length).toBeGreaterThan(0);
  using source = new DatabaseSync(f.shared, { readOnly: true });
  expect(source.prepare("SELECT value FROM payload ORDER BY rowid").all()).toEqual([
    { value: "retained" },
    { value: "later" },
  ]);
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
        using db = openNodeSqliteDatabase(entry.snapshotPath, { readOnly: true });
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
      }
    }
    expect(await Promise.all([f.shared, ...f.external].map((file) => fs.readFile(file)))).toEqual(
      originals,
    );
  },
);
