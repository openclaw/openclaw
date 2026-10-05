import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import * as migrationArtifact from "../infra/session-sqlite-migration-artifact.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  type TestStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  canonicalTestPaths,
  canonicalTestPath,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

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
  it.each(["missing-database", "missing-database-all-agents", "planned-only"] as const)(
    "restores archived artifacts with %s recovery evidence",
    async (state) => {
      const store = createLegacyStore();
      const imported = await importLegacyStore(store);
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = expectDefined(manifest.targets[0], "restore target");
      const sourcePaths = target.plannedMoves.map((move) => move.sourcePath);
      if (state === "planned-only") {
        target.completedMoves = [];
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      } else {
        const sqlitePath = expectDefined(imported.targets[0]?.sqlitePath, "imported SQLite path");
        closeOpenClawAgentDatabasesForTest();
        for (const file of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
          fs.rmSync(file, { force: true });
        }
      }
      const restore = await runDoctorSessionSqlite({
        ...(state !== "missing-database" ? { allAgents: true } : {}),
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
      expect(restore.targets[0]?.restore?.restoredFiles).toEqual(
        expect.arrayContaining(canonicalTestPaths([store.transcriptPath, store.trajectoryPath])),
      );
      for (const file of [
        store.transcriptPath,
        store.trajectoryPath,
        store.unreferencedJsonlPath,
      ]) {
        expect(fs.existsSync(file)).toBe(true);
      }
    },
  );

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

    const restore = await restoreAll(store);

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
