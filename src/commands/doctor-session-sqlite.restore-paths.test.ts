import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { SessionSqliteMigrationMoveKind } from "../infra/session-sqlite-migration-manifest.js";
import { closeOpenClawAgentDatabasesForTest as closeDatabases } from "../state/openclaw-agent-db.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { restoreSessionSqliteMigrationRun as restoreRun } from "./doctor-session-sqlite-restore.js";
import {
  writePrivateFile,
  runStoreDoctor,
  importManifest,
  expectPresent,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  expectMissing,
  expectFiles,
  writeManifest,
  contains,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import {
  importLegacyStore,
  type TestStore,
  readMigrationManifest as readManifest,
  trustedMigrationTarget,
  canonicalTestPath,
  canonicalTestPaths,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

// Vitest canonicalizes TMPDIR; alias coverage needs the platform's /tmp path.
const lexicalRootTempDir = path.resolve("/tmp");
const realRootTempDir = canonicalTestPath(lexicalRootTempDir);
const hasPlatformRootTempAlias = lexicalRootTempDir !== realRootTempDir;

async function createRestoreFixture(store = createLegacyStore()) {
  const fixture = await importManifest(store);
  const { manifestPath, manifest, target } = fixture;
  const moveFor = (kind: SessionSqliteMigrationMoveKind) =>
    expectDefined(
      target.plannedMoves.find((candidate) => candidate.kind === kind),
      kind,
    );
  return {
    store,
    ...fixture,
    moveFor,
    indexArchive: moveFor("legacy-store").archivePath,
    save: () => writeManifest(manifestPath, manifest),
    legacy: (rewrite = (file: string) => file) => {
      manifest.manifestVersion = 1;
      for (const manifestTarget of manifest.targets) {
        manifestTarget.sqlitePath = rewrite(manifestTarget.sqlitePath);
        manifestTarget.storePath = rewrite(manifestTarget.storePath);
        for (const move of [...manifestTarget.plannedMoves, ...manifestTarget.completedMoves]) {
          delete move.artifact;
          move.archivePath = rewrite(move.archivePath);
          move.sourcePath = rewrite(move.sourcePath);
        }
      }
    },
    restore: () =>
      restoreRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      }),
  };
}

function restoreAll(store: TestStore, allAgents = true) {
  return runDoctorSessionSqlite({ allAgents, cfg: {}, env: store.env, mode: "restore" });
}

it.each(["missing-database", "missing-database-all-agents", "planned-only"] as const)(
  "restores archived artifacts with %s recovery evidence",
  async (state) => {
    const { store, target, save } = await createRestoreFixture();
    const sourcePaths = target.plannedMoves.map((move) => move.sourcePath);
    if (state === "planned-only") {
      target.completedMoves = [];
      save();
    } else {
      const { sqlitePath } = target;
      closeDatabases();
      for (const file of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
        fs.rmSync(file, { force: true });
      }
    }
    const restore = await restoreAll(store, state !== "missing-database");
    expect(restore.totals.issues).toBe(0);
    expect(restore.totals).not.toHaveProperty("archivedLegacyStoreFiles");
    expect(restore.totals).not.toHaveProperty("reclaimedBytes");
    expect(restore.targets[0]?.restore).toMatchObject({
      conflicts: [],
      restoredFiles: expect.arrayContaining(sourcePaths),
    });
    contains(
      restore.targets[0]?.restore?.restoredFiles,
      ...canonicalTestPaths([store.transcriptPath, store.trajectoryPath]),
    );
    expectPresent(store.transcriptPath, store.trajectoryPath, store.unreferencedJsonlPath);
  },
);

