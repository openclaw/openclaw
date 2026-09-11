import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createRetainedCheckpointFixture } from "../../infra/update-retained-checkpoint.test-support.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as updateShared from "./shared.js";
import type { UpdateCommandOptions } from "./shared.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import {
  finishSuccessfulPackageSwitch,
  taskRecovery,
} from "./update-command-post-update.test-support.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = fs.realpathSync(dirs.make("pending-finalizer-"));
  const retained = createRetainedCheckpointFixture(root);
  const { env, options, file, run, runtime, record, displaced } = retained;
  retained.displace();
  const recovery = {
    options,
    fence: {
      assertCurrent() {
        throw new Error("prior owner released");
      },
    },
    getRecord: () => record,
    onRecord() {
      throw new Error("retained record must not change");
    },
    assertReady() {
      throw new Error("no readiness authority");
    },
  };
  const opts: UpdateCommandOptions = { run, recovery };
  const windows = taskRecovery();
  const rollback = vi.fn(async () => {
    throw new Error("legacy rollback must not run");
  });
  const complete = vi.fn();
  return {
    root,
    env,
    file,
    displaced,
    opts,
    windows,
    rollback,
    complete,
    entries: () => 0,
    invoke: (previousInstallRoot = runtime.root) =>
      finishSuccessfulPackageSwitch(
        { packageRoot: runtime.root, run },
        {
          root: runtime.root,
          previousInstallRoot,
          opts,
          result: {
            status: "error",
            mode: "npm",
            root: runtime.root,
            runId: run.runId,
            reason: "candidate-failed",
            steps: [],
            durationMs: 1,
          },
          preManagedServiceStop: {
            inspected: true,
            runtimeInspected: true,
            running: false,
            stopped: true,
            serviceEnv: env,
            windowsTaskAutoStartRecovery: windows,
          },
          packageTransaction: { rollback, complete, backupRoot: path.join(root, "retained") },
        },
      ),
  };
}

describe("pending recovery finalizer", () => {
  it("refuses standalone finalization before recreating a displaced canonical database", async () => {
    const f = await fixture();
    const before = fs.readFileSync(f.displaced);
    const config = path.join(f.root, "openclaw.json");
    const originalConfig = fs.readFileSync(config);
    const resolveRoot = vi
      .spyOn(updateShared, "resolveUpdateRoot")
      .mockRejectedValue(new Error("ordinary finalization reached root discovery"));
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    await expect(
      withOwnedManagedUpdateEnv({ ...process.env, ...f.env, OPENCLAW_CONFIG_PATH: config }, () =>
        updateFinalizeCommand({ json: true, yes: true, deferCompletionCache: true }),
      ),
    ).rejects.toThrow("full-state recovery is deferred");
    expect(resolveRoot).not.toHaveBeenCalled();
    expect(fs.existsSync(f.file)).toBe(false);
    expect(fs.readFileSync(f.displaced)).toEqual(before);
    expect(fs.readFileSync(config)).toEqual(originalConfig);
  });

  it.each([true, false])(
    "preserves a missing canonical database with live-context=%s",
    async (context) => {
      const f = await fixture();
      if (!context) {
        f.opts.recovery = undefined;
      }
      const before = fs.readFileSync(f.displaced);
      const failure = await f.invoke().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        name: "UpdateCommandPendingRecoveryFailure",
        result: {
          reason: "candidate-failed",
          runId: f.opts.run!.runId,
          recovery: { serviceRestartSafe: false },
        },
      });
      expect(f.entries()).toBe(0);
      expect(fs.existsSync(f.file)).toBe(false);
      expect(fs.readFileSync(f.displaced)).toEqual(before);
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.windows.restore).not.toHaveBeenCalled();
      expect(f.windows.complete).not.toHaveBeenCalled();
    },
  );
  it("refuses retained recovery without touching either the managed or caller root", async () => {
    const f = await fixture();
    const failure = await f.invoke(path.join(f.root, "caller-install")).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      name: "UpdateCommandPendingRecoveryFailure",
      result: { reason: "candidate-failed" },
    });
    expect(f.entries()).toBe(0);
    expect(fs.existsSync(f.file)).toBe(false);
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.windows.restore).not.toHaveBeenCalled();
  });

  it.each(["finalizer", "reported", "unexpected", "completed"] as const)(
    "keeps %s unwind away from autostart, history and managed triage",
    async (kind) => {
      const f = await fixture();
      const run = f.opts.run;
      if (!run) {
        throw new Error("fixture run absent");
      }
      if (kind === "unexpected" || kind === "completed") {
        f.opts.recovery = undefined;
      }
      const before = fs.readFileSync(f.displaced);
      const context = path.join(f.root, "triage.json");
      const meta = path.join(f.root, "sentinel.json");
      fs.writeFileSync(context, "unchanged");
      fs.writeFileSync(meta, JSON.stringify({ meta: { triageContextPath: context } }));
      const primary = {
        status: "error" as const,
        mode: "npm" as const,
        runId: run.runId,
        reason: "candidate-failed",
        steps: [],
        durationMs: 1,
      };
      const target = {
        root: f.root,
        env: {
          ...f.env,
          OPENCLAW_UPDATE_RUN_HANDOFF: "1",
          [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: meta,
        },
        failureResult: primary,
      };
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
      const result = withUpdateFailureTriage({ ...f.opts, json: true }, target, () =>
        withUpdateCommandRecoveryUnwind(
          { ...f.opts, run },
          { triageTarget: target, windowsTaskAutoStartRecovery: f.windows },
          async () => {
            if (kind === "unexpected") {
              throw new Error("lost executor context");
            }
            if (kind === "reported") {
              throw new UpdateCommandFailure(primary);
            }
            if (kind === "finalizer") {
              await f.invoke();
            }
          },
        ),
      );
      await expect(result).rejects.toMatchObject({ code: 1 });
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "candidate-failed",
          runId: run.runId,
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        }),
      );
      expect(fs.existsSync(f.file)).toBe(false);
      expect(fs.readFileSync(f.displaced)).toEqual(before);
      expect(fs.readFileSync(context, "utf8")).toBe("unchanged");
      expect(f.windows.restore).not.toHaveBeenCalled();
      expect(f.windows.complete).not.toHaveBeenCalled();
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    },
  );
});

