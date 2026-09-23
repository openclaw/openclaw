import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { readRestartSentinelReadOnly, writeRestartSentinel } from "../../infra/restart-sentinel.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { createFreeBsdUpdateWriteAdmission } from "../../infra/update-freebsd-write-admission.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  getUpdateRun,
  heartbeatUpdateRun,
} from "../../infra/update-run-ledger.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { admitUpdateCommandLedger, updateCommandLedgerOptions } from "./update-command-ledger.js";
import {
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import { completeUpdateCommandRun, createUpdateRunProgress } from "./update-command-run.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

async function admittedRun(env: NodeJS.ProcessEnv) {
  const admission = withMockedPlatform("freebsd", () => createFreeBsdUpdateWriteAdmission()!);
  await admission.revalidate(() => {});
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } }, { env })
      .runId,
    env,
    freebsdWriteAdmission: admission,
  };
  admitUpdateCommandLedger(run);
  return { run, admission };
}

function readPublicationRows(pathname: string) {
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    const state = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    return {
      runs: executeSqliteQuerySync(
        db,
        state.selectFrom("update_runs").selectAll().orderBy("run_id"),
      ).rows,
      sentinels: executeSqliteQuerySync(
        db,
        state.selectFrom("gateway_restart_sentinel").selectAll().orderBy("sentinel_key"),
      ).rows,
    };
  } finally {
    db.close();
  }
}

it.each(["cloned environment", "state selector", "config selector", "run id", "missing admission"])(
  "refuses the first callback after changing its %s without an execution guard",
  async (change) => {
    await withTestDir({ prefix: "update-ledger-binding-" }, async (root) => {
      const env = {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      };
      const { run, admission } = await admittedRun(env);
      const originalId = run.runId;
      const before = getUpdateRun(originalId, { env });
      const progress = createUpdateRunProgress(run, {});
      if (change === "cloned environment") {
        run.env = { ...env };
      }
      if (change === "state selector") {
        env.OPENCLAW_STATE_DIR = path.join(root, "other");
      }
      if (change === "config selector") {
        env.OPENCLAW_CONFIG_PATH = path.join(root, "other.json");
      }
      if (change === "run id") {
        run.runId = "different-run";
      }
      if (change === "missing admission") {
        run.ledgerAdmission = undefined;
      }
      expect(() => progress.onHeartbeat?.()).toThrow();
      const first = admission.failure;
      expect(first).toBeInstanceOf(Error);
      expect(admission.canWrite).toBe(false);
      env.OPENCLAW_STATE_DIR = root;
      env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
      run.env = env;
      run.runId = originalId;
      progress.onHeartbeat?.();
      progress.flushLedgerWrites();
      expect(admission.revoke(new Error("later refusal"))).toBe(first);
      expect(getUpdateRun(originalId, { env })).toEqual(before);
      expect(fs.existsSync(path.join(root, "other"))).toBe(false);
    });
  },
);

it("rechecks prepared options at the writer and keeps two runs sharing an environment independent", async () => {
  await withTestDir({ prefix: "update-ledger-two-runs-" }, async (root) => {
    const env = { OPENCLAW_STATE_DIR: root };
    const first = await admittedRun(env);
    const second = await admittedRun(env);
    const firstOptions = updateCommandLedgerOptions(first.run);
    const before = getUpdateRun(first.run.runId, { env });
    first.run.env = { ...env };
    expect(() =>
      heartbeatUpdateRun(first.run.runId, readUpdateRunDriver(), firstOptions),
    ).toThrow();
    expect(first.admission.canWrite).toBe(false);
    const secondBefore = getUpdateRun(second.run.runId, { env });
    createUpdateRunProgress(second.run, {}).onHeartbeat?.();
    expect(second.admission.canWrite).toBe(true);
    expect(getUpdateRun(second.run.runId, { env })?.updatedAtMs).toBeGreaterThan(
      secondBefore!.updatedAtMs,
    );
    expect(getUpdateRun(first.run.runId, { env })).toEqual(before);
    expect(() => heartbeatUpdateRun(second.run.runId, readUpdateRunDriver(), firstOptions)).toThrow(
      first.admission.failure,
    );
  });
});

