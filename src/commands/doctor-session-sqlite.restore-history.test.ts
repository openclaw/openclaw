import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import * as migrationArtifact from "./doctor-session-sqlite-artifact.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  canonicalTestPaths,
  canonicalTestPath,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it("restores archived artifacts from the migration manifest", async () => {
    const store = createLegacyStore();
    const importReport = await importLegacyStore(store);
    const manifest = readMigrationManifest(importReport.migrationRun?.manifestPath);
    const sourcePaths = manifest.targets[0]?.plannedMoves.map((move) => move.sourcePath) ?? [];

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(restore.totals.issues).toBe(0);
    expect(restore.totals).not.toHaveProperty("archivedLegacyStoreFiles");
    expect(restore.totals).not.toHaveProperty("reclaimedBytes");
    expect(restore.targets[0]?.restore).toMatchObject({
      conflicts: [],
      restoredFiles: expect.arrayContaining(sourcePaths),
    });
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
    expect(fs.existsSync(store.trajectoryPath)).toBe(true);
    expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(true);
  });

  it.each([false, true])(
    "restores archived artifacts after the replacement SQLite file is removed (allAgents=%s)",
    async (allAgents) => {
      const store = createLegacyStore();
      const importReport = await importLegacyStore(store);
      const sqlitePath = importReport.targets[0]?.sqlitePath;
      if (!sqlitePath) {
        throw new Error("expected imported SQLite path");
      }
      closeOpenClawAgentDatabasesForTest();
      for (const filePath of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
        fs.rmSync(filePath, { force: true });
      }

      const restore = await runDoctorSessionSqlite({
        ...(allAgents ? { allAgents: true } : {}),
        cfg: {},
        env: store.env,
        mode: "restore",
      });

      expect(restore.totals.issues).toBe(0);
      expect(restore.targets[0]?.restore?.restoredFiles).toEqual(
        expect.arrayContaining(canonicalTestPaths([store.transcriptPath, store.trajectoryPath])),
      );
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
    },
  );

  it("restores planned moves when a crash prevented completed move recording", async () => {
    const store = createLegacyStore();
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    expectDefined(manifest.targets[0], "manifest.targets[0] test invariant").completedMoves = [];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(restore.totals.issues).toBe(0);
    expect(restore.targets[0]?.restore?.restoredFiles).toEqual(
      expect.arrayContaining(canonicalTestPaths([store.transcriptPath, store.trajectoryPath])),
    );
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
    expect(fs.existsSync(store.trajectoryPath)).toBe(true);
  });

  it("restores the pre-migration session index when several manifests share one store", async () => {
    const store = createLegacyStore();
    const preMigrationIndex = fs.readFileSync(store.storePath, "utf-8");
    await importLegacyStore(store);
    const emptyArchivePaths: string[] = [];
    // Legacy writers recreate an empty index after a migration archived the real one, so later
    // runs archive that empty file. `persistLegacySessionStore` writes exactly these 3 bytes.
    for (let laterRun = 0; laterRun < 2; laterRun += 1) {
      // Run ids and archive names embed Date.now(), so keep the runs in distinct milliseconds.
      await new Promise((resolve) => {
        setTimeout(resolve, 2);
      });
      fs.writeFileSync(store.storePath, "{}\n", { mode: 0o600 });
      const importReport = await importLegacyStore(store);
      const manifest = readMigrationManifest(importReport.migrationRun?.manifestPath);
      emptyArchivePaths.push(
        expectDefined(
          manifest.targets[0]?.plannedMoves.find((move) => move.kind === "legacy-store"),
          "empty legacy archive move",
        ).archivePath,
      );
    }

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(fs.readFileSync(store.storePath, "utf-8")).toBe(preMigrationIndex);
    expect(restore.targets[0]?.restore?.conflicts).toEqual([]);
    expect(restore.totals.issues).toBe(0);
    for (const archivePath of emptyArchivePaths) {
      expect(fs.readFileSync(archivePath, "utf-8")).toBe("{}\n");
    }
  });

  it("streams duplicate large transcript archives while selecting an identical restore", async () => {
    const transcriptLines = [
      JSON.stringify({ type: "session", id: "session-1", version: 3 }),
      JSON.stringify({
        type: "message",
        id: "large",
        parentId: null,
        message: { role: "user", content: "x".repeat(4 * 1024 * 1024) },
      }),
    ];
    const largeTranscript = `${transcriptLines.join("\n")}\n`;
    const store = createLegacyStore({ transcriptLines });
    const importReport = await importLegacyStore(store);
    const firstManifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const firstManifest = readMigrationManifest(firstManifestPath);
    const firstTarget = expectDefined(firstManifest.targets[0], "first migration target");
    const transcriptMove = expectDefined(
      firstTarget.plannedMoves.find((move) => move.kind === "transcript"),
      "transcript archive move",
    );
    const secondArchivePath = `${transcriptMove.archivePath}.duplicate`;
    fs.copyFileSync(transcriptMove.archivePath, secondArchivePath);
    const duplicateMove = {
      ...transcriptMove,
      archivePath: secondArchivePath,
      artifact: {
        ...expectDefined(transcriptMove.artifact, "original transcript identity"),
        identity: migrationArtifact.readMigrationArtifactIdentity(secondArchivePath),
      },
    };
    const duplicateManifest = structuredClone(firstManifest);
    duplicateManifest.runId = `${firstManifest.runId}-duplicate`;
    duplicateManifest.startedAt = new Date(Date.parse(firstManifest.startedAt) + 1).toISOString();
    duplicateManifest.targets = [
      {
        ...firstTarget,
        completedMoves: [duplicateMove],
        plannedMoves: [duplicateMove],
      },
    ];
    const duplicateManifestPath = path.join(
      path.dirname(firstManifestPath),
      `${duplicateManifest.runId}.json`,
    );
    fs.writeFileSync(duplicateManifestPath, `${JSON.stringify(duplicateManifest, null, 2)}\n`, {
      mode: 0o600,
    });

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    const restoreReport = expectDefined(
      restore.targets.find((target) => target.restore)?.restore,
      "aggregate restore report",
    );
    expect(restoreReport.conflicts).toEqual([]);
    expect(restore.totals.issues).toBe(0);
    expect(fs.statSync(store.transcriptPath).size).toBe(Buffer.byteLength(largeTranscript));
    expect(fs.readFileSync(store.transcriptPath, "utf-8")).toBe(largeTranscript);
    expect([transcriptMove.archivePath, secondArchivePath].filter(fs.existsSync)).toHaveLength(1);
  });

  it("fails closed when several manifests contain distinct nonempty session indexes", async () => {
    const store = createLegacyStore();
    const preMigrationIndex = fs.readFileSync(store.storePath, "utf-8");
    const firstImport = await importLegacyStore(store);
    const firstArchive = expectDefined(
      readMigrationManifest(firstImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "first legacy archive move",
    ).archivePath;
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    // An older binary can still write real sessions to the legacy store after the migration.
    const laterIndex = `${JSON.stringify({ "agent:main:later": { channel: "cli", chatType: "direct", sessionFile: "session-2.jsonl", sessionId: "session-2", sessionStartedAt: 3000, updatedAt: 4000 } }, null, 2)}\n`;
    fs.writeFileSync(store.storePath, laterIndex, { mode: 0o600 });
    const secondImport = await importLegacyStore(store);
    const secondArchive = expectDefined(
      readMigrationManifest(secondImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "second legacy archive move",
    ).archivePath;

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(fs.existsSync(store.storePath)).toBe(false);
    const restoreReport = expectDefined(
      restore.targets.find((target) => target.restore)?.restore,
      "aggregate restore report",
    );
    const storeConflicts = restoreReport.conflicts.filter((conflict) =>
      [firstArchive, secondArchive].includes(conflict.archivePath),
    );
    expect(storeConflicts).toHaveLength(2);
    expect(new Set(storeConflicts.map((conflict) => conflict.reason))).toEqual(
      new Set(["multiple distinct nonempty session indexes require explicit archive selection"]),
    );
    expect(fs.readFileSync(firstArchive, "utf-8")).toBe(preMigrationIndex);
    expect(fs.readFileSync(secondArchive, "utf-8")).toBe(laterIndex);
    expect(restore.totals.issues).toBeGreaterThan(0);
  });

  it("does not hide a missing original archive behind a later empty session index", async () => {
    const store = createLegacyStore();
    const firstImport = await importLegacyStore(store);
    const firstArchive = expectDefined(
      readMigrationManifest(firstImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "first legacy archive move",
    ).archivePath;
    fs.rmSync(firstArchive);
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    fs.writeFileSync(store.storePath, "{}\n", { mode: 0o600 });
    const secondImport = await importLegacyStore(store);
    const secondArchive = expectDefined(
      readMigrationManifest(secondImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "second legacy archive move",
    ).archivePath;

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(fs.existsSync(store.storePath)).toBe(false);
    expect(fs.readFileSync(secondArchive, "utf-8")).toBe("{}\n");
    const restoreReport = expectDefined(
      restore.targets.find((target) => target.restore)?.restore,
      "aggregate restore report",
    );
    const storeConflicts = restoreReport.conflicts.filter((conflict) =>
      [firstArchive, secondArchive].includes(conflict.archivePath),
    );
    expect(storeConflicts).toHaveLength(2);
    expect(storeConflicts.map((conflict) => conflict.reason)).toEqual(
      expect.arrayContaining([
        "archive is missing without a recorded prior restore; refusing another candidate",
        "another archive for this source is unavailable without prior restore evidence; refusing automatic selection",
      ]),
    );
  });

  it("does not replace an invalid original archive with a later empty session index", async () => {
    const store = createLegacyStore();
    const firstImport = await importLegacyStore(store);
    const firstArchive = expectDefined(
      readMigrationManifest(firstImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "first legacy archive move",
    ).archivePath;
    fs.writeFileSync(firstArchive, "{broken", { mode: 0o600 });
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    fs.writeFileSync(store.storePath, "{}\n", { mode: 0o600 });
    const secondImport = await importLegacyStore(store);
    const secondArchive = expectDefined(
      readMigrationManifest(secondImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "second legacy archive move",
    ).archivePath;

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(fs.existsSync(store.storePath)).toBe(false);
    expect(fs.readFileSync(firstArchive, "utf-8")).toBe("{broken");
    expect(fs.readFileSync(secondArchive, "utf-8")).toBe("{}\n");
    const restoreReport = expectDefined(
      restore.targets.find((target) => target.restore)?.restore,
      "aggregate restore report",
    );
    const storeConflicts = restoreReport.conflicts.filter((conflict) =>
      [firstArchive, secondArchive].includes(conflict.archivePath),
    );
    expect(storeConflicts).toHaveLength(2);
    expect(storeConflicts.map((conflict) => conflict.reason)).toEqual(
      expect.arrayContaining([
        "session index archive is not valid JSON; refusing automatic selection",
        "another archive for this source is unavailable without prior restore evidence; refusing automatic selection",
      ]),
    );
  });

  it("keeps restore clean when a later migration re-archived an already restored path", async () => {
    const store = createLegacyStore();
    const firstImport = await importLegacyStore(store);
    const firstManifestPath = requireMigrationManifestPath(firstImport.migrationRun?.manifestPath);
    const firstArchive = expectDefined(
      readMigrationManifest(firstManifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "first legacy archive move",
    ).archivePath;
    await runDoctorSessionSqlite({ allAgents: true, cfg: {}, env: store.env, mode: "restore" });
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
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    const secondImport = await importLegacyStore(store);
    const secondManifestPath = requireMigrationManifestPath(
      secondImport.migrationRun?.manifestPath,
    );
    const secondArchive = expectDefined(
      readMigrationManifest(secondManifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "second legacy archive move",
    ).archivePath;

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

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
  });
});
