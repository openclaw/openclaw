import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import {
  readMigrationArtifactIdentity,
  type MigrationArtifact,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationTargetManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  collectRecoveryInventory,
  protectRecoveryDependencies,
  type RecoveryArtifactReference,
  type RecoveryCleanupReport,
} from "./doctor-session-sqlite-recovery-inventory.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

function hasSettledDuplicate(manifest: ActiveSessionSqliteMigrationRun["manifest"] | undefined) {
  return manifest?.targets.some((target) =>
    target.issues.some((issue) => issue.code === "historical_duplicate_settled"),
  );
}

function recoveryGraph(transcripts: number) {
  const target: SessionSqliteMigrationTargetManifest = {
    agentId: "main",
    storePath: "/synthetic/sessions/sessions.json",
    sqlitePath: "/synthetic/agent/openclaw-agent.sqlite",
    issues: [],
    validationBeforeArchive: "passed",
    completedMoves: [],
    plannedMoves: Array.from({ length: transcripts + 1 }, (_, i) => ({
      kind: i === 0 ? "legacy-store" : "transcript",
      sourcePath: `/synthetic/sessions/${i === 0 ? "sessions.json" : `${i}.jsonl`}`,
      archivePath: `/synthetic/archive/${i}.original`,
    })),
  };
  target.completedMoves = [...target.plannedMoves];
  const run: ActiveSessionSqliteMigrationRun = {
    manifestPath: "/synthetic/run.json",
    manifest: {
      manifestVersion: 2,
      openClawVersion: "test",
      runId: "test",
      startedAt: "2030-01-01",
      completedAt: "2030-01-01",
      targets: [target],
    },
  };
  const refs = new Map<string, RecoveryArtifactReference[]>(
    target.plannedMoves.map((move) => [
      move.archivePath,
      [{ run, target, move, trusted: true, consumedByRestore: false }],
    ]),
  );
  const artifacts: RecoveryCleanupReport["artifacts"] = target.plannedMoves.map((move) => ({
    path: move.archivePath,
    runs: ["test"],
    bytes: 1,
    outcome: "verification-required",
    reason: "historical-manifest-without-import-proof",
  }));
  artifacts[artifacts.length - 1]!.outcome = "blocked";
  return { target, refs, artifacts };
}

function createRetainedDuplicateArchives(state: OpenClawTestState) {
  const sessions = state.sessionsDir();
  fs.mkdirSync(sessions, { recursive: true });
  const storePath = path.join(sessions, "sessions.json");
  const target = {
    agentId: "main",
    storePath,
    sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath }, state.env),
  };
  const archiveDir = path.join(path.dirname(sessions), "session-sqlite-import-archive");
  fs.mkdirSync(archiveDir);
  const bytes = `${JSON.stringify({ type: "session", id: "duplicate", version: 3, timestamp: "2026-09-01T00:00:00Z", cwd: "/synthetic" })}\n`;
  function recordRun(runMoves: SessionSqliteMigrationMove[], failed = false) {
    const run = createSessionSqliteMigrationRun(state.env, [target]);
    recordPlannedMigrationMoves(run, target, runMoves);
    recordCompletedMigrationMoves(run, target, runMoves);
    updateMigrationManifestTarget(run, target, [], { validationBeforeArchive: "passed" });
    run.manifest[failed ? "failedAt" : "completedAt"] = run.manifest.startedAt;
    writeSessionSqliteMigrationManifest(run);
    return run;
  }
  const moves = [1, 2].map((copy) => {
    const archivePath = path.join(archiveDir, `duplicate.jsonl.imported-${copy}`);
    fs.writeFileSync(archivePath, bytes);
    const move: SessionSqliteMigrationMove = {
      kind: "unreferenced-jsonl",
      sourcePath: path.join(sessions, "duplicate.jsonl"),
      archivePath,
      artifact: {
        identity: readMigrationArtifactIdentity(archivePath),
        classification: "protected",
        reason: "unreferenced-history",
        dependencies: [],
        disposal: { state: "retained" },
      },
    };
    recordRun([move]);
    return move;
  });
  return {
    archiveDir,
    bytes,
    archives: moves.map((move) => move.archivePath),
    moves,
    recordRun,
    doctor: (mode: "import" | "recover" | "dry-run") =>
      runDoctorSessionSqlite({ mode, store: storePath, env: state.env }),
    inventory: () => collectRecoveryInventory({ cfg: {}, env: state.env }),
  };
}

it("preserves the latest failed run's rollback when duplicate references are coalesced", async () => {
  await withOpenClawTestState({ label: "doctor-duplicate-restore-first" }, async (state) => {
    const { bytes, moves, recordRun, doctor, inventory } = createRetainedDuplicateArchives(state);
    // This run owns only the later copy; another manifest retains the equivalent survivor.
    const failed = recordRun([moves[1]!], true);

    const recovered = await doctor("recover");
    expect(recovered.targets[0]!.restore).toMatchObject({
      conflicts: [],
      restoredFiles: [moves[1]!.sourcePath],
    });
    const manifest = migrationRun.readSessionSqliteMigrationManifest(failed.manifestPath)!;
    expect(manifest.restore?.consumedArchives).toContain(
      manifest.targets[0]!.completedMoves[0]!.archivePath,
    );
    const retained = inventory();
    const survivingFiles = [moves[1]!.sourcePath, ...retained.references.keys()].filter((file) =>
      fs.existsSync(file),
    );
    expect(survivingFiles.length).toBeGreaterThan(0);
    for (const file of survivingFiles) {
      expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    }
    expect(retained.report.artifacts.map(({ reason }) => reason)).not.toContain(
      "unexpectedly-missing-artifact",
    );
  });
});

