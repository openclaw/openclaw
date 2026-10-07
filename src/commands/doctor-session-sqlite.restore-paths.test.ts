import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { restoreSessionSqliteMigrationRun } from "./doctor-session-sqlite-restore.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  type TestStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  trustedMigrationTarget,
  canonicalTestPath,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

// Vitest canonicalizes TMPDIR; alias coverage needs the platform's /tmp path.
const lexicalRootTempDir = path.resolve("/tmp");
const realRootTempDir = canonicalTestPath(lexicalRootTempDir);
const hasPlatformRootTempAlias = lexicalRootTempDir !== realRootTempDir;

async function createRestoreFixture(tempRoot?: string) {
  const store = createLegacyStore({ tempRoot });
  const imported = await importLegacyStore(store);
  const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
  const manifest = readMigrationManifest(manifestPath);
  const target = expectDefined(manifest.targets[0], "restore target");
  const move = expectDefined(
    target.plannedMoves.find((candidate) => candidate.kind === "transcript"),
    "transcript move",
  );
  return {
    store,
    imported,
    manifestPath,
    manifest,
    target,
    move,
    save: () =>
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }),
    restore: () =>
      restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      }),
  };
}

function restoreAll(store: TestStore) {
  return runDoctorSessionSqlite({ allAgents: true, cfg: {}, env: store.env, mode: "restore" });
}

async function importWithIndexArchive(store: TestStore) {
  const imported = await importLegacyStore(store);
  const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
  const manifest = readMigrationManifest(manifestPath);
  const indexArchive = expectDefined(
    manifest.targets[0]?.plannedMoves.find((move) => move.kind === "legacy-store"),
    "legacy archive move",
  ).archivePath;
  return { manifestPath, manifest, indexArchive };
}

