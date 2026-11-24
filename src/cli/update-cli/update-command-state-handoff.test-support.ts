import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { expect, it, vi, type Mock } from "vitest";
import { recordUpdateRunStepAsync } from "../../infra/update-run-write.async.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { finishUpdate } from "./update-command-post-update.js";
import type { maybeRestartService } from "./update-command-service.js";

export function registerUpdateStateRestartHandoffTests(
  fixture: () => FinishUpdateParams,
  restart: Mock<typeof maybeRestartService>,
): void {
  it.each(["ok", "restart failed"] as const)(
    "reopens the successor state after a restart copy-and-swap (%s)",
    async (outcome) => {
      const params = fixture();
      const resumeProgress = vi.fn();
      const suspendProgress = vi.fn(() => resumeProgress);
      params.suspendProgress = suspendProgress;
      const { runId, env } = params.opts.run!;
      const live = resolveOpenClawStateSqlitePath(env);
      const previous = live + ".pre-successor";
      const step = (name: string) => ({ step: name, status: "completed" as const });
      await recordUpdateRunStepAsync(runId, step("before restart"), { env });
      restart.mockImplementationOnce(async ({ shouldRestart, onGatewayStartAttempted }) => {
        expect(shouldRestart).toBe(true);
        expect(suspendProgress).toHaveBeenCalledOnce();
        expect(resumeProgress).not.toHaveBeenCalled();
        onGatewayStartAttempted?.();
        await promisify(execFile)(process.execPath, [
          "-e",
          `const fs = require("node:fs"), { DatabaseSync } = require("node:sqlite");
           const [live, previous] = process.argv.slice(1), next = live + ".next";
           const source = new DatabaseSync(live);
           source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
           source.prepare("VACUUM INTO ?").run(next); source.close();
           const migrated = new DatabaseSync(next);
           migrated.exec("CREATE TABLE successor_schema(value TEXT) STRICT"); migrated.close();
           for (const suffix of ["-wal", "-journal", "-shm", ".seal"]) {
             const companion = live + suffix;
             if (fs.existsSync(companion) && ["-wal", "-journal"].includes(suffix)) {
               fs.linkSync(companion, companion + ".pre-successor");
             }
             fs.rmSync(companion, { force: true });
           }
           fs.linkSync(live, previous); fs.renameSync(next, live);`,
          live,
          previous,
        ]);
        if (outcome !== "ok") {
          throw new Error(outcome);
        }
        return "ok";
      });
      try {
        if (outcome === "ok") {
          await expect(finishUpdate(params)).resolves.toMatchObject({ status: "ok" });
        } else {
          await expect(finishUpdate(params)).rejects.toThrow(outcome);
        }
        expect(resumeProgress).toHaveBeenCalledOnce();
        const terminalStatus = outcome === "ok" ? "succeeded" : "failed";
        // This required operation consults the async writer even on a terminal row.
        await expect(
          recordUpdateRunStepAsync(runId, step("post-update verification"), { env }),
        ).resolves.toMatchObject({ status: terminalStatus });
        await closeOpenClawStateDatabaseAsync();
        using old = new DatabaseSync(previous, { readOnly: true });
        using current = new DatabaseSync(live, { readOnly: true });
        expect(current.prepare("SELECT 1 FROM successor_schema").all()).toEqual([]);
        const read = (db: DatabaseSync) =>
          db.prepare("SELECT status, steps_json FROM update_runs WHERE run_id = ?").get(runId);
        expect(read(current)).toMatchObject({
          status: terminalStatus,
          steps_json: expect.stringContaining("before restart"),
        });
        expect(read(old)).toMatchObject({ status: "running" });
      } finally {
        await closeOpenClawStateDatabaseAsync();
      }
    },
  );

  it("does not suspend progress or release state for --no-restart", async () => {
    const params = fixture();
    params.shouldRestart = false;
    params.opts.restart = false;
    params.preManagedServiceStop = undefined;
    const suspendProgress = vi.fn(() => vi.fn());
    params.suspendProgress = suspendProgress;
    restart.mockImplementationOnce(async ({ shouldRestart }) => {
      expect(shouldRestart).toBe(false);
      return "ok";
    });
    await expect(finishUpdate(params)).resolves.toMatchObject({ status: "ok" });
    expect(restart).toHaveBeenCalledOnce();
    expect(suspendProgress).not.toHaveBeenCalled();
  });
}
