import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readMigrationArtifactIdentity } from "../../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
} from "../../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../../infra/session-sqlite-migration-readers.js";
import { defaultRuntime } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { updateCleanupCommand } from "./cleanup.js";

afterEach(() => vi.restoreAllMocks());

it("summarizes missing originals once without phantom paths or bytes in preview and apply", async () => {
  await withOpenClawTestState({ label: "cleanup-missing-originals" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const target = {
      agentId: "main",
      storePath,
      sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath }, state.env),
    };
    const archiveDir = state.statePath("agents", "main", "session-sqlite-import-archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const moves: SessionSqliteMigrationMove[] = [
      "historical",
      "protected",
      "disposed",
      "present",
    ].map((name) => {
      const archivePath = path.join(archiveDir, `${name}.jsonl.imported-old`);
      fs.writeFileSync(archivePath, "original\n");
      const move: SessionSqliteMigrationMove = {
        kind: "unreferenced-jsonl",
        sourcePath: path.join(state.sessionsDir(), `${name}.jsonl`),
        archivePath,
      };
      if (name !== "historical") {
        move.artifact = {
          identity: readMigrationArtifactIdentity(archivePath),
          classification: "protected",
          reason: "unreferenced-history",
          dependencies: [],
          disposal:
            name === "disposed"
              ? { state: "disposed", disposedAt: "2026-09-01T00:00:00Z" }
              : { state: "retained" },
        };
      }
      if (name !== "present") {
        fs.unlinkSync(archivePath);
      }
      return move;
    });
    for (let copy = 0; copy < 2; copy++) {
      const run = createSessionSqliteMigrationRun(state.env, [target]);
      recordPlannedMigrationMoves(run, target, moves);
      recordCompletedMigrationMoves(run, target, moves);
      updateMigrationManifestTarget(run, target, [], { validationBeforeArchive: "passed" });
      run.manifest.completedAt = run.manifest.startedAt;
      writeSessionSqliteMigrationManifest(run);
    }
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    for (const dryRun of [true, false]) {
      writeJson.mockClear();
      await updateCleanupCommand({ dryRun, yes: true, json: true });
      const report = writeJson.mock.calls[0]![0];
      expect(report).toMatchObject({
        status: dryRun ? "preview" : "complete",
        missingOriginals: 3,
        artifacts: [{ path: moves[3]!.archivePath, outcome: "protected", bytes: 9 }],
        totals: {
          candidateBytes: 0,
          verificationRequiredBytes: 0,
          protectedBytes: 9,
          blockedBytes: 0,
          removedBytes: 0,
          removedFiles: 0,
        },
      });
      expect(fs.readFileSync(moves[3]!.archivePath, "utf8")).toBe("original\n");
    }
    await updateCleanupCommand({ dryRun: true });
    const output = log.mock.calls.flat().join("\n");
    expect(output.match(/Missing recovery originals: 3/g)).toHaveLength(1);
    for (const move of moves.slice(0, 3)) {
      expect(output).not.toContain(move.archivePath);
    }
  });
});