describe("migrated-runtime unwind", () => {
  it.each([false, true])(
    "preserves newer canonical state after handoff (failure=%s)",
    async (failed) => {
      const root = fs.realpathSync(dirs.make("migrated-unwind-"));
      const env = { HOME: root, OPENCLAW_STATE_DIR: root };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      closeOpenClawStateDatabaseForTest();
      const file = path.join(root, "state", "openclaw.sqlite");
      const db = new DatabaseSync(file);
      try {
        const row = db.prepare("PRAGMA user_version").get();
        db.exec(`PRAGMA user_version=${Number(row?.user_version) + 1}`);
      } finally {
        db.close();
      }
      const before = fs.readFileSync(file);
      const windows = taskRecovery();
      const failure = new UpdateCommandFailure({
        status: "error",
        mode: "npm",
        runId: run.runId,
        reason: "new-runtime-failed",
        steps: [],
        durationMs: 1,
      });
      const completion = withUpdateCommandRecoveryUnwind(
        { run },
        {
          ledgerHandoffOwned: true,
          ledgerHandoffCompleted: true,
          triageTarget: { env },
          windowsTaskAutoStartRecovery: windows,
        },
        async () => {
          if (failed) {
            throw failure;
          }
        },
      );
      if (failed) {
        await expect(completion).rejects.toBe(failure);
      } else {
        await expect(completion).resolves.toBeUndefined();
      }
      expect(windows.restore).toHaveBeenCalledOnce();
      expect(windows.complete).toHaveBeenCalledOnce();
      expect(fs.readFileSync(file)).toEqual(before);
    },
  );
});

it.each([false, true])(
  "leaves an unconfirmed migrated handoff pending (failure=%s)",
  async (failed) => {
    const root = fs.realpathSync(dirs.make("unconfirmed-handoff-"));
    const env = { HOME: root, OPENCLAW_STATE_DIR: root };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    closeOpenClawStateDatabaseForTest();
    const file = path.join(root, "state", "openclaw.sqlite");
    const before = fs.readFileSync(file);
    const windows = taskRecovery();
    const cause = new Error("candidate finalizer unavailable");
    const primary = {
      status: "error" as const,
      mode: "npm" as const,
      runId: run.runId,
      reason: "candidate-failed",
      steps: [],
      durationMs: 1,
    };
    await expect(
      withUpdateCommandRecoveryUnwind(
        { run },
        {
          ledgerHandoffOwned: true,
          triageTarget: { env, failureResult: primary },
          windowsTaskAutoStartRecovery: windows,
        },
        async () => {
          if (failed) {
            throw cause;
          }
        },
      ),
    ).rejects.toMatchObject({
      name: "UpdateCommandPendingRecoveryFailure",
      result: { reason: "candidate-failed", recovery: { serviceRestartSafe: false } },
      ...(failed ? { cause } : {}),
    });
    expect(windows.restore).not.toHaveBeenCalled();
    expect(windows.complete).toHaveBeenCalledExactlyOnceWith(false);
    expect(fs.readFileSync(file)).toEqual(before);
  },
);
