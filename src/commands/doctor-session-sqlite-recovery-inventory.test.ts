import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
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
  const moves: SessionSqliteMigrationMove[] = [];
  const archives = [1, 2].map((copy) => {
    const archivePath = path.join(archiveDir, `duplicate.jsonl.imported-${copy}`);
    fs.writeFileSync(archivePath, bytes);
    const old = createSessionSqliteMigrationRun(state.env, [target]);
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
    recordPlannedMigrationMoves(old, target, [move]);
    recordCompletedMigrationMoves(old, target, [move]);
    updateMigrationManifestTarget(old, target, [], { validationBeforeArchive: "passed" });
    old.manifest.completedAt = old.manifest.startedAt;
    writeSessionSqliteMigrationManifest(old);
    moves.push(move);
    return archivePath;
  });
  return { storePath, target, archiveDir, bytes, archives, moves };
}

describe("recovery dependency inventory", () => {
  it("preserves the latest failed run's rollback when duplicate references are coalesced", async () => {
    await withOpenClawTestState({ label: "doctor-duplicate-restore-first" }, async (state) => {
      const { storePath, target, bytes, moves } = createRetainedDuplicateArchives(state);
      // This run owns only the later copy; another manifest retains the equivalent survivor.
      const failed = createSessionSqliteMigrationRun(state.env, [target]);
      recordPlannedMigrationMoves(failed, target, [moves[1]!]);
      recordCompletedMigrationMoves(failed, target, [moves[1]!]);
      updateMigrationManifestTarget(failed, target, [], { validationBeforeArchive: "passed" });
      failed.manifest.failedAt = failed.manifest.startedAt;
      writeSessionSqliteMigrationManifest(failed);

      const recovered = await runDoctorSessionSqlite({
        mode: "recover",
        store: storePath,
        env: state.env,
      });
      const restore = recovered.targets[0]!.restore!;
      expect(restore.conflicts).toEqual([]);
      expect(restore.restoredFiles).toEqual([moves[1]!.sourcePath]);
      const manifest = migrationRun.readSessionSqliteMigrationManifest(failed.manifestPath)!;
      expect(manifest.restore?.consumedArchives).toContain(
        manifest.targets[0]!.completedMoves[0]!.archivePath,
      );
      const retained = collectRecoveryInventory({ cfg: {}, env: state.env });
      const survivingFiles = [moves[1]!.sourcePath, ...retained.references.keys()].filter((file) =>
        fs.existsSync(file),
      );
      expect(survivingFiles.length).toBeGreaterThan(0);
      for (const file of survivingFiles) {
        expect(fs.readFileSync(file, "utf8")).toBe(bytes);
      }
      expect(retained.report.artifacts).not.toContainEqual(
        expect.objectContaining({ reason: "unexpectedly-missing-artifact" }),
      );
    });
  });

  it("recovers interrupted duplicate retirement after historical import is acknowledged", async () => {
    await withOpenClawTestState({ label: "doctor-duplicate-disposal-recovery" }, async (state) => {
      const { storePath, archiveDir, bytes, archives } = createRetainedDuplicateArchives(state);
      const unlink = fs.unlinkSync;
      const interrupted = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (
          typeof file === "string" &&
          path.dirname(file) === archiveDir &&
          path.basename(file).startsWith(".cleanup-")
        ) {
          throw new Error("injected duplicate disposal interruption");
        }
        unlink(file);
      });
      try {
        const imported = await runDoctorSessionSqlite({
          mode: "import",
          store: storePath,
          env: state.env,
        });
        expect(imported.targets.flatMap((item) => item.issues)).toContainEqual(
          expect.objectContaining({
            code: "historical_transcript_deferred",
            message: expect.stringContaining("injected duplicate disposal interruption"),
          }),
        );
      } finally {
        interrupted.mockRestore();
      }
      const before = collectRecoveryInventory({ cfg: {}, env: state.env });
      const pending = [...before.references].filter(([, refs]) =>
        refs.some(({ move }) => move.artifact?.disposal.state === "pending-disposal"),
      );
      expect(pending).toHaveLength(1);
      const [retiredPath, refs] = pending[0]!;
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.every(({ move }) => move.artifact?.disposal.state === "pending-disposal")).toBe(
        true,
      );
      const survivors = archives.filter((file) => fs.existsSync(file));
      expect(survivors).toHaveLength(1);
      const survivorPath = survivors[0]!;
      expect(fs.readFileSync(survivorPath, "utf8")).toBe(bytes);
      expect(fs.readdirSync(archiveDir).some((file) => file.startsWith(".cleanup-"))).toBe(true);

      const recovered = await runDoctorSessionSqlite({
        mode: "recover",
        store: storePath,
        env: state.env,
      });
      expect(recovered.targets.flatMap((item) => item.issues)).toEqual([
        expect.objectContaining({ code: "historical_duplicate_settled" }),
      ]);
      expect(fs.readdirSync(archiveDir)).toEqual([path.basename(survivorPath)]);
      expect(fs.readFileSync(survivorPath, "utf8")).toBe(bytes);
      const after = collectRecoveryInventory({ cfg: {}, env: state.env });
      expect(after.references.has(retiredPath)).toBe(false);
      expect(after.references.get(survivorPath)?.length).toBeGreaterThan(1);
      expect(after.report.artifacts).not.toContainEqual(
        expect.objectContaining({ reason: "unexpectedly-missing-artifact" }),
      );
      const dry = await runDoctorSessionSqlite({
        mode: "dry-run",
        store: storePath,
        env: state.env,
      });
      expect(dry.totals.issues).toBe(0);
    });
  });

  it("finishes manifest coalescing after only part of the reference set was published", async () => {
    await withOpenClawTestState({ label: "doctor-duplicate-reference-recovery" }, async (state) => {
      const { storePath, target, archives, moves, bytes } = createRetainedDuplicateArchives(state);
      for (let attempt = 0; attempt < 2; attempt++) {
        const retry = createSessionSqliteMigrationRun(state.env, [target]);
        recordPlannedMigrationMoves(retry, target, moves);
        recordCompletedMigrationMoves(retry, target, moves);
        updateMigrationManifestTarget(retry, target, [], { validationBeforeArchive: "passed" });
        retry.manifest.completedAt = retry.manifest.startedAt;
        writeSessionSqliteMigrationManifest(retry);
      }
      const publish = migrationRun.writeSessionSqliteMigrationManifest;
      let coalescedWrites = 0;
      const interrupted = vi
        .spyOn(migrationRun, "writeSessionSqliteMigrationManifest")
        .mockImplementation((run) => {
          if (
            run.manifest.targets.some((item) =>
              item.issues.some((issue) => issue.code === "historical_duplicate_settled"),
            ) &&
            ++coalescedWrites === 3
          ) {
            throw new Error("injected partial manifest coalescing");
          }
          publish(run);
        });
      try {
        await expect(
          runDoctorSessionSqlite({ mode: "import", store: storePath, env: state.env }),
        ).rejects.toThrow("injected partial manifest coalescing");
      } finally {
        interrupted.mockRestore();
      }
      expect(coalescedWrites).toBe(3);
      const interruptedInventory = collectRecoveryInventory({ cfg: {}, env: state.env });
      const survivors = archives.filter((file) => fs.existsSync(file));
      expect(survivors).toHaveLength(1);
      const survivorPath = survivors[0]!;
      const retiredPath = archives.find((file) => file !== survivorPath)!;
      expect(interruptedInventory.references.get(retiredPath)?.length).toBeGreaterThan(0);
      expect(interruptedInventory.references.get(survivorPath)?.length).toBeGreaterThan(1);
      expect(
        interruptedInventory.manifestPaths.filter((file) =>
          migrationRun
            .readSessionSqliteMigrationManifest(file)
            ?.targets.some((item) =>
              item.issues.some((issue) => issue.code === "historical_duplicate_settled"),
            ),
        ),
      ).toHaveLength(2);

      const recovered = await runDoctorSessionSqlite({
        mode: "recover",
        store: storePath,
        env: state.env,
      });
      expect(recovered.targets.flatMap((item) => item.issues)).toEqual([
        expect.objectContaining({ code: "historical_duplicate_settled" }),
      ]);
      expect(fs.readFileSync(survivorPath, "utf8")).toBe(bytes);
      const completed = collectRecoveryInventory({ cfg: {}, env: state.env });
      expect(completed.references.has(retiredPath)).toBe(false);
      expect(completed.report.artifacts).not.toContainEqual(
        expect.objectContaining({ reason: "unexpectedly-missing-artifact" }),
      );
      expect(
        (await runDoctorSessionSqlite({ mode: "dry-run", store: storePath, env: state.env })).totals
          .issues,
      ).toBe(0);
    });
  });

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
});
