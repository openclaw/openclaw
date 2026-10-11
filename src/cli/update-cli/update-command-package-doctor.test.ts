import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as backupConfigCapture from "../../infra/backup-config-capture.js";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner.js";
import { SqliteSchemaVersionError } from "../../infra/sqlite-user-version.js";
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
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import * as processRunner from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import * as configCapture from "./update-command-config-snapshot.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { runPackageUpdateDoctor } from "./update-command-package.js";
import { createUpdateRunProgress } from "./update-command-run.js";

afterEach(async () => {
  vi.useRealTimers();
  await closeStateDatabaseForTest();
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

it.each([
  { restart: false, contention: true },
  { restart: false, contention: true, wrapped: true },
  { restart: true, contention: true },
  { restart: false, contention: false },
  { restart: false, contention: false, wrapped: true },
])(
  "defers only operator-owned state contention ($restart, $contention, wrapped=$wrapped)",
  async ({ restart, contention, wrapped }) => {
    const { root, env } = await createDoctorFixture();
    const cause = contention
      ? new GatewayStateOwnerContentionError(resolveOpenClawStateSqlitePath(env))
      : new SqliteSchemaVersionError("This OpenClaw build cannot open your existing data.");
    const error = wrapped ? new Error("Cannot read shared state for discovery", { cause }) : cause;
    vi.spyOn(configCapture, "captureUpdateConfigSnapshot").mockRejectedValue(error);
    const spawn = vi.spyOn(processRunner, "runCommandWithTimeout");
    const onStepComplete = vi.fn();
    const results: UpdateStepResult[] = [];
    const operation = runPackageUpdateDoctor({
      root,
      restart,
      managedServiceEnv: env,
      results,
      progress: { onStepComplete },
      onConfigSnapshot: vi.fn(),
    });
    if (restart || !contention) {
      await expect(operation).rejects.toBe(error);
    } else {
      const step = await operation;
      assert(step);
      expect(step).toMatchObject({
        name: "post-install-verify",
        exitCode: null,
        advisory: {
          kind: "recoverable-maintenance",
          message: expect.stringContaining("deferred"),
        },
      });
      expect(step && isFailedUpdateStep(step)).toBe(false);
      expect(step?.advisory?.message).toContain("service owner");
      expect(step?.advisory?.message).toContain("openclaw update status");
      expect(step?.advisory?.message).toContain("openclaw doctor");
      expect(results).toEqual([step]);
      expect(onStepComplete).toHaveBeenCalledWith(expect.objectContaining(step));
    }
    expect(spawn).not.toHaveBeenCalled();
  },
);

it.each(["missing", "malformed", "newer-schema", "changed-during-capture"] as const)(
  "runs Doctor with %s include capture without broadening rollback ownership",
  async (includeState) => {
    const { root, env } = await createDoctorFixture();
    const originalRaw = '{"logging":{"$include":"./logging.json"}}\n';
    const includePath = path.join(root, "logging.json");
    const originalInclude = '{"level":"info"}\n';
    const operatorInclude = '{"level":"debug"}\n';
    const completeGraph = includeState === "newer-schema";
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const newerSchema = OPENCLAW_STATE_SCHEMA_VERSION + 1;
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, originalRaw);
    if (includeState === "malformed") {
      await fs.writeFile(includePath, '{"level": }\n');
    } else if (completeGraph || includeState === "changed-during-capture") {
      await fs.writeFile(includePath, originalInclude);
    }
    if (completeGraph) {
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(`PRAGMA user_version = ${newerSchema}`);
      } finally {
        database.close();
      }
    }
    let includeChanged = false;
    if (includeState === "changed-during-capture") {
      const resolvedInclude = await fs.realpath(includePath);
      const readCaptureFile = backupConfigCapture.readBackupConfigCaptureFile;
      vi.spyOn(backupConfigCapture, "readBackupConfigCaptureFile").mockImplementation(
        async (file) => {
          if (!includeChanged && file.canonicalPath === resolvedInclude) {
            includeChanged = true;
            await fs.writeFile(includePath, operatorInclude);
          }
          return await readCaptureFile(file);
        },
      );
    }
    const invokeDoctor = vi
      .spyOn(processRunner, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        expect(argv).toContain("doctor");
        assert(typeof options === "object");
        const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
        assert(resultPath, "Missing Doctor result path");
        await writeUpdatePostInstallDoctorResult({
          resultPath,
          result: { status: "ok", configHash: "unchanged" },
        });
        return {
          code: 0,
          stdout: "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
    const onConfigSnapshot = vi.fn();
    const onStepComplete = vi.fn();

    const step = await runPackageUpdateDoctor({
      root,
      timeoutMs: 1_000,
      progress: { onStepComplete },
      managedServiceEnv: env,
      onConfigSnapshot,
    });

    expect(invokeDoctor).toHaveBeenCalledOnce();
    expect(onConfigSnapshot).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        path: env.OPENCLAW_CONFIG_PATH,
        raw: originalRaw,
        doctorOwned: completeGraph,
      }),
    );
    expect(step).toMatchObject({ exitCode: 0 });
    if (completeGraph) {
      expect(onConfigSnapshot.mock.calls[0]?.[0]).toMatchObject({
        includedFiles: [
          {
            raw: originalInclude,
            doctorOwned: true,
            pathSnapshot: { targetPath: await fs.realpath(includePath) },
          },
        ],
      });
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()).toEqual({
          user_version: newerSchema,
        });
      } finally {
        database.close();
      }
    } else {
      expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          warnings: expect.arrayContaining([
            expect.stringContaining("automatic config rollback is unavailable"),
          ]),
        }),
      );
    }
    await expect(fs.readFile(env.OPENCLAW_CONFIG_PATH, "utf8")).resolves.toBe(originalRaw);
    if (includeState === "changed-during-capture") {
      expect(includeChanged).toBe(true);
      await expect(fs.readFile(includePath, "utf8")).resolves.toBe(operatorInclude);
    }
  },
);

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
  { cause: "reported-error-with-invalid-facts", exitCode: 0 },
  { cause: "success", exitCode: 0 },
  { cause: "advisory", exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE },
  { cause: "refusal", exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE },
] as const)(
  "retains Doctor receipts and completion for $cause (exit $exitCode)",
  async ({ cause, exitCode }) => {
    const { root, env } = await createDoctorFixture();
    const writerReceipt = cause === "success" || cause === "advisory" || cause === "refusal";
    const advisory = cause === "advisory" || cause === "refusal";
    const reason = cause === "refusal" ? "include-ownership" : undefined;
    const outputLimitExceeded = cause === "output-limit";
    const failureFacts = [
      {
        check: "config",
        code: "invalid-config",
        message: "Doctor reported invalid configuration.",
      },
    ];
    const receipt: UpdatePostInstallDoctorResult =
      outputLimitExceeded || advisory
        ? {
            ...createDeferredConfiguredPluginRepairDoctorResult([
              outputLimitExceeded
                ? "Configured repair deferred."
                : "Configured plugin repair deferred.",
            ]),
            ...(outputLimitExceeded ? { warnings: ["Doctor left a warning."] } : {}),
          }
        : {
            status: writerReceipt ? "ok" : "error",
            ...(cause === "reported-error" ? { failureFacts } : {}),
          };
    if (writerReceipt) {
      receipt.configChanges = [
        { kind: "key", key: "agents" },
        { kind: "migration", message: "Moved model allowlist." },
      ];
    }
    if (reason) {
      receipt.configWriteRefusal = { reason, message: "Config writer refused.", keys: ["agents"] };
    }
    const onStepComplete = vi.fn();
    vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      expect(argv).toContain("doctor");
      assert(typeof options === "object");
      const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
      assert(resultPath, "Missing Doctor result path");
      if (writerReceipt) {
        await writeUpdatePostInstallDoctorResult({ resultPath, result: receipt });
      } else {
        await fs.writeFile(
          resultPath,
          JSON.stringify({
            ...receipt,
            ...(cause === "reported-error-with-invalid-facts"
              ? { failureFacts: [{ code: 42 }] }
              : {}),
          }),
        );
      }
      return {
        code: exitCode,
        stdout: "",
        stderr: outputLimitExceeded ? "Doctor output exceeded its capture limit." : "",
        signal: null,
        killed: false,
        ...(!writerReceipt ? { outputLimitExceeded } : {}),
        termination: "exit",
      };
    });

    const run = writerReceipt
      ? undefined
      : { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const steps: UpdateStepResult[] = [];
    const step = await runPackageUpdateDoctor({
      root,
      timeoutMs: 1_000,
      managedServiceEnv: env,
      progress: run
        ? createUpdateRunProgress(
            run,
            { onStepComplete },
            createUpdateCommandExecutionGuards({ run }, root).recordStep,
          )
        : { onStepComplete },
      ...(writerReceipt ? { results: steps } : {}),
    });

    assert(step);
    if (run) {
      expect(step).toMatchObject({ exitCode, outputLimitExceeded });
      if (cause === "reported-error") {
        expect(step.failureFacts).toEqual(expect.arrayContaining(failureFacts));
      }
      expect(step.advisory).toBeUndefined();
      expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ exitCode, outputLimitExceeded, advisory: undefined }),
        expect.objectContaining({ runId: run.runId }),
      );
      expect(
        getUpdateRun(run.runId, { env })?.steps.find((entry) => entry.step === "openclaw doctor"),
      ).toMatchObject({ step: "openclaw doctor", status: "failed", exitCode });
      return;
    }
    expect(isFailedUpdateStep(step)).toBe(Boolean(reason));
    const expected = {
      exitCode,
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
  const run = { runId, env };
  const guards = createUpdateCommandExecutionGuards({ run }, root);
  const progress = createUpdateRunProgress(run, { onStepComplete }, guards.recordStep);
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

it("records the activation Doctor's traced sections on its step and run record", async () => {
  const { root, env } = await createDoctorFixture();
  vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", undefined);
  const { runId } = createUpdateRun({ trigger: "cli" }, { env });
  adoptUpdateRun(runId, { env });
  const run = { runId, env };
  const guards = createUpdateCommandExecutionGuards({ run }, root);
  const progress = createUpdateRunProgress(run, {}, guards.recordStep);
  const trace = (name: string, ms: number) =>
    `[gateway] startup trace: ${name} ${ms.toFixed(1)}ms total=${ms.toFixed(1)}ms start=0.0ms\n`;
  const stderr = [
    trace("cli.command.config-ready", 3),
    trace("doctor.maintenance.begin", 120),
    "real Doctor warning\n",
    trace("doctor.database-preflight", 12_300),
    trace("doctor.config-flow", 4_100),
    ...[
      ["doctor:gateway-services", 250_000],
      ["doctor:plugins", 40_000],
      ["doctor:sessions", 9_000],
      ["doctor:skills", 1_000],
      ["doctor:auth", 700],
      ["doctor:fast", 5],
    ].map(([id, ms]) => trace(`doctor.contribution.${id}`, Number(ms))),
    trace("doctor.contributions", 300_200),
    // JSON console style carries the same message inside one record.
    `${JSON.stringify({ level: "info", message: trace("doctor.maintenance-ready", 900).trim() })}\n`,
  ].join("");
  let doctorEnv: NodeJS.ProcessEnv | undefined;
  vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (_argv, options) => {
    assert(typeof options === "object");
    doctorEnv = options.env;
    // Lines arrive split across pipe chunks.
    const bytes = Buffer.from(stderr);
    for (let offset = 0; offset < bytes.length; offset += 7) {
      options.onOutputChunk?.(bytes.subarray(offset, offset + 7), "stderr");
    }
    const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
    assert(resultPath, "Missing Doctor result path");
    await writeUpdatePostInstallDoctorResult({ resultPath, result: { status: "ok" } });
    return { code: 0, stdout: "", stderr, signal: null, killed: false, termination: "exit" };
  });

  const step = await runPackageUpdateDoctor({
    root,
    timeoutMs: 60_000,
    managedServiceEnv: env,
    progress,
  });

  const sections =
    "Doctor sections: maintenance.begin 0.1 s, database-preflight 12.3 s, config-flow 4.1 s, contributions 300.2 s, maintenance-ready 0.9 s; slowest contributions: gateway-services 250.0 s, plugins 40.0 s, sessions 9.0 s, skills 1.0 s, auth 0.7 s";
  expect(doctorEnv?.OPENCLAW_GATEWAY_STARTUP_TRACE).toBe("1");
  expect(step).toMatchObject({ name: "openclaw doctor", exitCode: 0 });
  expect(step?.diagnostics?.[0]).toBe(sections);
  expect(step?.stderrTail).toBe("real Doctor warning");
  expect(getUpdateRun(runId, { env })?.steps).toContainEqual(
    expect.objectContaining({ step: "diagnostic:openclaw doctor", detail: sections }),
  );
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
    const onStepComplete = vi.fn(async () => {
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
