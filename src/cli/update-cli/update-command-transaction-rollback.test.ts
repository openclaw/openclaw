import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRestartSentinel, writeRestartSentinel } from "../../infra/restart-sentinel.js";
import {
  resolveUpdateRecoveryJournalPathFromSnapshot,
  rewriteUpdateRecoveryJournal,
  UPDATE_RECOVERY_JOURNAL_ENV,
} from "../../infra/update-recovery-journal.js";
import { createUpdateStateSnapshot } from "../../infra/update-state-snapshot.js";
import {
  claimUpdateTransactionRollback,
  writeUpdateTransactionMarker,
} from "../../infra/update-transaction-marker.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { restoreUpdateStateWithCompletedRollbackMarker } from "./update-command-transaction-rollback.js";

const roots: string[] = [];

afterEach(async () => {
  closeOpenClawStateDatabase();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("update transaction rollback state restore", () => {
  it("uses the committed journal payload when confirmation is only staged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-rollback-journal-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const packageRoot = path.join(root, "global", "openclaw");
    const retainedPackageRoot = path.join(root, "global", ".openclaw-previous");
    await Promise.all([
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(packageRoot, { recursive: true }),
      fs.mkdir(retainedPackageRoot, { recursive: true }),
    ]);
    const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await fs.writeFile(path.join(stateDir, "value"), "before\n");
    await writeRestartSentinel(
      { kind: "restart", status: "ok", ts: Date.now(), message: "snapshot baseline" },
      env,
    );
    closeOpenClawStateDatabase();
    const snapshot = await createUpdateStateSnapshot({
      retainedPackageRoot,
      currentPackageRoot: packageRoot,
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      timeoutMs: 1_000,
      runCommand: async (argv) => {
        await fs.cp(argv.at(-2)!, argv.at(-1)!, { recursive: true });
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    const journalPath = resolveUpdateRecoveryJournalPathFromSnapshot(snapshot.root);
    env[UPDATE_RECOVERY_JOURNAL_ENV] = journalPath;
    await writeUpdateTransactionMarker({
      result: { status: "ok", mode: "npm", root: packageRoot, steps: [], durationMs: 1 },
      meta: { handoffId: "handoff-staged-confirmation" },
      confirmationTier: "delivery",
      phase: "healthy",
      rollback: {
        packageRoot,
        retainedPackageRoot,
        stateSnapshotRoot: snapshot.root,
        nodePath: process.execPath,
        recoveryJournalPath: journalPath,
      },
      env,
    });
    const pending = (await readRestartSentinel(env))!.payload;
    await rewriteUpdateRecoveryJournal({
      filePath: journalPath,
      handoffId: "handoff-staged-confirmation",
      stageConfirmation: true,
      rewrite: () => ({
        ...pending,
        stats: {
          ...pending.stats,
          updatePhase: "confirm",
          confirmationStatus: "delivery-acked",
        },
      }),
    });
    await claimUpdateTransactionRollback({
      handoffId: "handoff-staged-confirmation",
      rollbackOwner: "rollback-owner",
      reason: "confirmation commit failed",
      env,
    });
    await fs.writeFile(path.join(stateDir, "value"), "after\n");

    await restoreUpdateStateWithCompletedRollbackMarker({
      snapshot,
      handoffId: "handoff-staged-confirmation",
      reason: "confirmation commit failed",
      rollbackOwner: "rollback-owner",
      env,
    });

    expect(await fs.readFile(path.join(stateDir, "value"), "utf8")).toBe("before\n");
    expect((await readRestartSentinel(env))?.payload.stats).toMatchObject({
      updatePhase: "rolled-back",
      confirmationStatus: "failed",
      updateRollbackOwner: "rollback-owner",
    });
  });
});
