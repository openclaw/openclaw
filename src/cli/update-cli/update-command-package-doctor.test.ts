import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  type UpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { inspectUpdateRunAbandonment } from "../../infra/update-run-activity.js";
import { adoptUpdateRun, createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { isFailedUpdateStep } from "../../infra/update-run-step.js";
import {
  ABANDONED_UPDATE_RUN_MS,
  UPDATE_RUN_HEARTBEAT_MS,
} from "../../infra/update-run-timeouts.js";
import type { UpdateStepResult } from "../../infra/update-runner-types.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import * as processRunner from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { runUpdateStep } from "./shared.js";
import { runPackageUpdateDoctor } from "./update-command-package.js";
import { createUpdateRunProgress } from "./update-command-run.js";

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createDoctorFixture() {
  const root = tempDirs.make("update-package-doctor-");
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(root);
  const env = {
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "entry.js"), "export {};\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.4" }));
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}\n");
  return { root, env };
}

it("does not spawn Doctor when the installed runtime has no entrypoint", async () => {
  const { root, env } = await createDoctorFixture();
  await fs.rm(path.join(root, "dist", "entry.js"));
  const spawn = vi
    .spyOn(processRunner, "runCommandWithTimeout")
    .mockRejectedValue(new Error("Doctor must not spawn without an installed entrypoint."));

  await expect(
    runPackageUpdateDoctor({ root, timeoutMs: 1_000, progress: {}, managedServiceEnv: env }),
  ).resolves.toBeNull();
  expect(spawn).not.toHaveBeenCalled();
});

it.each([
  { cause: "output-limit", exitCode: 0 },
  { cause: "output-limit", exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE },
  { cause: "reported-error", exitCode: 0 },
  { cause: "reported-error-without-facts", exitCode: 0 },
  { cause: "reported-error-with-empty-facts", exitCode: 0 },
  { cause: "reported-error-with-invalid-facts", exitCode: 0 },
] as const)(
  "keeps failed Doctor outcome $cause (exit $exitCode) failed through completion and history",
  async ({ cause, exitCode }) => {
    const { root, env } = await createDoctorFixture();
    const outputLimitExceeded = cause === "output-limit";
    const failureFacts = [
      {
        check: "config",
        code: "invalid-config",
        message: "Doctor reported invalid configuration.",
      },
    ];
    const { runId } = createUpdateRun({ trigger: "cli" }, { env });
    const onStepComplete = vi.fn();
    vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (_argv, options) => {
      assert(typeof options === "object");
      const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
      assert(resultPath);
      const receipt =
        cause === "output-limit"
          ? {
              ...createDeferredConfiguredPluginRepairDoctorResult(["Configured repair deferred."]),
              warnings: ["Doctor left a warning."],
            }
          : {
              status: "error",
              ...(cause === "reported-error" ? { failureFacts } : {}),
              ...(cause === "reported-error-with-empty-facts" ? { failureFacts: [] } : {}),
              ...(cause === "reported-error-with-invalid-facts"
                ? { failureFacts: [{ code: 42 }] }
                : {}),
            };
      await fs.writeFile(resultPath, JSON.stringify(receipt));
      return {
        code: exitCode,
        stdout: "",
        stderr: outputLimitExceeded ? "Doctor output exceeded its capture limit." : "",
        signal: null,
        killed: false,
        outputLimitExceeded,
        termination: "exit",
      };
    });

    const step = await runPackageUpdateDoctor({
      root,
      timeoutMs: 1_000,
      managedServiceEnv: env,
      progress: createUpdateRunProgress({ runId, env }, { onStepComplete }),
    });

    expect(step).toMatchObject({ exitCode, outputLimitExceeded });
    if (cause === "reported-error") {
      expect(step?.failureFacts).toEqual(expect.arrayContaining(failureFacts));
    }
    expect(step?.advisory).toBeUndefined();
    expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ exitCode, outputLimitExceeded, advisory: undefined }),
      expect.objectContaining({ runId }),
    );
    expect(
      getUpdateRun(runId, { env })?.steps.find((entry) => entry.step === "openclaw doctor"),
    ).toMatchObject({
      step: "openclaw doctor",
      status: "failed",
      exitCode,
    });
  },
);

