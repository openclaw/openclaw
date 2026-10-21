import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/io.js";
import { createRetainedCheckpointFixture } from "../../infra/update-retained-checkpoint.test-support.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function refuse(message: string): never {
  throw new Error(message);
}

async function fixture() {
  const f = createRetainedCheckpointFixture(fs.realpathSync(dirs.make("rollback-retained-")), true);
  const { env, configPath } = f;
  const configSnapshot = await createConfigIO({ env, configPath }).readConfigFileSnapshot();
  const opts: UpdateCommandOptions = {
    run: f.run,
    recovery: {
      options: f.options,
      fence: { assertCurrent: () => refuse("retained owner is no longer live") },
      getRecord: () => f.record,
      onRecord: () => refuse("retained record must remain read-only"),
      assertReady: () => refuse("no live readiness authority"),
    },
  };
  const rollback = vi.fn(async () => refuse("legacy rollback must not run"));
  const complete = vi.fn();
  const invoke = async (
    preManagedServiceStop?: Parameters<typeof rollbackFailedUpdate>[0]["preManagedServiceStop"],
    files = [f.file],
  ) => {
    const before = files.map((file) => fs.readFileSync(file));
    const result = await rollbackFailedUpdate({
      definitionRecovery: {},
      result: {
        status: "error",
        mode: "npm",
        root: f.root,
        reason: "candidate-failed",
        steps: [],
        durationMs: 1,
      },
      previousRoot: f.root,
      configSnapshot,
      opts,
      timeoutMs: 1000,
      packageTransaction: { rollback, complete, backupRoot: path.join(f.root, "retained") },
      preManagedServiceStop,
    });
    expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
    expect(rollback).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      rolledBack: false,
      pendingRecoveryReason: expect.any(String),
    });
    return result;
  };
  return { ...f, opts, invoke };
}

const deferred = {
  result: { reason: "candidate-failed", recovery: { serviceRestartSafe: false } },
};

it("refuses checkpoint recovery before package mutation and preserves the primary failure", async () => {
  const f = await fixture();
  const files = [f.file, f.record.checkpoint!.ref.manifestPath, f.record.restore!.planPath];
  expect(await f.invoke(undefined, files)).toMatchObject({
    ...deferred,
    pendingRecoveryReason: expect.stringContaining("deferred"),
  });
  expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.record);
  expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("running");
});

it.each(["lost context", "lost run", "interrupted displacement"] as const)(
  "does not reinterpret %s as permission for package rollback",
  async (change) => {
    const f = await fixture();
    f.opts.recovery = undefined;
    if (change === "lost run") {
      f.opts.run = undefined;
      vi.stubEnv("OPENCLAW_STATE_DIR", f.root);
    }
    if (change === "interrupted displacement") {
      f.displace();
      await f.invoke(undefined, [f.displaced]);
      expect(fs.existsSync(f.file)).toBe(false);
    } else {
      expect(await f.invoke(undefined, [f.file, f.configPath])).toMatchObject(deferred);
    }
  },
);

it.each(["service", "admitted"] as const)(
  "checks pending recovery in the %s root when service and history differ",
  async (pendingRoot) => {
    const f = await fixture();
    f.opts.recovery = undefined;
    const cleanEnv = { OPENCLAW_STATE_DIR: dirs.make("rollback-other-root-") };
    f.opts.run = { ...f.run, env: pendingRoot === "admitted" ? f.env : cleanEnv };
    const { result } = await f.invoke({
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: false,
      serviceEnv: pendingRoot === "service" ? f.env : cleanEnv,
    });
    expect(result.reason).toBe("candidate-failed");
  },
);
