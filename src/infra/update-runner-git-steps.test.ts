import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  type UpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";
import { inspectUpdateRunAbandonment } from "./update-run-activity.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  getUpdateRun,
  heartbeatUpdateRun,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { ABANDONED_UPDATE_RUN_MS, UPDATE_RUN_HEARTBEAT_MS } from "./update-run-timeouts.js";
import { runStep } from "./update-runner-command.js";
import {
  buildUpdateDoctorEnv,
  resolveUpdateDoctorExecutionPolicy,
} from "./update-runner-doctor.js";
import { runGitDoctorStep } from "./update-runner-git-steps.js";
import type { UpdateStepProgress, UpdateStepResult } from "./update-runner-types.js";
const dirs = createTempDirTracker();

describe("resolveUpdateDoctorExecutionPolicy", () => {
  it("keeps fix mode when service repair is authorized", () => {
    expect(
      resolveUpdateDoctorExecutionPolicy({
        targetVersion: "2026.4.1",
        allowGatewayServiceRepair: true,
      }),
    ).toEqual({ fix: true });
  });

  it("uses the external policy for targets that support it", () => {
    for (const targetVersion of ["2026.4.25-beta.1", "2026.4.25-beta.11", "2026.4.25"]) {
      expect(
        resolveUpdateDoctorExecutionPolicy({
          targetVersion,
          allowGatewayServiceRepair: false,
        }),
      ).toEqual({ fix: true, serviceRepairPolicy: "external" });
    }
  });

  it("does not run fix mode on older targets that cannot honor ownership", () => {
    expect(
      resolveUpdateDoctorExecutionPolicy({
        targetVersion: "2026.4.24",
        allowGatewayServiceRepair: false,
      }),
    ).toEqual({ fix: false });
  });

  it.each([
    {
      name: "authorized service repair",
      targetVersion: "2026.4.1",
      allowGatewayServiceRepair: true,
      expectedPolicy: null,
    },
    {
      name: "an older target without service repair",
      targetVersion: "2026.4.24",
      allowGatewayServiceRepair: false,
      expectedPolicy: null,
    },
    {
      name: "a supported target without service repair",
      targetVersion: "2026.4.25",
      allowGatewayServiceRepair: false,
      expectedPolicy: "external",
    },
  ])(
    "passes the selected Doctor policy to a real child for $name",
    async ({ targetVersion, allowGatewayServiceRepair, expectedPolicy }) => {
      const policy = resolveUpdateDoctorExecutionPolicy({
        targetVersion,
        allowGatewayServiceRepair,
      });
      const result = await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, () =>
        runCommandWithTimeout(
          [
            process.execPath,
            "-e",
            "process.stdout.write(JSON.stringify(process.env.OPENCLAW_SERVICE_REPAIR_POLICY ?? null))",
          ],
          {
            timeoutMs: 5000,
            env: buildUpdateDoctorEnv({
              allowGatewayServiceRepair,
              allowGatewayActivation: false,
              serviceRepairPolicy: policy.serviceRepairPolicy,
            }),
          },
        ),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(JSON.stringify(expectedPolicy));
    },
  );
});

describe("direct Git Doctor receipts", () => {
  it.each([undefined, "include-ownership", "requester-revoked"])(
    "retains writer evidence and refusal %s without a CLI callback",
    async (reason) => {
      const result: UpdatePostInstallDoctorResult = {
        status: reason ? "error" : "ok",
        configChanges: [{ kind: "key", key: "agents" }],
        ...(reason
          ? { configWriteRefusal: { reason, message: "Config writer refused.", keys: ["agents"] } }
          : {}),
      };
      const steps: UpdateStepResult[] = [];
      const onStepComplete = vi.fn();
      const step = await runGitDoctorStep({
        root: "/synthetic/checkout",
        entryPath: "/synthetic/checkout/openclaw.mjs",
        nodePath: "/synthetic/node",
        fix: true,
        doctorEnvOptions: { allowGatewayServiceRepair: false, allowGatewayActivation: false },
        env: {},
        step: (name, argv, cwd, env) => ({
          name,
          argv,
          cwd,
          env,
          timeoutMs: 1000,
          stepIndex: 0,
          totalSteps: 1,
          results: steps,
          progress: { onStepComplete },
          runCommand: async (_argv, options) => {
            const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
            if (!resultPath) {
              throw new Error("Missing Doctor result path");
            }
            await writeUpdatePostInstallDoctorResult({ resultPath, result });
            return { code: 0, stdout: "", stderr: "" };
          },
        }),
      });

      expect(step).toMatchObject({
        exitCode: reason ? 1 : 0,
        configChanges: result.configChanges,
      });
      assert(step);
      expect(step.configWriteRefusal).toEqual(result.configWriteRefusal);
      expect(steps).toEqual([step]);
      expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          configChanges: result.configChanges,
          ...(reason ? { configWriteRefusal: result.configWriteRefusal } : {}),
        }),
      );
      if (reason) {
        expect(step.stderrTail).toContain(`agents. ${reason}: Config writer refused.`);
        expect(step.advisory).toBeUndefined();
      }
    },
  );
});