it.each(
  ([undefined, "include-ownership", "requester-revoked"] as const).flatMap((reason) =>
    [false, true].map((advisory) => ({ reason, advisory })),
  ),
)(
  "retains Doctor writer receipts and refusal $reason (advisory: $advisory)",
  async ({ reason, advisory }) => {
    const { root, env } = await createDoctorFixture();
    const receipt: UpdatePostInstallDoctorResult = advisory
      ? createDeferredConfiguredPluginRepairDoctorResult(["Configured plugin repair deferred."])
      : { status: reason ? "error" : "ok" };
    receipt.configChanges = [
      { kind: "key", key: "agents" },
      { kind: "migration", message: "Moved model allowlist." },
    ];
    if (reason) {
      receipt.configWriteRefusal = { reason, message: "Config writer refused.", keys: ["agents"] };
    }
    vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      expect(argv).toContain("doctor");
      assert(typeof options === "object");
      const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
      assert(resultPath, "Missing Doctor result path");
      await writeUpdatePostInstallDoctorResult({ resultPath, result: receipt });
      return {
        code: advisory ? UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE : 0,
        stdout: "",
        stderr: "",
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
    const onStepComplete = vi.fn();
    const steps: UpdateStepResult[] = [];
    const step = await runPackageUpdateDoctor({
      root,
      timeoutMs: 1_000,
      progress: { onStepComplete },
      results: steps,
      managedServiceEnv: env,
    });

    assert(step);
    expect(isFailedUpdateStep(step)).toBe(Boolean(reason));
    const expected = {
      exitCode: advisory ? UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE : 0,
      configChanges: receipt.configChanges,
      ...(reason
        ? { stderrTail: expect.stringContaining(`agents. ${reason}: Config writer refused.`) }
        : {}),
    };
    const expectedAdvisory =
      advisory && !reason
        ? expect.objectContaining({ kind: "package-post-install-doctor" })
        : undefined;
    expect(step).toMatchObject(expected);
    expect(steps).toEqual([step]);
    expect(step.configWriteRefusal).toEqual(receipt.configWriteRefusal);
    expect(step.advisory).toEqual(expectedAdvisory);
    if (reason) {
      expect(step.failureFacts).toEqual(
        expect.arrayContaining([expect.objectContaining({ check: "config", code: reason })]),
      );
    }
    expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...expected,
        configWriteRefusal: receipt.configWriteRefusal,
        advisory: expectedAdvisory,
      }),
    );
  },
);

it("leaves the run ledger unchanged while the activation Doctor child is pending", async () => {
  const { root, env } = await createDoctorFixture();
  vi.useFakeTimers();
  const { runId } = createUpdateRun({ trigger: "control-ui" }, { env });
  expect(adoptUpdateRun(runId, { env }).origin.driver?.pid).toBe(process.pid);
  const spawned = createDeferredCore();
  const exited = createDeferredCore();
  const onStepComplete = vi.fn();
  const progress = createUpdateRunProgress({ runId, env }, { onStepComplete });
  let doctorEnv: NodeJS.ProcessEnv | undefined;
  vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (_argv, options) => {
    doctorEnv = typeof options === "object" ? options.env : undefined;
    spawned.resolve();
    await exited.promise;
    assert(typeof options === "object");
    const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
    assert(resultPath, "Missing Doctor result path");
    await writeUpdatePostInstallDoctorResult({ resultPath, result: { status: "ok" } });
    return { code: 0, stdout: "", stderr: "", signal: null, killed: false, termination: "exit" };
  });
  const running = runPackageUpdateDoctor({
    root,
    timeoutMs: ABANDONED_UPDATE_RUN_MS * 2,
    managedServiceEnv: env,
    progress,
  });

  try {
    await spawned.promise;
    expect(doctorEnv).toMatchObject({
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART: "1",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    });
    const admitted = getUpdateRun(runId, { env });
    expect(admitted?.steps.at(-1)).toMatchObject({
      step: "openclaw doctor",
      status: "in_progress",
    });
    await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);
    const observed = getUpdateRun(runId, { env });
    expect(observed).toEqual(admitted);
    assert(observed);
    expect(inspectUpdateRunAbandonment(observed)).toBeUndefined();
    expect(onStepComplete).not.toHaveBeenCalled();
  } finally {
    exited.resolve();
    await running;
  }
  await expect(running).resolves.toMatchObject({ exitCode: 0 });
  expect(onStepComplete).toHaveBeenCalledOnce();
  expect(getUpdateRun(runId, { env })).toMatchObject({
    status: "running",
    steps: expect.arrayContaining([
      expect.objectContaining({ step: "openclaw doctor", status: "completed" }),
    ]),
  });
});

