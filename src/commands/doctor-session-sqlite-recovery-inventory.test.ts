import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { MigrationArtifact } from "./doctor-session-sqlite-artifact.js";
import type {
  ActiveSessionSqliteMigrationRun,
  SessionSqliteMigrationTargetManifest,
} from "./doctor-session-sqlite-migration-run.js";
import {
  protectRecoveryDependencies,
  type RecoveryArtifactReference,
  type RecoveryCleanupReport,
} from "./doctor-session-sqlite-recovery-inventory.js";

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

describe("recovery dependency inventory", () => {
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