it.skipIf(process.platform === "win32").each([
  { version: 1, location: "ancestor" },
  { version: 3, location: "source" },
  { version: 3, location: "archive" },
  { version: 3, location: "entry" },
  { version: 3, location: "traversal" },
] as const)("refuses unsafe v$version restore paths ($location)", async ({ version, location }) => {
  const { store, manifestPath, manifest, target, moveFor, save, restore, legacy } =
    await createRestoreFixture();
  const move = moveFor("transcript");
  const originalArchivePath = move.archivePath;
  if (version === 1) {
    legacy();
    manifest.startedAt = "2999-01-01T00:00:00.000Z";
  }
  target.plannedMoves = target.completedMoves = [move];
  let outsidePath: string | undefined;
  let sourcePath = move.sourcePath;
  let archivePath = move.archivePath;
  let reason = "source or archive parent is a symbolic link; refusing restore";
  if (location === "traversal") {
    const archiveDir = path.dirname(move.archivePath);
    const outsideDir = path.join(store.tempDir, "outside", "nested");
    outsidePath = path.join(path.dirname(outsideDir), "payload.jsonl");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(archiveDir, "escape"));
    writePrivateFile(outsidePath, '{"type":"outside"}\n');
    sourcePath = path.join(canonicalTestPath(store.sessionDir), "payload.jsonl");
    archivePath = path.join(archiveDir, "payload.jsonl");
    move.sourcePath = sourcePath;
    move.archivePath = path.join(archiveDir, "escape", "..", "payload.jsonl");
    delete move.artifact;
    reason = "source and archive are both missing";
  } else if (location === "entry") {
    outsidePath = path.join(store.tempDir, "outside-payload.jsonl");
    writePrivateFile(outsidePath, '{"type":"outside"}\n');
    fs.rmSync(move.archivePath);
    fs.symlinkSync(outsidePath, move.archivePath);
    reason = "archive is not a regular file; refusing restore";
  }
  save();
  if (location === "ancestor" || location === "source" || location === "archive") {
    const original =
      location === "ancestor"
        ? path.dirname(store.sessionDir)
        : location === "source"
          ? store.sessionDir
          : path.dirname(move.archivePath);
    const relocated = path.join(store.tempDir, `relocated-${location}`);
    fs.renameSync(original, relocated);
    fs.symlinkSync(relocated, original);
  }
  const restored = await restore();
  expect(restored.conflicts).toEqual([
    version === 1
      ? {
          archivePath: manifestPath,
          sourcePath: manifestPath,
          reason: "manifest is missing or unreadable",
        }
      : { archivePath, sourcePath, reason },
  ]);
  expect(restored.restoredFiles).toEqual([]);
  expectMissing(sourcePath);
  expectPresent(originalArchivePath);
  if (outsidePath) {
    expectPresent(outsidePath);
  }
});