it.each([
  { receiptKind: "none", cleanupUncertain: false, reportingFails: false },
  { receiptKind: "refusal", cleanupUncertain: false, reportingFails: false },
  { receiptKind: "advisory", cleanupUncertain: false, reportingFails: false },
  { receiptKind: "advisory", cleanupUncertain: true, reportingFails: false },
  { receiptKind: "refusal", cleanupUncertain: false, reportingFails: true },
] as const)(
  "retains failed Doctor evidence for $receiptKind receipt (cleanup uncertain: $cleanupUncertain, reporting fails: $reportingFails)",
  async ({ receiptKind, cleanupUncertain, reportingFails }) => {
    const { root, env } = await createDoctorFixture();
    const failed = new Error(
      "Doctor process failed before returning an exit status.",
      cleanupUncertain ? { cause: new CommandProcessCleanupError() } : undefined,
    );
    const receipt: UpdatePostInstallDoctorResult | undefined =
      receiptKind === "none"
        ? undefined
        : receiptKind === "advisory"
          ? createDeferredConfiguredPluginRepairDoctorResult(["Configured plugin repair deferred."])
          : {
              status: "error",
              configWriteRefusal: {
                reason: "include-ownership",
                message: "Config writer refused.",
                keys: ["agents"],
              },
              failureFacts: [{ check: "config", code: "include-ownership", affectedKey: "agents" }],
            };
    if (receipt) {
      receipt.configChanges = [{ kind: "migration", message: "Moved model allowlist." }];
    }
    let resultPath: string | undefined;
    let receiptBytes: string | undefined;
    const reportingError = new Error("Doctor progress could not be recorded.");
    const onStepComplete = vi.fn(() => {
      if (reportingFails) {
        throw reportingError;
      }
    });
    vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (_argv, options) => {
      expect(onStepComplete).not.toHaveBeenCalled();
      assert(typeof options === "object");
      resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
      assert(resultPath, "Missing Doctor result path");
      if (receipt) {
        await writeUpdatePostInstallDoctorResult({ resultPath, result: receipt });
        receiptBytes = await fs.readFile(resultPath, "utf8");
      }
      throw failed;
    });
    const steps: UpdateStepResult[] = [];
    const onConfigSnapshot = vi.fn();

    const error = await runPackageUpdateDoctor({
      root,
      timeoutMs: 1_000,
      progress: { onStepComplete },
      results: steps,
      managedServiceEnv: env,
      onConfigSnapshot,
    }).catch((cause: unknown) => cause);

    if (reportingFails) {
      assert(error instanceof AggregateError);
      expect(error.errors).toEqual([failed, reportingError]);
    } else {
      expect(error).toBe(failed);
    }
    expect(hasCommandProcessCleanupError(error)).toBe(cleanupUncertain);
    const consumedReceipt = cleanupUncertain ? undefined : receipt;
    if (cleanupUncertain) {
      expect(onStepComplete).not.toHaveBeenCalled();
    } else {
      expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          name: "openclaw doctor",
          exitCode: 1,
          configChanges: consumedReceipt?.configChanges,
          configWriteRefusal: consumedReceipt?.configWriteRefusal,
        }),
      );
    }
    expect(steps).toEqual([
      expect.objectContaining({
        name: "openclaw doctor",
        exitCode: 1,
        stderrTail: expect.stringContaining(
          consumedReceipt?.configWriteRefusal
            ? "include-ownership: Config writer refused."
            : failed.message,
        ),
      }),
    ]);
    const [step] = steps;
    assert(step);
    expect(step.configChanges).toEqual(consumedReceipt?.configChanges);
    expect(step.configWriteRefusal).toEqual(consumedReceipt?.configWriteRefusal);
    expect(step.advisory).toBeUndefined();
    expect(step.failureFacts).toEqual(
      expect.arrayContaining([
        ...(consumedReceipt?.failureFacts ?? []),
        expect.objectContaining({
          check: "openclaw doctor",
          message: expect.stringContaining(failed.message),
        }),
      ]),
    );
    assert(resultPath);
    if (cleanupUncertain) {
      expect(onConfigSnapshot).not.toHaveBeenCalled();
      assert(receiptBytes);
      await expect(fs.readFile(resultPath, "utf8")).resolves.toBe(receiptBytes);
    } else {
      await expect(fs.access(resultPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it("completes Doctor as failed when config attribution cannot read the settled output", async () => {
  const { root, env } = await createDoctorFixture();
  const onStepComplete = vi.fn();
  const onConfigSnapshot = vi.fn();
  const steps: UpdateStepResult[] = [];
  vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (_argv, options) => {
    expect(onStepComplete).not.toHaveBeenCalled();
    assert(typeof options === "object");
    const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
    assert(resultPath, "Missing Doctor result path");
    await writeUpdatePostInstallDoctorResult({
      resultPath,
      result: createDeferredConfiguredPluginRepairDoctorResult([
        "Configured plugin repair deferred.",
      ]),
    });
    await fs.rename(env.OPENCLAW_CONFIG_PATH, `${env.OPENCLAW_CONFIG_PATH}.previous`);
    await fs.mkdir(env.OPENCLAW_CONFIG_PATH);
    return {
      code: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
    };
  });

  const error = await runPackageUpdateDoctor({
    root,
    timeoutMs: 1_000,
    progress: { onStepComplete },
    results: steps,
    managedServiceEnv: env,
    onConfigSnapshot,
  }).catch((cause: unknown) => cause);

  expect(error).toMatchObject({ code: "EISDIR" });
  expect(onConfigSnapshot).not.toHaveBeenCalled();
  expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      name: "openclaw doctor",
      exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
      advisory: undefined,
    }),
  );
  expect(steps).toEqual([
    expect.objectContaining({
      name: "openclaw doctor",
      exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
    }),
  ]);
  expect(steps[0]?.advisory).toBeUndefined();
  expect(steps[0]?.failureFacts).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "EISDIR" })]),
  );
});

it("still refreshes the run ledger for a step that spawns no Doctor", async () => {
  const { root, env } = await createDoctorFixture();
  vi.useFakeTimers();
  const { runId } = createUpdateRun({ trigger: "control-ui" }, { env });
  expect(adoptUpdateRun(runId, { env }).origin.driver?.pid).toBe(process.pid);
  const spawned = createDeferredCore();
  const exited = createDeferredCore();
  const running = runUpdateStep({
    name: "git-fetch",
    argv: ["git", "fetch"],
    cwd: root,
    timeoutMs: ABANDONED_UPDATE_RUN_MS * 2,
    progress: createUpdateRunProgress({ runId, env }, {}),
    runCommand: async () => {
      spawned.resolve();
      await exited.promise;
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  try {
    await spawned.promise;
    const admitted = getUpdateRun(runId, { env });
    assert(admitted);
    await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
    expect(getUpdateRun(runId, { env })?.updatedAtMs).toBeGreaterThan(admitted.updatedAtMs);
  } finally {
    exited.resolve();
    await running;
  }
  await expect(running).resolves.toMatchObject({ exitCode: 0 });
});