describe("runDoctorSessionSqlite", () => {
  it.skipIf(process.platform === "win32").each([
    { version: 1, location: "ancestor" },
    { version: 3, location: "source" },
    { version: 3, location: "archive" },
    { version: 3, location: "entry" },
    { version: 3, location: "traversal" },
  ] as const)(
    "refuses unsafe v$version restore paths ($location)",
    async ({ version, location }) => {
      const { store, manifestPath, manifest, target, move, save, restore } =
        await createRestoreFixture();
      if (version === 1) {
        manifest.manifestVersion = 1;
        for (const manifestTarget of manifest.targets) {
          for (const candidate of [
            ...manifestTarget.plannedMoves,
            ...manifestTarget.completedMoves,
          ]) {
            delete candidate.artifact;
          }
        }
        manifest.startedAt = "2999-01-01T00:00:00.000Z";
      }
      target.plannedMoves = [move];
      target.completedMoves = [move];
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
        fs.writeFileSync(outsidePath, '{"type":"outside"}\n', { mode: 0o600 });
        sourcePath = path.join(canonicalTestPath(store.sessionDir), "payload.jsonl");
        archivePath = path.join(archiveDir, "payload.jsonl");
        const traversal = {
          kind: "transcript" as const,
          sourcePath,
          archivePath: path.join(archiveDir, "escape", "..", "payload.jsonl"),
        };
        target.plannedMoves = [traversal];
        target.completedMoves = [traversal];
        reason = "source and archive are both missing";
      } else if (location === "entry") {
        outsidePath = path.join(store.tempDir, "outside-payload.jsonl");
        fs.writeFileSync(outsidePath, '{"type":"outside"}\n', { mode: 0o600 });
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
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(move.archivePath)).toBe(true);
      if (outsidePath) {
        expect(fs.existsSync(outsidePath)).toBe(true);
      }
    },
  );

  it.skipIf(!hasPlatformRootTempAlias).each([1, 3] as const)(
    "imports, previews, and restores v%s manifests through a platform root alias",
    async (version) => {
      const { store, imported, manifest, save, restore } =
        await createRestoreFixture(lexicalRootTempDir);
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
        const aliasPath = (file: string) =>
          path.join(lexicalRootTempDir, path.relative(realRootTempDir, file));
        manifest.manifestVersion = 1;
        for (const target of manifest.targets) {
          target.sqlitePath = aliasPath(target.sqlitePath);
          target.storePath = aliasPath(target.storePath);
          for (const move of [...target.plannedMoves, ...target.completedMoves]) {
            delete move.artifact;
            move.archivePath = aliasPath(move.archivePath);
            move.sourcePath = aliasPath(move.sourcePath);
          }
        }
        save();
      }
      const restored =
        version === 1
          ? await restore()
          : (
              await runDoctorSessionSqlite({
                env: store.env,
                mode: "restore",
                store: store.storePath,
              })
            ).targets[0]?.restore;
      expect(restored?.conflicts).toEqual([]);
      expect(restored?.restoredFiles).toContain(canonicalTestPath(store.transcriptPath));
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
      expect(fs.existsSync(store.storePath)).toBe(true);
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

    expect(restore.targets[0]?.restore?.manifestPaths).toEqual([]);
    expect(restore.targets[0]?.restore?.restoredFiles).toEqual([]);
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
  });

  it("reports restore conflicts without overwriting existing files", async () => {
    const store = createLegacyStore();
    const transcriptPath = canonicalTestPath(store.transcriptPath);
    await importLegacyStore(store);
    fs.writeFileSync(store.transcriptPath, '{"type":"event","id":"new"}\n', { mode: 0o600 });

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(restore.totals.issues).toBe(1);
    expect(restore.targets[0]?.restore?.conflicts[0]).toMatchObject({
      reason: "source and archive both exist; refusing to overwrite source",
      sourcePath: transcriptPath,
    });
    expect(fs.readFileSync(store.transcriptPath, "utf-8")).toBe('{"type":"event","id":"new"}\n');
  });

  it.each(["empty", "distinct", "missing", "invalid"] as const)(
    "selects an original index safely across later migrations (%s)",
    async (state) => {
      const store = createLegacyStore();
      const original = fs.readFileSync(store.storePath, "utf8");
      const { indexArchive: firstArchive } = await importWithIndexArchive(store);
      if (state === "missing") {
        fs.rmSync(firstArchive);
      } else if (state === "invalid") {
        fs.writeFileSync(firstArchive, "{broken", { mode: 0o600 });
      }
      const laterIndex =
        state === "distinct"
          ? `${JSON.stringify({ "agent:main:later": { channel: "cli", chatType: "direct", sessionFile: "session-2.jsonl", sessionId: "session-2", sessionStartedAt: 3000, updatedAt: 4000 } })}\n`
          : "{}\n";
      const laterArchives: string[] = [];
      // Archive names have collision handling; selection must not depend on elapsed milliseconds.
      for (let run = 0; run < (state === "empty" ? 2 : 1); run++) {
        fs.writeFileSync(store.storePath, laterIndex, { mode: 0o600 });
        laterArchives.push((await importWithIndexArchive(store)).indexArchive);
      }
      const restore = await restoreAll(store);
      const restored = expectDefined(
        restore.targets.find((target) => target.restore)?.restore,
        "aggregate restore report",
      );
      for (const archive of laterArchives) {
        expect(fs.readFileSync(archive, "utf8")).toBe(laterIndex);
      }
      if (state === "empty") {
        expect(fs.readFileSync(store.storePath, "utf8")).toBe(original);
        expect(restored.conflicts).toEqual([]);
        expect(restore.totals.issues).toBe(0);
        return;
      }
      expect(fs.existsSync(store.storePath)).toBe(false);
      const conflicts = restored.conflicts.filter((conflict) =>
        [firstArchive, ...laterArchives].includes(conflict.archivePath),
      );
      expect(conflicts).toHaveLength(2);
      if (state === "distinct") {
        expect(new Set(conflicts.map((conflict) => conflict.reason))).toEqual(
          new Set([
            "multiple distinct nonempty session indexes require explicit archive selection",
          ]),
        );
        expect(fs.readFileSync(firstArchive, "utf8")).toBe(original);
        expect(restore.totals.issues).toBeGreaterThan(0);
      } else {
        if (state === "invalid") {
          expect(fs.readFileSync(firstArchive, "utf8")).toBe("{broken");
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
      await importWithIndexArchive(store);
    const sourcePaths = readMigrationManifest(firstManifestPath).targets[0]!.plannedMoves.map(
      (move) => move.sourcePath,
    );
    await restoreAll(store);
    expect(readMigrationManifest(firstManifestPath).restore?.consumedArchives).toContain(
      firstArchive,
    );
    // Shipped manifests recorded only restored source paths. Exercise the additive-field upgrade
    // path instead of relying only on provenance written by this version.
    const shippedManifest = readMigrationManifest(firstManifestPath);
    if (shippedManifest.restore) {
      delete shippedManifest.restore.consumedArchives;
    }
    fs.writeFileSync(firstManifestPath, `${JSON.stringify(shippedManifest, null, 2)}\n`, {
      mode: 0o600,
    });
    const { manifestPath: secondManifestPath, indexArchive: secondArchive } =
      await importWithIndexArchive(store);

    const restore = await restoreAll(store);

    // The first run's archives were consumed by the first restore, so only the second run can
    // reclaim these paths. The spent moves must not report as missing-archive failures.
    expect(restore.targets[0]?.restore?.conflicts).toEqual([]);
    expect(restore.totals.issues).toBe(0);
    expect(restore.targets[0]?.restore?.restoredFiles).toContain(
      canonicalTestPath(store.storePath),
    );
    expect(fs.readFileSync(store.storePath, "utf-8")).toContain("agent:main:main");
    expect(readMigrationManifest(firstManifestPath).restore?.consumedArchives).toContain(
      firstArchive,
    );
    expect(readMigrationManifest(secondManifestPath).restore?.consumedArchives).toContain(
      secondArchive,
    );
    const repeated = await restoreAll(store);
    expect(repeated.totals.issues).toBe(0);
    expect(repeated.targets[0]?.restore?.restoredFiles).toEqual([]);
    expect(repeated.targets[0]?.restore?.skippedFiles).toEqual(expect.arrayContaining(sourcePaths));
  });
});