it.skipIf(!hasPlatformRootTempAlias).each([1, 3] as const)(
  "imports, previews, and restores v%s manifests through a platform root alias",
  async (version) => {
    const { store, imported, manifest, save, restore, legacy } = await createRestoreFixture(
      createLegacyStore({ tempRoot: lexicalRootTempDir }),
    );
    expect(imported.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(manifest.targets[0]?.storePath).toBe(
      path.join(realRootTempDir, path.relative(lexicalRootTempDir, store.storePath)),
    );
    expect(
      manifest.targets[0]?.completedMoves.every((move) =>
        move.sourcePath.startsWith(realRootTempDir + path.sep),
      ),
    ).toBe(true);
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    expect(preview.artifacts.some((artifact) => artifact.runs.length > 0)).toBe(true);
    if (version === 1) {
      legacy((file) => path.join(lexicalRootTempDir, path.relative(realRootTempDir, file)));
      save();
    }
    const restored =
      version === 1
        ? await restore()
        : (await runStoreDoctor(store, "restore")).targets[0]?.restore;
    expect(restored).toMatchObject({
      conflicts: [],
      restoredFiles: expect.arrayContaining([canonicalTestPath(store.transcriptPath)]),
    });
    expectPresent(store.transcriptPath, store.storePath);
  },
);

it("does not restore unrelated manifests for an unmatched explicit store selector", async () => {
  const store = createLegacyStore();
  await importLegacyStore(store);

  const restore = await runDoctorSessionSqlite({
    env: store.env,
    mode: "restore",
    store: path.join(store.tempDir, "missing", "sessions.json"),
  });

  expect(restore.targets[0]?.restore).toMatchObject({ manifestPaths: [], restoredFiles: [] });
  expectMissing(store.transcriptPath);
});

it("reports restore conflicts without overwriting existing files", async () => {
  const store = createLegacyStore();
  const transcriptPath = canonicalTestPath(store.transcriptPath);
  await importLegacyStore(store);
  writePrivateFile(store.transcriptPath, '{"type":"event","id":"new"}\n');

  const restore = await restoreAll(store);

  expect(restore.totals.issues).toBe(1);
  expect(restore.targets[0]?.restore?.conflicts[0]).toMatchObject({
    reason: "source and archive both exist; refusing to overwrite source",
    sourcePath: transcriptPath,
  });
  expectFiles('{"type":"event","id":"new"}\n', store.transcriptPath);
});

it.each(["empty", "distinct", "missing", "invalid"] as const)(
  "selects an original index safely across later migrations (%s)",
  async (state) => {
    const store = createLegacyStore();
    const original = fs.readFileSync(store.storePath, "utf8");
    const { indexArchive: firstArchive } = await createRestoreFixture(store);
    if (state === "missing") {
      fs.rmSync(firstArchive);
    } else if (state === "invalid") {
      writePrivateFile(firstArchive, "{broken");
    }
    const laterIndex =
      state === "distinct"
        ? `${JSON.stringify({ "agent:main:later": { sessionId: "session-2", updatedAt: 4000 } })}\n`
        : "{}\n";
    const laterArchives: string[] = [];
    // Archive names have collision handling; selection must not depend on elapsed milliseconds.
    for (let run = 0; run < (state === "empty" ? 2 : 1); run++) {
      writePrivateFile(store.storePath, laterIndex);
      laterArchives.push((await createRestoreFixture(store)).indexArchive);
    }
    const restore = await restoreAll(store);
    const restored = expectDefined(
      restore.targets.find((target) => target.restore)?.restore,
      "aggregate restore report",
    );
    for (const archive of laterArchives) {
      expectFiles(laterIndex, archive);
    }
    if (state === "empty") {
      expectFiles(original, store.storePath);
      expect(restored.conflicts).toEqual([]);
      expect(restore.totals.issues).toBe(0);
      return;
    }
    expectMissing(store.storePath);
    const conflicts = restored.conflicts.filter((conflict) =>
      [firstArchive, ...laterArchives].includes(conflict.archivePath),
    );
    expect(conflicts).toHaveLength(2);
    if (state === "distinct") {
      expect(new Set(conflicts.map((conflict) => conflict.reason))).toEqual(
        new Set(["multiple distinct nonempty session indexes require explicit archive selection"]),
      );
      expectFiles(original, firstArchive);
      expect(restore.totals.issues).toBeGreaterThan(0);
    } else {
      if (state === "invalid") {
        expectFiles("{broken", firstArchive);
      }
      expect(conflicts.map((conflict) => conflict.reason)).toEqual(
        expect.arrayContaining([
          state === "missing"
            ? "archive is missing without a recorded prior restore; refusing another candidate"
            : "session index archive is not valid JSON; refusing automatic selection",
          "another archive for this source is unavailable without prior restore evidence; refusing automatic selection",
        ]),
      );
    }
  },
);

it("keeps restore clean when a later migration re-archived an already restored path", async () => {
  const store = createLegacyStore();
  const { manifestPath: firstManifestPath, indexArchive: firstArchive } =
    await createRestoreFixture(store);
  const sourcePaths = readManifest(firstManifestPath).targets[0]!.plannedMoves.map(
    (move) => move.sourcePath,
  );
  await restoreAll(store);
  expect(readManifest(firstManifestPath).restore?.consumedArchives).toContain(firstArchive);
  // Shipped receipts had restored paths but no consumedArchives field.
  const shippedManifest = readManifest(firstManifestPath);
  if (shippedManifest.restore) {
    delete shippedManifest.restore.consumedArchives;
  }
  writeManifest(firstManifestPath, shippedManifest);
  const { manifestPath: secondManifestPath, indexArchive: secondArchive } =
    await createRestoreFixture(store);

  const restore = await restoreAll(store);

  expect(restore.totals.issues).toBe(0);
  expect(restore.targets[0]?.restore).toMatchObject({
    conflicts: [],
    restoredFiles: expect.arrayContaining([canonicalTestPath(store.storePath)]),
  });
  expect(fs.readFileSync(store.storePath, "utf-8")).toContain("agent:main:main");
  expect(readManifest(firstManifestPath).restore?.consumedArchives).toContain(firstArchive);
  expect(readManifest(secondManifestPath).restore?.consumedArchives).toContain(secondArchive);
  const repeated = await restoreAll(store);
  expect(repeated.totals.issues).toBe(0);
  expect(repeated.targets[0]?.restore).toMatchObject({
    restoredFiles: [],
    skippedFiles: expect.arrayContaining(sourcePaths),
  });
});
