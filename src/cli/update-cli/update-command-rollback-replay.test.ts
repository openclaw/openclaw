import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function fixture(sealed = true) {
  const f = createRetainedCheckpointFixture(
    fs.realpathSync(dirs.make("rollback-retained-")),
    sealed,
  );
  const configSnapshot = await createConfigIO({
    env: f.env,
    configPath: f.configPath,
  }).readConfigFileSnapshot();
  const opts: UpdateCommandOptions = {
    run: f.run,
    recovery: {
      options: f.options,
      fence: {
        assertCurrent() {
          throw new Error("retained owner is no longer live");
        },
      },
      getRecord: () => f.record,
      onRecord() {
        throw new Error("retained record must remain read-only");
      },
      assertReady() {
        throw new Error("no live readiness authority");
      },
    },
  };
  const rollback = vi.fn(async () => {
    throw new Error("legacy rollback must not run");
  });
  const complete = vi.fn();
  const invoke = (
    preManagedServiceStop?: Parameters<typeof rollbackFailedUpdate>[0]["preManagedServiceStop"],
  ) =>
    rollbackFailedUpdate({
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
  return { ...f, opts, rollback, complete, invoke };
}

describe("retained full-state recovery is read-only", () => {
  it.each([true, false])(
    "refuses sealed=%s before package mutation and preserves the primary failure",
    async (sealed) => {
      const f = await fixture(sealed);
      const before = fs.readFileSync(f.file);
      const manifest = fs.readFileSync(f.record.checkpoint!.ref.manifestPath);
      const plan = fs.readFileSync(f.record.restore!.planPath);
      expect(await f.invoke()).toMatchObject({
        rolledBack: false,
        result: { reason: "candidate-failed", recovery: { serviceRestartSafe: false } },
        pendingRecoveryReason: expect.stringContaining("deferred"),
      });
      expect(fs.readFileSync(f.file)).toEqual(before);
      expect(fs.readFileSync(f.record.checkpoint!.ref.manifestPath)).toEqual(manifest);
      expect(fs.readFileSync(f.record.restore!.planPath)).toEqual(plan);
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
      expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.record);
      expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("running");
    },
  );

  it.each(["operator edit", "foreign root", "relative root", "lost context", "lost run"] as const)(
    "does not reinterpret %s as permission for package rollback",
    async (change) => {
      const f = await fixture();
      if (change === "operator edit") {
        fs.writeFileSync(f.configPath, "operator-newer");
      }
      if (change === "foreign root") {
        f.opts.run = { ...f.run, env: { OPENCLAW_STATE_DIR: path.join(f.root, "foreign") } };
      }
      if (change === "relative root") {
        f.opts.run = {
          ...f.run,
          env: { ...f.env, OPENCLAW_STATE_DIR: path.relative(process.cwd(), f.root) },
        };
      }
      if (change === "lost context" || change === "lost run") {
        f.opts.recovery = undefined;
      }
      if (change === "lost run") {
        f.opts.run = undefined;
        vi.stubEnv("OPENCLAW_STATE_DIR", f.root);
      }
      const before = fs.readFileSync(f.file);
      const config = fs.readFileSync(f.configPath);
      expect(await f.invoke()).toMatchObject({
        rolledBack: false,
        result: { reason: "candidate-failed", recovery: { serviceRestartSafe: false } },
        pendingRecoveryReason: expect.any(String),
      });
      expect(fs.readFileSync(f.file)).toEqual(before);
      expect(fs.readFileSync(f.configPath)).toEqual(config);
      expect(fs.existsSync(path.join(f.root, "foreign"))).toBe(false);
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "refuses an interrupted displacement with live-context=%s without recreating canonical state",
    async (context) => {
      const f = await fixture();
      f.displace();
      if (!context) {
        f.opts.recovery = undefined;
      }
      const before = fs.readFileSync(f.displaced);
      expect(await f.invoke()).toMatchObject({
        rolledBack: false,
        pendingRecoveryReason: expect.any(String),
      });
      expect(fs.existsSync(f.file)).toBe(false);
      expect(fs.readFileSync(f.displaced)).toEqual(before);
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    },
  );

  it.each(["service", "admitted"] as const)(
    "checks pending recovery in the %s root when service and history differ",
    async (pendingRoot) => {
      const f = await fixture();
      f.opts.recovery = undefined;
      const cleanEnv = { OPENCLAW_STATE_DIR: dirs.make("rollback-other-root-") };
      f.opts.run = { ...f.run, env: pendingRoot === "admitted" ? f.env : cleanEnv };
      const before = fs.readFileSync(f.file);
      expect(
        await f.invoke({
          stopped: false,
          inspected: true,
          runtimeInspected: true,
          running: false,
          serviceEnv: pendingRoot === "service" ? f.env : cleanEnv,
        }),
      ).toMatchObject({
        rolledBack: false,
        result: { reason: "candidate-failed" },
        pendingRecoveryReason: expect.any(String),
      });
      expect(fs.readFileSync(f.file)).toEqual(before);
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    },
  );
});
