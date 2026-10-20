import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as recovery from "./doctor-session-sqlite-recovery-inventory.js";
import { settleDuplicateSessionSqliteArchives } from "./doctor-session-sqlite-retirement.js";

function expectSettled(result: Awaited<ReturnType<typeof settleDuplicateSessionSqliteArchives>>) {
  expect(result).toEqual([
    expect.objectContaining({
      issues: [expect.objectContaining({ code: "historical_duplicate_settled" })],
    }),
  ]);
}

it.each([1, 7, 29])(
  "keeps the first artifact selected by a linear lookup (seed %s)",
  async (seed) => {
    await withDuplicateArchives(3, async ({ artifacts, settle }) => {
      const copies = artifacts.map((item) => ({ ...item }));
      artifacts.push(...copies);
      let random = seed;
      for (let i = artifacts.length - 1; i > 0; i--) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const j = random % (i + 1);
        [artifacts[i], artifacts[j]] = [artifacts[j]!, artifacts[i]!];
      }
      const expected = copies
        .slice(1)
        .map((item) => artifacts.find((candidate) => candidate.path === item.path)!);
      const untouched = artifacts.filter((item) => !expected.includes(item));
      const before = untouched.map((item) => ({ ...item }));
      expectSettled(await settle());
      expect(expected.map((item) => item.outcome)).toEqual(["removed", "removed", "removed"]);
      expect(untouched).toEqual(before);
    });
  },
);

it.each(["artifacts", "moves"] as const)(
  "settles many duplicates with linear %s visits",
  async (kind) => {
    await withDuplicateArchives(64, async ({ artifacts, target, settle }) => {
      const size = kind === "artifacts" ? 100_000 : 0;
      let artifactVisits = 0;
      let moveVisits = 0;
      const fillers = Array.from({ length: size }, (_, index) => ({
        get path() {
          if (++artifactVisits > 4 * size) {
            throw new Error("repeated full artifact scan");
          }
          return `/synthetic/unrelated-${index}`;
        },
        runs: [],
        bytes: 0,
        outcome: "disposed" as const,
        reason: "intentionally-disposed",
      }));
      const originals = artifacts.splice(0);
      for (const item of fillers) {
        artifacts.push(item);
      }
      artifacts.push(...originals);
      const move = target.plannedMoves[0]!;
      const unrelated: SessionSqliteMigrationMove[] = Array.from(
        { length: kind === "moves" ? 1_000 : 0 },
        (_, index) => ({
          ...move,
          sourcePath: path.join(path.dirname(move.sourcePath), `unrelated-${index}.jsonl`),
          get archivePath() {
            if (++moveVisits > 20_000) {
              throw new Error("repeated full manifest scan");
            }
            return path.join(path.dirname(move.archivePath), `unrelated-${index}.jsonl.imported-1`);
          },
        }),
      );
      target.plannedMoves.unshift(...unrelated);
      target.completedMoves.unshift(...unrelated);
      expectSettled(await settle());
      expect(artifacts.slice(size + 1).every((item) => item.outcome === "removed")).toBe(true);
      expect(artifactVisits).toBeLessThanOrEqual(4 * size);
      expect(moveVisits).toBeLessThanOrEqual(20_000);
    });
  },
);

async function withDuplicateArchives(
  count: number,
  run: (fixture: {
    artifacts: recovery.RecoveryCleanupReport["artifacts"];
    target: ReturnType<typeof createSessionSqliteMigrationRun>["manifest"]["targets"][number];
    settle: () => ReturnType<typeof settleDuplicateSessionSqliteArchives>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "duplicate-lookup" }, async (state) => {
    const sessions = state.sessionsDir();
    const archives = path.join(path.dirname(sessions), "session-sqlite-import-archive");
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(archives, { recursive: true });
    const storePath = path.join(sessions, "sessions.json");
    const owner = {
      agentId: "main",
      storePath,
      sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath }, state.env),
    };
    const manifest = createSessionSqliteMigrationRun(state.env, [owner]);
    const target = manifest.manifest.targets[0]!;
    const artifacts: recovery.RecoveryCleanupReport["artifacts"] = [];
    const references = new Map<string, recovery.RecoveryArtifactReference[]>();
    for (let index = 0; index <= count; index++) {
      const archivePath = path.join(archives, `duplicate.jsonl.imported-${index}`);
      fs.writeFileSync(archivePath, "retained original bytes\n");
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
      target.plannedMoves.push(move);
      target.completedMoves.push(structuredClone(move));
      references.set(archivePath, [
        { run: manifest, target, move, trusted: true, consumedByRestore: false },
      ]);
      artifacts.push({
        path: archivePath,
        runs: [manifest.manifest.runId],
        bytes: 24,
        outcome: "protected",
        reason: "unreferenced-history",
      });
    }
    const report = recovery.summarizeRecoveryCleanup(state.stateDir, artifacts, "preview");
    using inventory = vi
      .spyOn(recovery, "collectRecoveryInventory")
      .mockReturnValue({ artifacts, references, report, manifestPaths: [manifest.manifestPath] });
    await run({
      artifacts,
      target,
      settle: () =>
        settleDuplicateSessionSqliteArchives({ cfg: {}, env: state.env, targets: [owner] }),
    });
    expect(inventory).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(archives, "duplicate.jsonl.imported-0"), "utf8")).toBe(
      "retained original bytes\n",
    );
  });
}
