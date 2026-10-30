import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as recovery from "./doctor-session-sqlite-recovery-inventory.js";
import { settleDuplicateSessionSqliteArchives } from "./doctor-session-sqlite-retirement.js";
import { retainedHistoryMove } from "./doctor-session-sqlite.recovery-fixtures.test-support.js";

it("keeps the first matching artifact when copies precede or follow the original", async () => {
  await withDuplicateArchives(3, async ({ artifacts, settle }) => {
    const pairs = artifacts
      .splice(0)
      .map((item, index) => (index % 2 ? [{ ...item }, item] : [item, { ...item }]));
    artifacts.push(...pairs.flat());
    const expected = pairs.slice(1).map(([first]) => first!);
    const untouched = artifacts.filter((item) => !expected.includes(item));
    const before = untouched.map((item) => ({ ...item }));
    expect(await settle()).toMatchObject([{ issues: [{ code: "historical_duplicate_settled" }] }]);
    expect(expected.map((item) => item.outcome)).toEqual(["removed", "removed", "removed"]);
    expect(untouched).toEqual(before);
  });
});

it.each(["artifacts", "moves"] as const)(
  "settles many duplicates with linear %s visits",
  async (kind) => {
    await withDuplicateArchives(64, async ({ artifacts, target, settle }) => {
      const size = kind === "artifacts" ? 100_000 : 0;
      const limit = kind === "artifacts" ? 4 * size : 20_000;
      let visits = 0;
      const visit = (file: string) => {
        if (++visits > limit) {
          throw new Error(`repeated full ${kind} scan`);
        }
        return file;
      };
      const originals = artifacts.splice(0);
      for (let index = 0; index < size; index++) {
        artifacts.push({
          get path() {
            return visit(`/synthetic/unrelated-${index}`);
          },
          runs: [],
          bytes: 0,
          outcome: "disposed" as const,
          reason: "intentionally-disposed",
        });
      }
      artifacts.push(...originals);
      const move = target.plannedMoves[0]!;
      const unrelated: SessionSqliteMigrationMove[] = Array.from(
        { length: kind === "moves" ? 1_000 : 0 },
        (_, index) => ({
          ...move,
          sourcePath: path.join(path.dirname(move.sourcePath), `unrelated-${index}.jsonl`),
          get archivePath() {
            return visit(
              path.join(path.dirname(move.archivePath), `unrelated-${index}.jsonl.imported-1`),
            );
          },
        }),
      );
      target.plannedMoves.unshift(...unrelated);
      target.completedMoves.unshift(...unrelated);
      await settle();
      expect(artifacts.slice(size + 1).every((item) => item.outcome === "removed")).toBe(true);
      expect(visits).toBeLessThanOrEqual(limit);
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
      const move = retainedHistoryMove(path.join(sessions, "duplicate.jsonl"), archivePath);
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
    using _ = vi
      .spyOn(recovery, "collectRecoveryInventory")
      .mockReturnValue({ artifacts, references, report, manifestPaths: [manifest.manifestPath] });
    await run({
      artifacts,
      target,
      settle: () =>
        settleDuplicateSessionSqliteArchives({ cfg: {}, env: state.env, targets: [owner] }),
    });
    expect(fs.readFileSync(path.join(archives, "duplicate.jsonl.imported-0"), "utf8")).toBe(
      "retained original bytes\n",
    );
  });
}
