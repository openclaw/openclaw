import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import { restoreDoctorSessionSqliteTargets } from "./doctor-session-sqlite-restore-report.js";

// Exceeds Node’s argument-spread limit without requiring hundreds of thousands of files.
const ENTRY_COUNT = 150_000;

afterEach(() => vi.restoreAllMocks());

it("reports every unavailable retained manifest in inventory order", async () => {
  await withOpenClawTestState({ label: "doctor-inventory-scale" }, async (state) => {
    const paths = Array.from({ length: ENTRY_COUNT }, (_, i) =>
      state.statePath("session-sqlite-migration-runs", `missing-${i}.json`),
    );
    vi.spyOn(migrationRun, "listSessionSqliteMigrationManifestPaths").mockReturnValue(paths);
    const inventory = collectRecoveryInventory({ cfg: {}, env: state.env });
    expect(inventory.manifestPaths).toEqual(paths);
    expect(inventory.report.artifacts).toEqual(
      paths.map((filePath) => ({
        path: filePath,
        runs: [],
        bytes: 0,
        outcome: "blocked",
        reason: "unreadable-manifest",
      })),
    );
    expect(inventory.references.size).toBe(0);
    expect(inventory.report.status).toBe("preview");
  });
});

it("preserves every restore conflict in its durable receipt and returned report", async () => {
  await withOpenClawTestState({ label: "doctor-restore-scale" }, async (state) => {
    const directory = state.sessionsDir();
    fs.mkdirSync(directory, { recursive: true });
    const storePath = path.join(directory, "sessions.json");
    const target = {
      agentId: "main",
      storePath,
      sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath }, state.env),
    };
    const retainedPath = path.join(directory, "original.jsonl");
    fs.writeFileSync(retainedPath, "retained original\n");
    const identity = readMigrationArtifactIdentity(retainedPath);
    const run = migrationRun.createSessionSqliteMigrationRun(state.env, [target]);
    const moves = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      kind: "transcript" as const,
      sourcePath: path.join(directory, `history-${i}.jsonl`),
      archivePath: path.join(
        path.dirname(directory),
        "session-sqlite-import-archive",
        `history-${i}.original`,
      ),
      artifact: {
        identity,
        classification: "protected" as const,
        reason: "retained history",
        dependencies: [],
        disposal: { state: "disposed" as const, disposedAt: "2026-09-01T00:00:00Z" },
      },
    }));
    run.manifest.targets[0]!.plannedMoves = moves;
    migrationRun.writeSessionSqliteMigrationManifest(run);
    const report = await restoreDoctorSessionSqliteTargets({ env: state.env, targets: [target] });
    const conflicts = moves.map((move) => ({
      archivePath: move.archivePath,
      sourcePath: move.sourcePath,
      reason: "rollback original was intentionally disposed by update cleanup",
    }));
    expect(report.targets[0]?.restore?.conflicts).toEqual(conflicts);
    expect(report.targets[0]?.issues).toEqual(
      conflicts.map((conflict) => ({
        code: "restore_conflict",
        message: `${conflict.sourcePath}: ${conflict.reason}`,
      })),
    );
    expect(report.totals.issues).toBe(ENTRY_COUNT);
    expect(
      migrationRun.readSessionSqliteMigrationManifest(run.manifestPath)?.restore,
    ).toMatchObject({
      conflicts,
      restoredFiles: [],
      skippedFiles: [],
      status: "conflicts",
    });
    expect(readMigrationArtifactIdentity(retainedPath)).toEqual(identity);
  });
});