// The activation Doctor repairs the same state database its parent records into.
describe("activation Doctor ledger writes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("update-doctor-heartbeat-"));
    vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    dirs.cleanup();
  });

  /** The gateway `update.run` ledger writes: its heartbeat and step-start sinks. */
  function gatewayProgress(runId: string): UpdateStepProgress {
    const driver = adoptUpdateRun(runId).origin.driver;
    expect(driver?.pid).toBe(process.pid);
    return {
      onHeartbeat: () => heartbeatUpdateRun(runId, driver),
      onStepStart: (step) =>
        recordUpdateRunStep(runId, {
          step: step.name,
          status: "in_progress",
          startedAtMs: Date.now(),
        }),
      onStepComplete: () => {},
    };
  }

  it("writes nothing to the run ledger while the Doctor child holds the coordinator", async () => {
    const { runId } = createUpdateRun({ trigger: "control-ui" });
    const spawned = createDeferredCore();
    const exited = createDeferredCore();

    const running = runGitDoctorStep({
      root: "/synthetic/checkout",
      entryPath: "/synthetic/checkout/openclaw.mjs",
      nodePath: "/synthetic/node",
      fix: true,
      doctorEnvOptions: { allowGatewayServiceRepair: false, allowGatewayActivation: false },
      env: {},
      step: (name, argv, cwd, env) => ({
        name,
        argv,
        cwd,
        env,
        timeoutMs: 600_000,
        stepIndex: 0,
        totalSteps: 1,
        progress: gatewayProgress(runId),
        runCommand: async (_argv, options) => {
          spawned.resolve();
          await exited.promise;
          const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
          if (!resultPath) {
            throw new Error("Missing Doctor result path");
          }
          await writeUpdatePostInstallDoctorResult({ resultPath, result: { status: "ok" } });
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    });

    try {
      await spawned.promise;
      // The Doctor step start is the liveness record that replaces the heartbeat.
      const admitted = getUpdateRun(runId);
      expect(admitted?.steps.at(-1)).toMatchObject({
        step: "openclaw doctor",
        status: "in_progress",
      });

      await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);
      const observed = getUpdateRun(runId);
      expect(observed).toEqual(admitted);
      if (!observed) {
        throw new Error("The activation Doctor step lost its update run.");
      }
      // Removing the heartbeat must not let the live driver's run look abandoned.
      expect(inspectUpdateRunAbandonment(observed)).toBeUndefined();
    } finally {
      exited.resolve();
    }
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
    expect(getUpdateRun(runId)?.status).toBe("running");
  });

  // Control: the same elapsed time does reach the ledger from an ordinary step,
  // so the assertions above cannot pass because no heartbeat could ever land.
  it("still refreshes the run ledger for a step that spawns no Doctor", async () => {
    const { runId } = createUpdateRun({ trigger: "control-ui" });
    const spawned = createDeferredCore();
    const exited = createDeferredCore();

    const running = runStep({
      name: "git fetch",
      argv: ["git", "fetch"],
      cwd: "/synthetic/checkout",
      timeoutMs: 600_000,
      stepIndex: 0,
      totalSteps: 1,
      progress: gatewayProgress(runId),
      runCommand: async () => {
        spawned.resolve();
        await exited.promise;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await spawned.promise;
    const admitted = getUpdateRun(runId);
    await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
    expect(getUpdateRun(runId)?.updatedAtMs).toBeGreaterThan(admitted?.updatedAtMs ?? 0);

    exited.resolve();
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
  });
});