it("requires a receiver's own binding and retains ordinary diagnostics after executor release", async () => {
  await withTestDir({ prefix: "update-ledger-receiver-" }, async (root) => {
    const { run, admission } = await admittedRun({ OPENCLAW_STATE_DIR: root });
    const receiver = { ...run };
    expect(() => updateCommandLedgerOptions(receiver)).toThrow("another run");
    expect(admission.canWrite).toBe(false);
    const local = await admittedRun(run.env);
    const privateRoot = path.join(root, "private");
    fs.mkdirSync(privateRoot, { mode: 0o700 });
    vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(privateRoot);
    await withUpdateCommandExecutor(local.run.runId, async (executor) => {
      local.run.executorFence = await executor.enter(root);
    });
    expect(() => local.run.executorFence?.assertCurrent()).toThrow();
    expect(
      completeUpdateCommandRun(
        { status: "error", mode: "npm", reason: "ordinary failure", steps: [], durationMs: 1 },
        local.run,
      ).status,
    ).toBe("error");
    expect(getUpdateRun(local.run.runId, { env: run.env })).toMatchObject({
      status: "failed",
      reason: "ordinary failure",
    });
    expect(local.admission.canWrite).toBe(true);
  });
});

it("leaves ordinary Linux writers unbound after a generation change", async () => {
  await withTestDir({ prefix: "update-ledger-linux-" }, async (root) => {
    const env = { OPENCLAW_STATE_DIR: root };
    const run = {
      runId: createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } }, { env })
        .runId,
      env,
    };
    admitUpdateCommandLedger(run);
    expect(updateCommandLedgerOptions(run)).toEqual({ env });
    closeOpenClawStateDatabaseForTest();
    const pathname = resolveOpenClawStateSqlitePath(env);
    fs.renameSync(pathname, pathname + ".prior");
    fs.copyFileSync(pathname + ".prior", pathname);
    const before = getUpdateRun(run.runId, { env });
    createUpdateRunProgress(run, {}).onHeartbeat?.();
    expect(getUpdateRun(run.runId, { env })?.updatedAtMs).toBeGreaterThan(before!.updatedAtMs);
  });
});

it("does not recapture a deferred parent's generation when flushing; a receiver admits its own", async () => {
  await withTestDir({ prefix: "update-ledger-deferred-" }, async (root) => {
    const env = { OPENCLAW_STATE_DIR: root };
    const { run, admission } = await admittedRun(env);
    const progress = createUpdateRunProgress(run, {});
    progress.deferLedgerWrites();
    progress.onStepStart?.({ name: "buffered step", command: "fixture", index: 0, total: 1 });
    const before = getUpdateRun(run.runId, { env });
    closeOpenClawStateDatabaseForTest();
    const pathname = resolveOpenClawStateSqlitePath(env);
    const displaced = pathname + ".prior";
    fs.renameSync(pathname, displaced);
    fs.copyFileSync(displaced, pathname);
    expect(() => progress.flushLedgerWrites()).toThrow();
    expect(admission.canWrite).toBe(false);
    expect(getUpdateRun(run.runId, { env })).toEqual(before);
    expect(getUpdateRun(run.runId, { env, path: displaced })).toEqual(before);

    const receiverAdmission = withMockedPlatform("freebsd", () =>
      createFreeBsdUpdateWriteAdmission()!,
    );
    await receiverAdmission.revalidate(() => {});
    // The authenticated finalizer performs this local adoption before minting its binding.
    adoptUpdateRun(run.runId, { env });
    const receiver = { runId: run.runId, env, freebsdWriteAdmission: receiverAdmission };
    admitUpdateCommandLedger(receiver);
    createUpdateRunProgress(receiver, {}).onStepStart?.({
      name: "buffered step",
      command: "fixture",
      index: 0,
      total: 1,
    });
    expect(getUpdateRun(run.runId, { env })?.steps).toContainEqual(
      expect.objectContaining({ step: "buffered step", status: "in_progress" }),
    );
    expect(getUpdateRun(run.runId, { env, path: displaced })).toEqual(before);
    expect(admission.canWrite).toBe(false);
    expect(receiverAdmission.canWrite).toBe(true);
  });
});

