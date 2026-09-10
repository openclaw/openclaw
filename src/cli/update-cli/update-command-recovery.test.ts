import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
  retainedReadinessRecord,
  retainedTerminalRecord,
} from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { legacyRecord } from "../../infra/update-run-recovery-legacy.test-support.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import {
  finishSuccessfulPackageSwitch,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture(rollback = false) {
  const root = dirs.make("terminal-consumer-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const options = { env };
  const live = path.join(root, "node_modules", "openclaw");
  const stage = path.join(root, "stage");
  const backup = path.join(root, "node_modules", ".openclaw.package-backup-test");
  for (const [directory, version] of [
    [live, "1.0.0"],
    [stage, "2.0.0"],
  ] as const) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
    );
  }
  const run = createUpdateRun({ trigger: "cli" }, options);
  const from = { root: live, nodePath: process.execPath, version: "1.0.0", buildId: null };
  const to = { ...from, version: "2.0.0" };
  let current = true;
  const fence = {
    assertCurrent() {
      if (!current) {
        throw new Error("authority lost");
      }
    },
  };
  let record = createRetainedUpdateRecovery({ runId: run.runId, from, to }, options);
  const recovery = {
    getRecord: () => record,
    onRecord: (next: typeof record) => {
      record = next;
    },
    fence,
    options,
    assertReady: () => fence.assertCurrent(),
  };
  const opts: UpdateCommandOptions = { json: true, run: { runId: run.runId, env }, recovery };
  record = retainedReadinessRecord(record, rollback ? "previous" : "candidate");
  if (rollback) {
    record.primaryFailure = { code: "candidate-failed", effectId: null };
  }
  if (!rollback) {
    await fs.rename(live, backup);
    await fs.rename(stage, live);
  } else {
    await fs.mkdir(backup, { recursive: true });
    await fs.writeFile(path.join(backup, "package.json"), '{"name":"openclaw","version":"2.0.0"}');
  }
  storeRetainedUpdateRecovery(record, options);
  return {
    opts,
    recovery,
    options,
    run,
    live,
    backup,
    root,
    get record() {
      return record;
    },
    revoke() {
      current = false;
    },
    reload() {
      closeOpenClawStateDatabaseForTest();
      return loadUpdateRecovery(run.runId, options);
    },
  };
}

describe("durable terminal finalizer consumer", () => {
  it("refuses to serialize live authority into a legacy migrated worker", async () => {
    const f = await fixture();
    await expect(
      continueMigratedUpdateInFreshProcess(
        {
          opts: f.opts,
          mutationStarted: true,
          root: f.live,
          result: { status: "ok", mode: "npm", root: f.live, steps: [], durationMs: 0 },
          configSnapshot: {
            ...validConfigSnapshot,
            path: path.join(f.root, "openclaw.json"),
            exists: true,
            raw: "{}",
            resolved: {},
          },
          installKindChanged: false,
          requestedChannel: null,
          storedChannel: null,
          channel: "stable",
          downgradeRisk: false,
          shouldRestart: true,
          controlPlaneUpdateSentinelMeta: null,
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          updateStepTimeoutMs: 1000,
        },
        [],
      ),
    ).rejects.toMatchObject({ name: "UpdateCommandRecoveryPendingError" });
    expect(f.reload()?.terminal).toBeUndefined();
  });

  it.each(["pending", "lost readiness", "unavailable package"] as const)(
    "refuses retained full-state finalization (%s) without committing or cleaning",
    async (mode) => {
      const f = await fixture();
      if (mode === "lost readiness") {
        f.revoke();
      }
      if (mode === "unavailable package") {
        await fs.rename(f.backup, f.backup + "-unavailable");
      }
      const before = f.reload();
      await expect(
        finishSuccessfulPackageSwitch({ packageRoot: f.live, run: f.opts.run }, { opts: f.opts }),
      ).rejects.toMatchObject({ name: "UpdateCommandPendingRecoveryFailure" });
      expect(f.reload()).toEqual(before);
      expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("running");
      expect(await fs.stat(f.live)).toBeDefined();
      expect(
        await fs.stat(mode === "unavailable package" ? f.backup + "-unavailable" : f.backup),
      ).toBeDefined();
    },
  );
});

describe("historical terminal completion diagnostics", () => {
  async function historical(rollback: boolean, terminal = true) {
    const f = await fixture(rollback);
    if (terminal) {
      f.recovery.onRecord(retainedTerminalRecord(f.record, rollback));
      finishUpdateRun(
        f.run.runId,
        {
          status: rollback ? "rolled-back" : "succeeded",
          ...(rollback ? { reason: "candidate-failed" } : {}),
        },
        f.options,
      );
    }
    const saved = JSON.stringify(legacyRecord(f.record), null, 2);
    const source = openOpenClawStateDatabase(f.options);
    source.db
      .prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?")
      .run(saved, "update.recovery." + f.run.runId);
    closeOpenClawStateDatabaseForTest();
    const family = async () =>
      Promise.all(
        (await fs.readdir(path.dirname(source.path)))
          .filter(
            (name) =>
              name === path.basename(source.path) ||
              name.startsWith(path.basename(source.path) + "-"),
          )
          .toSorted()
          .map(async (name) => {
            const file = path.join(path.dirname(source.path), name);
            const stat = await fs.stat(file);
            return {
              name,
              bytes: await fs.readFile(file),
              ino: stat.ino,
              size: stat.size,
              mtime: stat.mtimeMs,
              ctime: stat.ctimeMs,
            };
          }),
      );
    return { ...f, family, saved };
  }

  it.each([false, true])(
    "reports historical terminal outcome without rewriting legacy artifacts (rollback=%s)",
    async (rollback) => {
      const f = await historical(rollback);
      const before = await f.family();
      const result = completeUpdateCommandRun(
        {
          status: rollback ? "ok" : "error",
          reason: "stale-process-result",
          mode: "npm",
          root: f.live,
          steps: [],
          durationMs: 1,
        },
        f.opts.run,
      );
      expect(result).toMatchObject({
        status: rollback ? "error" : "ok",
        reason: rollback ? "candidate-failed" : undefined,
        runId: f.run.runId,
      });
      expect(await f.family()).toEqual(before);
    },
  );

  it("keeps unfinished legacy evidence pending without completing history", async () => {
    const f = await historical(false, false);
    const before = await f.family();
    const result = completeUpdateCommandRun(
      { status: "ok", mode: "npm", root: f.live, steps: [], durationMs: 1 },
      f.opts.run,
    );
    expect(result).toMatchObject({ status: "error", reason: "update-recovery-pending" });
    expect(await f.family()).toEqual(before);
    expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("running");
  });

  it("does not turn unrelated legacy inspection into permission for the writing fallback", async () => {
    const f = await historical(false);
    const other = createUpdateRun({ trigger: "cli" }, f.options);
    closeOpenClawStateDatabaseForTest();
    const before = await f.family();
    expect(() =>
      completeUpdateCommandRun(
        { status: "ok", mode: "npm", steps: [], durationMs: 1 },
        { runId: other.runId, env: f.opts.run!.env },
      ),
    ).toThrow();
    expect(await f.family()).toEqual(before);
    expect(getUpdateRun(other.runId, f.options)?.status).toBe("running");
  });
});