it.each(["disposal", "manifest-publication"] as const)(
  "recovers duplicate retirement interrupted during %s",
  async (phase) => {
    await withOpenClawTestState({ label: `doctor-duplicate-${phase}-recovery` }, async (state) => {
      const { archiveDir, bytes, archives, moves, recordRun, doctor, inventory } =
        createRetainedDuplicateArchives(state);
      if (phase === "manifest-publication") {
        for (let attempt = 0; attempt < 2; attempt++) {
          recordRun(moves);
        }
      }
      const unlink = fs.unlinkSync;
      const publish = migrationRun.writeSessionSqliteMigrationManifest;
      let coalescedWrites = 0;
      const interrupted =
        phase === "disposal"
          ? vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
              if (
                typeof file === "string" &&
                path.dirname(file) === archiveDir &&
                path.basename(file).startsWith(".cleanup-")
              ) {
                throw new Error("injected duplicate disposal interruption");
              }
              unlink(file);
            })
          : vi
              .spyOn(migrationRun, "writeSessionSqliteMigrationManifest")
              .mockImplementation((run) => {
                if (hasSettledDuplicate(run.manifest) && ++coalescedWrites === 3) {
                  throw new Error("injected partial manifest coalescing");
                }
                publish(run);
              });
      try {
        const importing = doctor("import");
        if (phase === "disposal") {
          const imported = await importing;
          expect(imported.targets.flatMap((item) => item.issues)).toContainEqual(
            expect.objectContaining({
              code: "historical_transcript_deferred",
              message: expect.stringContaining("injected duplicate disposal interruption"),
            }),
          );
        } else {
          await expect(importing).rejects.toThrow("injected partial manifest coalescing");
        }
      } finally {
        interrupted.mockRestore();
      }
      const before = inventory();
      const survivors = archives.filter((file) => fs.existsSync(file));
      expect(survivors).toHaveLength(1);
      const survivorPath = survivors[0]!;
      const retiredPath = archives.find((file) => file !== survivorPath)!;
      if (phase === "disposal") {
        const pending = [...before.references].filter(([, refs]) =>
          refs.some(({ move }) => move.artifact?.disposal.state === "pending-disposal"),
        );
        expect(
          pending.map(([file, refs]) => [
            file,
            new Set(refs.map(({ move }) => move.artifact?.disposal.state)),
          ]),
        ).toEqual([[retiredPath, new Set(["pending-disposal"])]]);
        expect(fs.readFileSync(survivorPath, "utf8")).toBe(bytes);
        expect(fs.readdirSync(archiveDir).some((file) => file.startsWith(".cleanup-"))).toBe(true);
      } else {
        expect(coalescedWrites).toBe(3);
        expect(before.references.get(retiredPath)?.length).toBeGreaterThan(0);
        expect(before.references.get(survivorPath)?.length).toBeGreaterThan(1);
        expect(
          before.manifestPaths.filter((file) =>
            hasSettledDuplicate(migrationRun.readSessionSqliteMigrationManifest(file)),
          ),
        ).toHaveLength(2);
      }
      const recovered = await doctor("recover");
      expect(recovered.targets.flatMap((item) => item.issues.map(({ code }) => code))).toEqual([
        "historical_duplicate_settled",
      ]);
      expect(fs.readFileSync(survivorPath, "utf8")).toBe(bytes);
      const after = inventory();
      expect(after.references.has(retiredPath)).toBe(false);
      expect(after.report.artifacts.map(({ reason }) => reason)).not.toContain(
        "unexpectedly-missing-artifact",
      );
      if (phase === "disposal") {
        expect(fs.readdirSync(archiveDir)).toEqual([path.basename(survivorPath)]);
        expect(after.references.get(survivorPath)?.length).toBeGreaterThan(1);
      }
      expect((await doctor("dry-run")).totals.issues).toBe(0);
    });
  },
);

it("protects a large historical index and all siblings within the inventory budget", () => {
  const { refs, artifacts } = recoveryGraph(10_000);
  const start = performance.now();
  protectRecoveryDependencies(artifacts, refs);
  const elapsed = performance.now() - start;
  expect(artifacts.filter((item) => item.outcome === "protected")).toHaveLength(10_000);
  expect(artifacts.at(-1)?.outcome).toBe("blocked");
  // Ten thousand originals previously took seconds of quadratic graph rebuilding;
  // this allowance remains orders of magnitude above the linear traversal.
  expect(elapsed).toBeLessThan(5_000);
});

it.each(["recorded", "adopted"] as const)(
  "honors an explicitly empty %s dependency list",
  (evidence) => {
    const { target, refs, artifacts } = recoveryGraph(2);
    const artifact: MigrationArtifact = {
      identity: { dev: "1", ino: "1", mtimeNs: "1", size: 1, sha256: "0".repeat(64) },
      classification: "imported",
      reason: "verified-historical-import",
      dependencies: [],
      disposal: { state: "retained" },
    };
    const indexRef = refs.get(target.plannedMoves[0]!.archivePath)![0]!;
    const adoptions = new Map<RecoveryArtifactReference, MigrationArtifact>();
    if (evidence === "recorded") {
      indexRef.move.artifact = artifact;
    } else {
      adoptions.set(indexRef, artifact);
    }
    protectRecoveryDependencies(artifacts, refs, adoptions);
    expect(artifacts.map((item) => item.outcome)).toEqual([
      "verification-required",
      "verification-required",
      "blocked",
    ]);
  },
);
