import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as backupConfigCapture from "../../infra/backup-config-capture.js";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner.js";
import { runPackagePostInstallVerification } from "../../infra/package-update-verification-step.js";
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
import * as stateSnapshots from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import * as configCapture from "./update-command-config-snapshot.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { processResult, updateResult } from "./update-command-maintenance-fixtures.test-support.js";
import { runPackageUpdateDoctor } from "./update-command-package.js";
import { completeUpdateCommandRun, createUpdateRunProgress } from "./update-command-run.js";

afterEach(async () => {
  vi.useRealTimers();
  await closeStateDatabaseForTest();
  vi.restoreAllMocks();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const updateRun = (env: NodeJS.ProcessEnv) => ({
  runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
  env,
});
const advisoryReceipt = (message = "Configured plugin repair deferred.") =>
  createDeferredConfiguredPluginRepairDoctorResult([message]);
const refusal: NonNullable<UpdatePostInstallDoctorResult["configWriteRefusal"]> = {
  reason: "include-ownership",
  message: "Config writer refused.",
  keys: ["agents"],
};
const reportedFailure = {
  check: "config",
  code: "invalid-config",
  message: "Doctor reported invalid configuration.",
};
type CommandOptions = Parameters<typeof processRunner.runCommandWithTimeout>[1];

function mockDoctor(run: (options: CommandOptions) => Promise<ReturnType<typeof processResult>>) {
  return vi
    .spyOn(processRunner, "runCommandWithTimeout")
    .mockImplementation(async (argv, options) => {
      expect(argv).toContain("doctor");
      return run(options);
    });
}
async function writeReceipt(
  options: CommandOptions,
  result: UpdatePostInstallDoctorResult = { status: "ok" },
) {
  const resultPath = doctorResultPath(options);
  await writeUpdatePostInstallDoctorResult({ resultPath, result });
  return resultPath;
}

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
  const doctor = (overrides: Partial<Parameters<typeof runPackageUpdateDoctor>[0]> = {}) =>
    runPackageUpdateDoctor({ root, managedServiceEnv: env, progress: {}, ...overrides });
  return { root, env, doctor };
}

function doctorResultPath(options: Parameters<typeof processRunner.runCommandWithTimeout>[1]) {
  assert(typeof options === "object");
  const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
  assert(resultPath, "Missing Doctor result path");
  return resultPath;
}

it.each([
  { requested: false, supported: false },
  { requested: false, supported: true },
  { requested: true, supported: false },
  { requested: true, supported: true },
])(
  "runs the candidate Doctor with full integrity requested=$requested supported=$supported",
  async ({ requested, supported }) => {
    const { root, doctor } = await createDoctorFixture();
    const calls = path.join(root, "doctor-calls.jsonl");
    await fs.writeFile(
      path.join(root, "dist", "entry.js"),
      `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args.includes("--help")) {
  console.log(${JSON.stringify(supported ? "  --full-integrity-check  Check all indexes" : "  --fix  Repair problems")});
} else {
  if (!${supported} && args.includes("--full-integrity-check")) process.exit(2);
  fs.writeFileSync(process.env.${UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV}, JSON.stringify({ status: "ok" }));
}
`,
    );
    const result = await doctor({
      nodeRunner: process.execPath,
      fullIntegrityCheck: requested,
      timeoutMs: 5_000,
    });
    expect(result?.exitCode).toBe(0);
    const argv = (await fs.readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(argv.filter((args) => args.includes("--help"))).toHaveLength(requested ? 1 : 0);
    expect(argv.at(-1)?.includes("--full-integrity-check")).toBe(requested && supported);
  },
);

it.each([
  { restart: false, contention: true },
  { restart: false, contention: true, wrapped: true },
  { restart: true, contention: true },
  { restart: false, contention: false },
  { restart: false, contention: false, wrapped: true },
])(
  "defers package replacement state handoff ($restart, contention=$contention, wrapped=$wrapped)",
  async ({ restart, contention, wrapped }) => {
    const { root, env, doctor } = await createDoctorFixture();
    const cause = contention
      ? new GatewayStateOwnerContentionError(resolveOpenClawStateSqlitePath(env))
      : new SqliteSchemaVersionError("This OpenClaw build cannot open your existing data.");
    const error = wrapped ? new Error("Cannot read shared state for discovery", { cause }) : cause;
    vi.spyOn(configCapture, "captureUpdateConfigSnapshot").mockRejectedValue(error);
    const spawn = vi.spyOn(processRunner, "runCommandWithTimeout");
    const onStepComplete = vi.fn();
    const results: UpdateStepResult[] = [];
    const operation = doctor({
      restart,
      results,
      progress: { onStepComplete },
      onConfigSnapshot: vi.fn(),
    });
    if (restart) {
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
      expect(isFailedUpdateStep(step)).toBe(false);
      expect(step.advisory?.message).toContain("openclaw update status");
      expect(step.advisory?.message).toContain("openclaw doctor");
      expect(results).toEqual([step]);
      expect(onStepComplete).toHaveBeenCalledWith(expect.objectContaining(step));
      const run = updateRun(env);
      const result = completeUpdateCommandRun(
        updateResult({ root, steps: results, durationMs: 0 }),
        run,
      );
      expect(result.status).toBe("ok");
      expect(getUpdateRun(run.runId, { env })?.status).toBe("succeeded");
    }
    expect(spawn).not.toHaveBeenCalled();
  },
);

it.each(["missing", "malformed", "newer-schema", "changed-during-capture"] as const)(
  "runs Doctor with %s include capture without broadening rollback ownership",
  async (includeState) => {
    const { root, env, doctor } = await createDoctorFixture();
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
      openOpenClawStateDatabase({ env });
      await closeStateDatabaseForTest();
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
    const invokeDoctor = mockDoctor(async (options) => {
      await writeReceipt(options, {
        ...(completeGraph
          ? createDeferredConfiguredPluginRepairDoctorResult(["Optional repair deferred."])
          : { status: "ok" }),
        configHash: "unchanged",
      });
      return processResult({
        code: completeGraph ? UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE : 0,
      });
    });
    const onConfigSnapshot = vi.fn();
    const onStepComplete = vi.fn();
    const stateRead = vi.spyOn(stateSnapshots, "withOpenClawStateDatabaseReadSnapshot");

    const step = await runPackagePostInstallVerification(root, (candidateRoot, results) =>
      doctor({
        root: candidateRoot,
        timeoutMs: 1_000,
        progress: { onStepComplete },
        onConfigSnapshot,
        results,
      }),
    );
    expect(isFailedUpdateStep(step), JSON.stringify(step)).toBe(false);
    expect(stateRead).not.toHaveBeenCalled();
    expect(invokeDoctor).toHaveBeenCalledOnce();
    expect(onConfigSnapshot).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        path: env.OPENCLAW_CONFIG_PATH,
        raw: originalRaw,
        doctorOwned: completeGraph,
      }),
    );
    expect(step.failureFacts ?? []).not.toContainEqual(
      expect.objectContaining({ code: "runtime-verification-failed" }),
    );
    if (completeGraph) {
      expect(step).toMatchObject({
        exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        advisory: { kind: "package-post-install-doctor" },
        warnings: [expect.stringContaining("Optional repair deferred.")],
      });
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
  const { root, doctor } = await createDoctorFixture();
  await fs.rm(path.join(root, "dist", "entry.js"));
  const spawn = vi
    .spyOn(processRunner, "runCommandWithTimeout")
    .mockRejectedValue(new Error("Doctor must not spawn without an installed entrypoint."));
  await expect(doctor({ timeoutMs: 1_000 })).resolves.toBeNull();
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
    const { root, env, doctor } = await createDoctorFixture();
    const writerReceipt = cause === "success" || cause === "advisory" || cause === "refusal";
    const advisory = cause === "advisory" || cause === "refusal";
    const reason = cause === "refusal" ? "include-ownership" : undefined;
    const outputLimitExceeded = cause === "output-limit";
    const failureFacts = [reportedFailure];
    const receipt: UpdatePostInstallDoctorResult =
      outputLimitExceeded || advisory
        ? {
            ...advisoryReceipt(outputLimitExceeded ? "Configured repair deferred." : undefined),
            ...(outputLimitExceeded ? { warnings: ["Doctor left a warning."] } : {}),
          }
        : {
            status: writerReceipt ? "ok" : "error",
            ...(cause === "reported-error" ? { failureFacts } : {}),
          };
    if (writerReceipt) {
      if (cause === "success") {
        receipt.deferredInspectionCheckIds = ["core/doctor/new-target-inspection"];
      }
      receipt.configChanges = [
        { kind: "key", key: "agents" },
        { kind: "migration", message: "Moved model allowlist." },
      ];
    }
    if (reason) {
      receipt.configWriteRefusal = refusal;
    }
    const onStepComplete = vi.fn();
    mockDoctor(async (options) => {
      const resultPath = doctorResultPath(options);
      if (writerReceipt) {
        await writeReceipt(options, receipt);
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
      return processResult({
        code: exitCode,
        stderr: outputLimitExceeded ? "Doctor output exceeded its capture limit." : "",
        ...(!writerReceipt ? { outputLimitExceeded } : {}),
      });
    });
    const run = writerReceipt ? undefined : updateRun(env);
    const steps: UpdateStepResult[] = [];
    const step = await doctor({
      timeoutMs: 1_000,
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
    expect(step.deferredInspectionCheckIds).toEqual(receipt.deferredInspectionCheckIds ?? null);
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
    const expectedAdvisory =
      advisory && !reason
        ? expect.objectContaining({ kind: "package-post-install-doctor" })
        : undefined;
    const expected = {
      exitCode,
      deferredInspectionCheckIds: receipt.deferredInspectionCheckIds ?? null,
      configChanges: receipt.configChanges,
      ...(reason
        ? { stderrTail: expect.stringContaining(`agents. ${reason}: Config writer refused.`) }
        : {}),
    };
    expect(step).toMatchObject(expected);
    expect(steps).toEqual([step]);
    expect(step.configWriteRefusal).toEqual(receipt.configWriteRefusal);
    expect(step.advisory).toEqual(expectedAdvisory);
    if (reason) {
      expect(step.failureFacts).toContainEqual(
        expect.objectContaining({ check: "config", code: reason }),
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
  const { root, env, doctor } = await createDoctorFixture();
  // Ledger receipts still need real worker scheduling and monotonic clocks.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const { runId } = createUpdateRun({ trigger: "control-ui" }, { env });
  expect(adoptUpdateRun(runId, { env }).origin.driver?.pid).toBe(process.pid);
  const spawned = createDeferredCore();
  const exited = createDeferredCore();
  const onStepComplete = vi.fn();
  const run = { runId, env };
  const guards = createUpdateCommandExecutionGuards({ run }, root);
  const progress = createUpdateRunProgress(run, { onStepComplete }, guards.recordStep);
  let doctorEnv: NodeJS.ProcessEnv | undefined;
  mockDoctor(async (options) => {
    doctorEnv = typeof options === "object" ? options.env : undefined;
    spawned.resolve();
    await exited.promise;
    await writeReceipt(options);
    return processResult();
  });
  const running = doctor({
    timeoutMs: ABANDONED_UPDATE_RUN_MS * 2,
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
  const { root, env, doctor } = await createDoctorFixture();
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
  mockDoctor(async (options) => {
    assert(typeof options === "object");
    doctorEnv = options.env;
    // Lines arrive split across pipe chunks.
    const bytes = Buffer.from(stderr);
    for (let offset = 0; offset < bytes.length; offset += 7) {
      options.onOutputChunk?.(bytes.subarray(offset, offset + 7), "stderr");
    }
    await writeReceipt(options);
    return processResult({ stderr });
  });
  const step = await doctor({
    timeoutMs: 60_000,
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
    const { doctor } = await createDoctorFixture();
    const failed = new Error(
      "Doctor process failed before returning an exit status.",
      cleanupUncertain ? { cause: new CommandProcessCleanupError() } : undefined,
    );
    const receipt: UpdatePostInstallDoctorResult | undefined =
      receiptKind === "none"
        ? undefined
        : receiptKind === "advisory"
          ? advisoryReceipt()
          : {
              status: "error",
              configWriteRefusal: refusal,
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
    mockDoctor(async (options) => {
      expect(onStepComplete).not.toHaveBeenCalled();
      resultPath = doctorResultPath(options);
      if (receipt) {
        await writeReceipt(options, receipt);
        receiptBytes = await fs.readFile(resultPath, "utf8");
      }
      throw failed;
    });
    const steps: UpdateStepResult[] = [];
    const onConfigSnapshot = vi.fn();
    const error = await doctor({
      timeoutMs: 1_000,
      progress: { onStepComplete },
      results: steps,
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
    const completion = {
      name: "openclaw doctor",
      exitCode: 1,
      configChanges: consumedReceipt?.configChanges,
      configWriteRefusal: consumedReceipt?.configWriteRefusal,
    };
    if (cleanupUncertain) {
      expect(onStepComplete).not.toHaveBeenCalled();
    } else {
      expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(completion));
    }
    const [step] = steps;
    assert(step);
    expect(steps).toMatchObject([
      {
        name: completion.name,
        exitCode: completion.exitCode,
        stderrTail: expect.stringContaining(
          consumedReceipt?.configWriteRefusal
            ? "include-ownership: Config writer refused."
            : failed.message,
        ),
        failureFacts: expect.arrayContaining([
          ...(consumedReceipt?.failureFacts ?? []),
          expect.objectContaining({
            check: "openclaw doctor",
            message: expect.stringContaining(failed.message),
          }),
        ]),
      },
    ]);
    expect(step.configChanges).toEqual(consumedReceipt?.configChanges);
    expect(step.configWriteRefusal).toEqual(consumedReceipt?.configWriteRefusal);
    expect(step.advisory).toBeUndefined();
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
  const { env, doctor } = await createDoctorFixture();
  const onStepComplete = vi.fn();
  const onConfigSnapshot = vi.fn();
  const steps: UpdateStepResult[] = [];
  mockDoctor(async (options) => {
    expect(onStepComplete).not.toHaveBeenCalled();
    await writeReceipt(options, advisoryReceipt());
    await fs.rename(env.OPENCLAW_CONFIG_PATH, `${env.OPENCLAW_CONFIG_PATH}.previous`);
    await fs.mkdir(env.OPENCLAW_CONFIG_PATH);
    return processResult({ code: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE });
  });
  const error = await doctor({
    timeoutMs: 1_000,
    progress: { onStepComplete },
    results: steps,
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
  expect(steps).toMatchObject([
    {
      name: "openclaw doctor",
      exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
    },
  ]);
  expect(steps[0]?.advisory).toBeUndefined();
  expect(steps[0]?.failureFacts).toContainEqual(expect.objectContaining({ code: "EISDIR" }));
});
