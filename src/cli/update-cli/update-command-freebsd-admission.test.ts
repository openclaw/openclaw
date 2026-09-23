import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readRestartSentinelReadOnly, writeRestartSentinel } from "../../infra/restart-sentinel.js";
import { createFreeBsdUpdateWriteAdmission } from "../../infra/update-freebsd-write-admission.js";
import { buildUpdateRestartSentinelPayload } from "../../infra/update-restart-sentinel-payload.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import type { UpdateCommandOptions } from "./shared.js";
import { createUpdateCommandAuthority } from "./update-command-authority.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { admitUpdateCommandLedger } from "./update-command-ledger.js";
import {
  failUpdateCommandRun,
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import {
  completeUpdateCommandRun,
  createUpdateRunProgress,
  recordUpdateCommandTarget,
} from "./update-command-run.js";
import {
  deferUpdateCommandTerminalResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each([
  "executor",
  "requester",
  "finalizer requester",
  "state selector",
  "config selector",
  "environment",
  "run",
])("keeps history pending after the admitted %s changes, even when restored", async (change) => {
  await withTestDir({ prefix: "update-write-lifetime-" }, async (root) => {
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    const admission = withMockedPlatform("freebsd", () => createFreeBsdUpdateWriteAdmission()!);
    await admission.revalidate(() => {});
    let executorCurrent = true;
    let requesterCurrent = true;
    const refused = new Error("fixture executor revoked");
    const run: NonNullable<UpdateCommandOptions["run"]> = {
      runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
      env,
      freebsdWriteAdmission: admission,
      executorFence: {
        assertCurrent() {
          if (!executorCurrent) {
            throw refused;
          }
        },
      },
      requesterAuthority: {
        requester: { channel: "test", senderId: "owner" },
        isCurrent: () => requesterCurrent,
      },
    };
    admitUpdateCommandLedger(run);
    const opts: UpdateCommandOptions = { run };
    const finalizer = createUpdateCommandAuthority({ opts });
    const guards =
      change === "finalizer requester"
        ? {
            assertCurrent: finalizer.assertCurrent,
            assertBoundChildCurrent: finalizer.assertRequesterCurrent,
          }
        : createUpdateCommandExecutionGuards(opts, root);
    guards.assertCurrent();
    const before = getUpdateRun(run.runId, { env });
    if (change === "executor") {
      executorCurrent = false;
    }
    if (change === "requester" || change === "finalizer requester") {
      requesterCurrent = false;
    }
    if (change === "state selector") {
      env.OPENCLAW_STATE_DIR = path.join(root, "other-state");
    }
    if (change === "config selector") {
      env.OPENCLAW_CONFIG_PATH = path.join(root, "other.json");
    }
    if (change === "environment") {
      run.env = { ...env };
    }
    if (change === "run") {
      opts.run = { ...run };
    }
    expect(guards.assertCurrent).toThrow();
    const first = admission.failure;
    expect(first).toBeInstanceOf(Error);
    if (change === "executor") {
      expect(first).toBe(refused);
    }
    executorCurrent = true;
    requesterCurrent = true;
    env.OPENCLAW_STATE_DIR = root;
    env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
    run.env = env;
    opts.run = run;
    expect(guards.assertBoundChildCurrent).toThrow(first);
    expect(admission.canWrite).toBe(false);
    const progress = createUpdateRunProgress(run, {});
    progress.onHeartbeat?.();
    progress.onRollbackOutcome?.({ status: "failed", reason: "late callback" });
    progress.onStepStart?.({ name: "late step", command: "fixture", index: 0, total: 1 });
    progress.flushLedgerWrites();
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    expect(failUpdateCommandRun(new Error("ordinary failure"), run)).toBeUndefined();
    expect(() => recordUpdateCommandTarget(run, { target: { tag: "late" } })).toThrow(first);
    expect(
      completeUpdateCommandRun({ status: "ok", mode: "npm", steps: [], durationMs: 1 }, run).status,
    ).toBe("error");
    const publish = vi.fn();
    await expect(
      withUpdateCommandTerminalResult(async (register) => {
        register(run);
        expect(deferUpdateCommandTerminalResult(run, publish)).toBe(true);
      }),
    ).rejects.toMatchObject({ name: "UpdateCommandPendingRecoveryFailure" });
    expect(publish).not.toHaveBeenCalled();
    expect(getUpdateRun(run.runId, { env })).toEqual(before);
  });
});

it.each(["write", "mark"] as const)(
  "withholds selected sentinel %s during a recheck and retains the refusal afterwards",
  async (operation) => {
    await withTestDir({ prefix: "update-sentinel-admission-" }, async (root) => {
      const env = { OPENCLAW_STATE_DIR: path.join(root, "selected") };
      const callerEnv = { OPENCLAW_STATE_DIR: path.join(root, "caller") };
      const admission = withMockedPlatform("freebsd", () => createFreeBsdUpdateWriteAdmission()!);
      await admission.revalidate(() => {});
      const run = {
        runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
        env,
        freebsdWriteAdmission: admission,
      };
      admitUpdateCommandLedger(run);
      const meta = { runId: run.runId, handoffId: "write-admission" };
      const pending = buildUpdateRestartSentinelPayload({
        result: { status: "skipped", mode: "npm", steps: [], durationMs: 1 },
        meta,
      });
      await writeRestartSentinel(pending, callerEnv);
      await writeRestartSentinel(pending, env);
      const callerBefore = await readRestartSentinelReadOnly(callerEnv);
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
              reason: "fixture",
              jsonMode: true,
              env,
              run,
            });
      await publish();
      const selectedBefore = await readRestartSentinelReadOnly(env);
      const resume = createDeferred();
      const recheck = admission
        .revalidate(
          () => {},
          () => resume.promise,
        )
        .catch((error: unknown) => error);
      try {
        expect(admission.canWrite).toBe(false);
        await expect(publish()).rejects.toThrow();
      } finally {
        resume.resolve();
      }
      expect(await recheck).toBe(admission.failure);
      await expect(publish()).rejects.toBe(admission.failure);
      expect(await readRestartSentinelReadOnly(env)).toEqual(selectedBefore);
      expect(await readRestartSentinelReadOnly(callerEnv)).toEqual(callerBefore);
    });
  },
);