it.each(["write", "mark"] as const)(
  "refuses the first sentinel %s after awaited preparation replaces the admitted database",
  async (operation) => {
    await withTestDir({ prefix: "update-sentinel-generation-" }, async (root) => {
      const env = { OPENCLAW_STATE_DIR: path.join(root, "selected") };
      const replacementEnv = { OPENCLAW_STATE_DIR: path.join(root, "replacement") };
      const { run, admission } = await admittedRun(env);
      const sibling = createUpdateRun({ trigger: "cli" }, { env: replacementEnv });
      const meta = { runId: run.runId, handoffId: "admitted-owner" };
      const pending = {
        kind: "update" as const,
        status: "skipped" as const,
        ts: 1,
        stats: meta,
      };
      await writeRestartSentinel(pending, env);
      await writeRestartSentinel(pending, replacementEnv);
      expect(getUpdateRun(run.runId, { env: replacementEnv })).toBeUndefined();
      expect(getUpdateRun(sibling.runId, { env: replacementEnv })).toBeDefined();
      closeOpenClawStateDatabaseForTest();
      const pathname = resolveOpenClawStateSqlitePath(env);
      const replacement = resolveOpenClawStateSqlitePath(replacementEnv);
      const displaced = pathname + ".prior";
      const originalBefore = readPublicationRows(pathname);
      const replacementBefore = readPublicationRows(replacement);
      // Restart preparation yields before notice publication. No heartbeat or
      // execution guard observes the replacement before this first writer.
      await Promise.resolve().then(() => {
        fs.renameSync(pathname, displaced);
        fs.copyFileSync(replacement, pathname);
      });
      const publish = () =>
        operation === "write"
          ? writeControlPlaneUpdateRestartSentinelBestEffort({
              meta,
              result: { status: "ok", mode: "npm", steps: [], durationMs: 1 },
              jsonMode: true,
              env,
              run,
            })
          : markControlPlaneUpdateRestartSentinelFailureBestEffort({
              meta,
              reason: "restart-unhealthy",
              jsonMode: true,
              env,
              run,
            });
      await expect(publish()).rejects.toThrow(
        "SQLite database file identity changed before existing-only open",
      );
      const first = admission.failure;
      expect(first).toBeInstanceOf(Error);
      expect(admission.canWrite).toBe(false);
      expect(readPublicationRows(displaced)).toEqual(originalBefore);
      expect(readPublicationRows(pathname)).toEqual(replacementBefore);
      closeOpenClawStateDatabaseForTest();
      const rejected = pathname + ".rejected";
      fs.renameSync(pathname, rejected);
      fs.renameSync(displaced, pathname);
      await expect(publish()).rejects.toBe(first);
      expect(admission.revoke(new Error("later refusal"))).toBe(first);
      expect(readPublicationRows(pathname)).toEqual(originalBefore);
      expect(readPublicationRows(rejected)).toEqual(replacementBefore);
    });
  },
);

it.each([false, true])(
  "retains admitted-generation CLI sentinel policy (requested=%s)",
  async (requested) => {
    await withTestDir({ prefix: "update-sentinel-current-" }, async (root) => {
      const { run, admission } = await admittedRun({
        OPENCLAW_STATE_DIR: path.join(root, "selected"),
      });
      const callerEnv = { OPENCLAW_STATE_DIR: path.join(root, "caller") };
      const meta = { runId: run.runId, ...(requested ? { note: "requested follow-up" } : {}) };
      const before = getUpdateRun(run.runId, { env: run.env });
      await writeControlPlaneUpdateRestartSentinelBestEffort({
        meta,
        result: { status: "skipped", mode: "npm", steps: [], durationMs: 1 },
        jsonMode: true,
        env: callerEnv,
        run,
      });
      const published = await readRestartSentinelReadOnly(run.env);
      if (requested) {
        expect(published?.payload).toMatchObject({
          status: "skipped",
          stats: { runId: run.runId },
        });
      } else {
        expect(published).toBeNull();
      }
      await markControlPlaneUpdateRestartSentinelFailureBestEffort({
        meta,
        reason: "restart-unhealthy",
        jsonMode: true,
        env: callerEnv,
        run,
      });
      const marked = await readRestartSentinelReadOnly(run.env);
      if (requested) {
        expect(marked?.payload).toMatchObject({
          status: "error",
          stats: { runId: run.runId, reason: "restart-unhealthy" },
        });
      } else {
        expect(marked).toBeNull();
      }
      expect(getUpdateRun(run.runId, { env: run.env })).toEqual(before);
      expect(admission.canWrite).toBe(true);
      expect(fs.existsSync(callerEnv.OPENCLAW_STATE_DIR)).toBe(false);
    });
  },
);
