import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/io.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { removePreparedWorkerOwnershipColumns } from "../../state/openclaw-state-schema-v17.test-support.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  createChangedPostCoreUpdateOptions,
  createConfigValidationFailure,
} from "./update-cli-config.test-support.js";
import { registerFreshDoctorDiagnosticTests } from "./update-command-fresh-doctor-diagnostics.test-support.js";
import { registerFreshDoctorOutcomeTests } from "./update-command-fresh-doctor-outcomes.test-support.js";

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  resolveEntrypoint: vi.fn(),
  runExec: vi.fn(),
  runUtf8: vi.fn<typeof import("../../process/exec.js").runUtf8CommandWithTimeout>(),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfig,
}));

vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.resolveEntrypoint,
}));

vi.mock("../../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process/exec.js")>();
  return {
    ...actual,
    runExec: (...args: Parameters<typeof actual.runExec>) =>
      (args[1].includes("doctor") && args[1].includes("--repair")) ||
      (args[1].includes("config") && args[1].includes("validate"))
        ? mocks.runExec(...args)
        : actual.runExec(...args),
    runUtf8CommandWithTimeout: (...args: Parameters<typeof actual.runUtf8CommandWithTimeout>) =>
      args[0].includes("doctor") && args[0].includes("--lint")
        ? mocks.runUtf8(...args)
        : actual.runUtf8CommandWithTimeout(...args),
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), log: vi.fn() },
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveNodeRunner: vi.fn(() => "/usr/bin/node"),
}));

import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";

const updateOptions = createChangedPostCoreUpdateOptions({
  root: "/opt/openclaw",
  timeoutMs: 5_000,
});
const pluginUpdate = updateOptions.pluginUpdate;
pluginUpdate.npm = { changed: false, outcomes: [] };

const validConfigSnapshot = {
  exists: true,
  valid: true as const,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readinessExit = {
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
  outputLimitExceeded: undefined,
  stderr: "",
} as const;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("post-plugin update readiness", () => {
  beforeEach(() => {
    mocks.readConfig.mockReset().mockResolvedValue(validConfigSnapshot);
    mocks.resolveEntrypoint.mockReset().mockResolvedValue("/opt/openclaw/dist/index.js");
    mocks.runExec.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
    mocks.runUtf8.mockReset().mockResolvedValue({
      ...readinessExit,
      stdout: JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] }),
    });
  });

  it.each(["pre-plugin", "post-plugin"] as const)(
    "preserves a settled %s maintenance deferral without running convergence checks",
    async (phase) => {
      const refusal = { kind: "deferred", reason: "coordinator-contention" };
      const warning =
        "Doctor maintenance is deferred; stop other OpenClaw processes and run openclaw doctor --fix.";
      const onWarnings = vi.fn();
      mocks.runExec.mockImplementationOnce(async (_command, _args, options) => {
        await fs.writeFile(
          options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
          JSON.stringify({ status: "ok", warnings: [warning], maintenanceRefusal: refusal }),
        );
        return { stdout: "", stderr: "" };
      });
      const run =
        phase === "pre-plugin"
          ? runUpdateFinalizationDoctorInFreshProcess({ ...updateOptions, phase, onWarnings })
          : completePostCorePluginUpdate({ ...updateOptions, onWarnings });
      await expect(run).rejects.toMatchObject({ refusal, message: warning });
      expect(onWarnings).toHaveBeenCalledExactlyOnceWith([warning]);
      expect(mocks.runExec).toHaveBeenCalledOnce();
      expect(mocks.runUtf8).not.toHaveBeenCalled();
      expect(mocks.readConfig).not.toHaveBeenCalled();
    },
  );

  it.each(["active-mutation", "unreadable-state", "incomplete-migration"] as const)(
    "preserves serialized unsafe maintenance refusal %s without diagnostic facts",
    async (reason) => {
      const refusal = { kind: "data-at-risk" as const, reason };
      const childFailure = Object.assign(new Error("Doctor exited with unsafe maintenance."), {
        exitCode: 1,
      });
      mocks.runExec.mockImplementationOnce(async (_command, _args, options) => {
        await writeUpdatePostInstallDoctorResult({
          resultPath: options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
          result: { status: "error", failureFacts: [], maintenanceRefusal: refusal },
        });
        throw childFailure;
      });
      await expect(completePostCorePluginUpdate(updateOptions)).rejects.toMatchObject({
        name: "DoctorMaintenanceRefusalError",
        refusal,
        cause: childFailure,
      });
      expect(mocks.runExec).toHaveBeenCalledOnce();
      expect(mocks.readConfig).not.toHaveBeenCalled();
      expect(mocks.runUtf8).not.toHaveBeenCalled();
    },
  );

  it("keeps a fresh Doctor requester refusal terminal when later checks would pass", async () => {
    const isCurrent = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const opts: UpdateCommandOptions = {
      run: {
        runId: "live-run",
        env: {},
        executorFence: { assertCurrent: vi.fn() },
        requesterAuthority: { requester: {}, isCurrent },
      },
    };
    await expect(completePostCorePluginUpdate({ ...updateOptions, opts })).rejects.toThrow(
      "requester-revoked",
    );
    expect(isCurrent).toHaveBeenCalledTimes(1);
    expect(mocks.runExec).not.toHaveBeenCalled();
  });

  it.each(["", "  "])(
    "never downgrades a present run with invalid id %j to legacy Doctor",
    async (runId) => {
      const opts: UpdateCommandOptions = {
        run: { runId, env: {}, executorFence: { assertCurrent: vi.fn() } },
      };
      await expect(
        runUpdateFinalizationDoctorInFreshProcess({ ...updateOptions, opts, phase: "post-plugin" }),
      ).rejects.toThrow("original update executor");
      expect(mocks.runExec).not.toHaveBeenCalled();
    },
  );

  it.each([
    { phase: "pre-plugin", operatorPolicy: "external" },
    { phase: "post-plugin", operatorPolicy: "external" },
    { phase: "pre-plugin", operatorPolicy: undefined },
    { phase: "post-plugin", operatorPolicy: undefined },
  ] as const)(
    "keeps service authority with the parent in the $phase child (operator policy: $operatorPolicy)",
    async ({ phase, operatorPolicy }) => {
      vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", operatorPolicy);
      const { runExec } =
        await vi.importActual<typeof import("../../process/exec.js")>("../../process/exec.js");
      mocks.runExec.mockImplementationOnce(async (_command, _args, options) => {
        const result = await runExec(
          process.execPath,
          [
            "-e",
            "process.stdout.write(JSON.stringify({ policy: process.env.OPENCLAW_SERVICE_REPAIR_POLICY, repair: process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR, activation: process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION }))",
          ],
          options,
        );
        expect(JSON.parse(result.stdout)).toEqual({
          policy: "external",
          repair: "0",
          activation: "0",
        });
        return result;
      });

      await runUpdateFinalizationDoctorInFreshProcess({
        ...updateOptions,
        phase,
        root: tempDirs.make("fresh-doctor-policy-"),
      });
    },
  );

  it.each([
    { phase: "pre-plugin", timeout: undefined, expected: undefined },
    { phase: "post-plugin", timeout: undefined, expected: undefined },
    { phase: "pre-plugin", timeout: "3", expected: 3_000 },
    { phase: "post-plugin", timeout: "3", expected: 3_000 },
  ] as const)(
    "uses the operator deadline for $phase Doctor ($timeout)",
    async ({ phase, timeout, expected }) => {
      await runUpdateFinalizationDoctorInFreshProcess({
        ...updateOptions,
        phase,
        opts: { timeout },
      });
      expect(mocks.runExec).toHaveBeenCalledExactlyOnceWith(
        "/usr/bin/node",
        expect.arrayContaining(["doctor", "--repair"]),
        expect.objectContaining({ timeoutMs: expected }),
      );
    },
  );

  it.each([undefined, 5_000])("propagates the primary Doctor timeout %s", async (timeoutMs) => {
    await runUpdateFinalizationDoctorInFreshProcess({
      ...updateOptions,
      phase: "pre-plugin",
      timeoutMs,
    });
    expect(mocks.runExec).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/node",
      expect.arrayContaining(["doctor", "--repair"]),
      expect.objectContaining({ timeoutMs }),
    );
  });

  it.each([undefined, 5_000])(
    "bounds post-plugin checks separately from Doctor (%s)",
    async (timeoutMs) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("post-plugin-empty-budget-"));
      await completePostCorePluginUpdate({
        ...updateOptions,
        timeoutMs,
      });

      expect(mocks.runExec.mock.calls.map(([, args]) => args)).toEqual([
        [
          "/opt/openclaw/dist/index.js",
          "doctor",
          "--repair",
          "--non-interactive",
          "--no-workspace-suggestions",
          "--yes",
        ],
        ["/opt/openclaw/dist/index.js", "config", "validate", "--json"],
      ]);
      expect(mocks.runUtf8).toHaveBeenCalledExactlyOnceWith(
        [
          "/usr/bin/node",
          "/opt/openclaw/dist/index.js",
          "doctor",
          "--lint",
          "--json",
          "--severity-min",
          "error",
        ],
        expect.objectContaining({
          timeoutMs: timeoutMs ?? 300_000,
          input: "",
          maxOutputBytes: 4 * 1024 * 1024,
          outputCapture: "head",
          terminateOnOutputLimit: true,
          env: { OPENCLAW_UPDATE_IN_PROGRESS: "1", OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
        }),
      );
      expect(mocks.runExec.mock.calls.map((call) => call[2].timeoutMs)).toEqual([
        timeoutMs,
        timeoutMs ?? 300_000,
      ]);
    },
  );

  it.each([
    { name: "shared", shared: true, agent: false, budget: 2_860_000 },
    { name: "main agent", shared: false, agent: true, budget: 2_860_000 },
    { name: "shared and main agent", shared: true, agent: true, budget: 3_160_000 },
  ])("measures migrated $name database families for both post-plugin checks", async (testCase) => {
    const stateDir = tempDirs.make("post-plugin-budget-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const databases = [
      ...(testCase.shared ? [resolveOpenClawStateSqlitePath(process.env)] : []),
      ...(testCase.agent
        ? [path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")]
        : []),
    ];
    const bytes = 1024 ** 3 / databases.length;
    for (const databasePath of databases) {
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      for (const file of [databasePath, `${databasePath}-wal`]) {
        await fs.writeFile(file, "");
      }
      await fs.truncate(databasePath, bytes);
    }
    mocks.runExec.mockImplementationOnce(async () => {
      for (const databasePath of databases) {
        await fs.truncate(`${databasePath}-wal`, bytes);
      }
      return { stdout: "", stderr: "" };
    });
    const result = await completePostCorePluginUpdate({ ...updateOptions, timeoutMs: undefined });
    expect(result.pluginUpdate.status).toBe("ok");
    expect(mocks.runExec.mock.calls.map((call) => call[2].timeoutMs)).toEqual([
      undefined,
      testCase.budget,
    ]);
    expect(mocks.runUtf8.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: testCase.budget });
  });

  it("budgets configured agent stores without enumerating unrelated agent directories", async () => {
    const stateDir = tempDirs.make("post-plugin-configured-budget-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const agentsDir = path.join(stateDir, "agents");
    const databasePath = path.join(agentsDir, "configured", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "");
    await fs.truncate(databasePath, 2 * 1024 ** 3);
    mocks.readConfig.mockResolvedValue({
      ...validConfigSnapshot,
      sourceConfig: { agents: { entries: { configured: {} } } },
    });
    const readdir = fs.readdir;
    const enumeration = vi.spyOn(fs, "readdir").mockImplementation((...args) => {
      if (args[0] === agentsDir) {
        return Promise.reject(
          Object.assign(new Error("agent enumeration denied"), { code: "EACCES" }),
        );
      }
      return readdir(...args);
    });
    try {
      const result = await completePostCorePluginUpdate({
        ...updateOptions,
        freshDoctorRequired: false,
        timeoutMs: undefined,
      });
      expect(result.pluginUpdate.status).toBe("ok");
      expect(mocks.runExec.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 2_860_000 });
      expect(mocks.runUtf8.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 2_860_000 });
      expect(enumeration).not.toHaveBeenCalledWith(agentsDir, { withFileTypes: true });
    } finally {
      enumeration.mockRestore();
    }
  });

  it("runs updated readiness checks even when no plugin package changed", async () => {
    const beforeDoctor = vi.fn(async () => undefined);
    await completePostCorePluginUpdate({
      ...updateOptions,
      pluginUpdate: { ...pluginUpdate, changed: false },
      freshDoctorRequired: false,
      beforeDoctor,
    });

    expect(beforeDoctor).not.toHaveBeenCalled();
    expect(mocks.runExec.mock.calls.map(([, args]) => args)).toEqual([
      ["/opt/openclaw/dist/index.js", "config", "validate", "--json"],
    ]);
    expect(mocks.runUtf8).toHaveBeenCalledOnce();
  });

  it("runs recorded deferred retirement when the published driver flag is false", async () => {
    await withTempHome(async () => {
      const run = createUpdateRun({ trigger: "cli" });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      recordUpdateRunStep(run.runId, {
        step: "finalize:doctor:model-retirement",
        status: "skipped",
        detail: "Model retirement repair deferred until plugin convergence.",
      });
      const beforeDoctor = vi.fn(async () => undefined);

      await completePostCorePluginUpdate({
        ...updateOptions,
        pluginUpdate: { ...pluginUpdate, changed: false },
        freshDoctorRequired: false,
        beforeDoctor,
      });

      expect(beforeDoctor).toHaveBeenCalledOnce();
      expect(mocks.runExec.mock.calls[0]?.[1]).toEqual([
        "/opt/openclaw/dist/index.js",
        "doctor",
        "--repair",
        "--non-interactive",
        "--no-workspace-suggestions",
        "--yes",
      ]);
      expect(mocks.runExec.mock.calls[0]?.[2]).toMatchObject({
        env: { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
      });
    });
  });

  it.each([false, true])(
    "preserves an unconfigured install through finalization (Doctor: %s)",
    async (freshDoctorRequired) => {
      await withTempHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const io = createConfigIO({ configPath, observe: false });
        mocks.readConfig.mockImplementation(() => io.readConfigFileSnapshot());
        const runNormally = mocks.runExec.getMockImplementation()!;
        mocks.runExec.mockImplementation(async (command, args: string[], options) => {
          if (args.includes("validate")) {
            throw new Error("Config file not found");
          }
          return await runNormally(command, args, options);
        });

        const result = await completePostCorePluginUpdate({
          ...updateOptions,
          freshDoctorRequired,
        });

        expect(result.pluginUpdate.status).toBe("ok");
        expect(result.configSnapshot).toMatchObject({ exists: false, valid: true });
        expect(mocks.runUtf8).toHaveBeenCalledOnce();
        await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("validates a config created during fresh Doctor before allowing restart", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const io = createConfigIO({ configPath, observe: false });
      mocks.readConfig.mockImplementation(() => io.readConfigFileSnapshot());
      mocks.runExec.mockImplementation(async (_command, args: string[]) => {
        if (args.includes("--repair")) {
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          await fs.writeFile(configPath, '{"gateway":{"mode":"invalid"}}');
        }
        if (args.includes("validate")) {
          throw createConfigValidationFailure(
            [{ path: "gateway.mode", message: "Invalid gateway mode" }],
            "Config invalid",
          );
        }
        return { stdout: "", stderr: "" };
      });

      const result = await completePostCorePluginUpdate(updateOptions);

      expect(result.configSnapshot).toMatchObject({ exists: true, valid: false });
      expect(result.pluginUpdate).toMatchObject({
        status: "error",
        reason: "post-plugin-doctor-invalid-config",
        failureFacts: [
          {
            check: "config",
            code: "candidate-config-failed",
            affectedKey: "gateway.mode",
            message: "Invalid gateway mode",
          },
        ],
      });
    });
  });

  it.each([
    {
      name: "runtime exception",
      stdout: JSON.stringify({ valid: false, error: "Runtime failed" }),
    },
    { name: "missing output", stdout: "" },
    { name: "malformed output", stdout: "not JSON" },
    { name: "launch", code: "ENOENT", exitCode: undefined, stdout: "" },
    { name: "timeout", timedOut: true },
    { name: "cancellation", isCanceled: true },
    { name: "signal", signal: "SIGTERM", isTerminated: true },
    { name: "output limit", isMaxBuffer: true },
    { name: "capture failure", cause: new Error("capture failed") },
    { name: "unsettled cleanup", cleanup: "uncertain" },
    { name: "nested cleanup", cause: new CommandProcessCleanupError() },
  ])("retains a config validation $name as an execution failure", async (failure) => {
    const { cause, ...metadata } = failure;
    mocks.runExec.mockRejectedValueOnce(
      Object.assign(new Error("private argv must not be copied", { cause }), {
        failed: true,
        exitCode: 1,
        stdout: JSON.stringify({ valid: false, issues: [{ message: "Unconfirmed issue" }] }),
        ...metadata,
      }),
    );
    vi.mocked(defaultRuntime.log).mockClear();
    vi.mocked(defaultRuntime.error).mockClear();

    const { pluginUpdate: result } = await completePostCorePluginUpdate({
      ...updateOptions,
      freshDoctorRequired: false,
    });

    expect(result).toMatchObject({
      status: "error",
      reason: "post-plugin-config-validation-execution-failed",
      warnings: [
        expect.objectContaining({
          message: "Config validation could not complete; refusing to restart.",
        }),
      ],
      failureFacts: [
        expect.objectContaining({ code: "post-plugin-config-validation-execution-failed" }),
        ...(failure.stdout === "" || failure.name === "launch"
          ? []
          : [expect.objectContaining({ code: "command-failed" })]),
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private argv");
    expect(JSON.stringify(result)).not.toContain("doctor --fix");
    expect(mocks.runUtf8).not.toHaveBeenCalled();
    expect(defaultRuntime.log).not.toHaveBeenCalled();
    expect(defaultRuntime.error).not.toHaveBeenCalled();
  });

  it("preserves a missing target entrypoint failure despite an invalid parent snapshot", async () => {
    mocks.resolveEntrypoint.mockResolvedValue(undefined);
    mocks.readConfig.mockResolvedValue({ ...validConfigSnapshot, valid: false });
    const { pluginUpdate: result } = await completePostCorePluginUpdate(updateOptions);
    expect(result).toMatchObject({
      status: "error",
      reason: "post-plugin-doctor-execution-failed",
      warnings: [
        expect.objectContaining({ reason: expect.stringContaining("entrypoint not found") }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain("invalid-config");
    expect(mocks.runExec).not.toHaveBeenCalled();
    expect(mocks.runUtf8).not.toHaveBeenCalled();
  });

  registerFreshDoctorOutcomeTests(mocks, updateOptions);

  registerFreshDoctorDiagnosticTests({ mocks, tempDirs, updateOptions });

  it("consumes nonfatal Doctor warnings before reporting successful convergence", async () => {
    const warnings = ["Optional probe timed out; recheck after restart."];
    const onWarnings = vi.fn();
    let resultPath = "";
    const runNormally = mocks.runExec.getMockImplementation()!;
    mocks.runExec.mockImplementation(async (command, args: string[], options) => {
      if (args.includes("--repair")) {
        resultPath = options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
        await writeUpdatePostInstallDoctorResult({
          resultPath,
          result: { status: "ok", warnings },
        });
      }
      return await runNormally(command, args, options);
    });

    const result = await completePostCorePluginUpdate({ ...updateOptions, onWarnings });

    expect(result.pluginUpdate.status).toBe("ok");
    expect(onWarnings).toHaveBeenCalledExactlyOnceWith(warnings);
    expect(await consumeUpdatePostInstallDoctorResult(resultPath)).toBeNull();
  });

  it.each([
    { timedOut: false, captureFailed: false },
    { timedOut: true, captureFailed: false },
    { timedOut: false, captureFailed: true },
  ])(
    "preserves deferred repair advisory semantics (timed out: $timedOut, capture failed: $captureFailed)",
    async ({ timedOut, captureFailed }) => {
      mocks.runExec.mockImplementation(async (_command, _args, options) => {
        await writeUpdatePostInstallDoctorResult({
          resultPath: options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
          result: createDeferredConfiguredPluginRepairDoctorResult(["plugin repair deferred"]),
        });
        throw Object.assign(
          new Error("Doctor advisory", {
            cause: captureFailed ? new Error("output capture failed") : undefined,
          }),
          { failed: true, exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE, timedOut },
        );
      });
      const run = runUpdateFinalizationDoctorInFreshProcess({
        ...updateOptions,
        phase: "pre-plugin",
      });
      if (timedOut || captureFailed) {
        await expect(run).rejects.toThrow("Doctor advisory");
      } else {
        await expect(run).resolves.toBeUndefined();
      }
    },
  );

  it("carries the Doctor's failing check through fresh-process convergence", async () => {
    const failureFacts = [
      {
        check: "state.session-participants",
        code: "step-refused",
        message: "Required session migration could not acquire its writer.",
      },
    ];
    const runNormally = mocks.runExec.getMockImplementation()!;
    mocks.runExec.mockImplementation(async (command, args: string[], options) => {
      if (!args.includes("--repair")) {
        return await runNormally(command, args, options);
      }
      await writeUpdatePostInstallDoctorResult({
        resultPath: options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
        result: { status: "error", failureFacts },
      });
      throw Object.assign(new Error("Doctor exited"), {
        exitCode: 23,
        stderr: "Last cleanup message",
      });
    });
    await expect(
      runUpdateFinalizationDoctorInFreshProcess({
        ...updateOptions,
        phase: "pre-plugin",
      }),
    ).rejects.toMatchObject({ failureFacts, exitCode: 23 });
    const result = await completePostCorePluginUpdate(updateOptions);
    expect(result.pluginUpdate).toMatchObject({ status: "error", failureFacts });
  });

  it("requires the lifecycle owner before starting fresh Doctor maintenance", async () => {
    const beforeDoctor = vi.fn(async () => undefined);
    await completePostCorePluginUpdate({
      ...updateOptions,
      beforeDoctor,
    });
    expect(beforeDoctor).toHaveBeenCalledOnce();
    expect(beforeDoctor.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runExec.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("uses target validation when the unchanged-plugin parent retains an older schema", async () => {
    mocks.readConfig.mockResolvedValue({ ...validConfigSnapshot, valid: false });
    const result = await completePostCorePluginUpdate({
      ...updateOptions,
      pluginUpdate: { ...pluginUpdate, changed: false },
      freshDoctorRequired: false,
    });
    expect(result.pluginUpdate.status).toBe("ok");
    expect(result.configSnapshot.valid).toBe(false);
    expect(mocks.runExec.mock.calls.map(([, args]) => args)).toEqual([
      ["/opt/openclaw/dist/index.js", "config", "validate", "--json"],
    ]);
    expect(mocks.runUtf8).toHaveBeenCalledOnce();
  });

  it("keeps expected post-update version skew quiet while normal reads still warn", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ meta: { lastTouchedVersion: "9999.1.0" }, gateway: { mode: "local" } }),
      );
      const configOwner =
        await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
      mocks.readConfig.mockImplementation(configOwner.readConfigFileSnapshot);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await completePostCorePluginUpdate({
          ...updateOptions,
          freshDoctorRequired: false,
        });
        expect(result.pluginUpdate.status).toBe("ok");
        expect(warning).not.toHaveBeenCalledWith(
          expect.stringContaining("config was written by version 9999.1.0"),
        );

        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "0");
        await configOwner.readConfigFileSnapshot({ observe: false });
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining("config was written by version 9999.1.0"),
        );
      } finally {
        warning.mockRestore();
      }
    });
  });

  it("preserves the older target database when reading post-update config context", async () => {
    const stateDir = tempDirs.make("openclaw-post-update-target-schema-");
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local" } }));
    const filename = openOpenClawStateDatabase({ env: process.env }).path;
    closeOpenClawStateDatabaseForTest();
    const db = new DatabaseSync(filename);
    try {
      removePreparedWorkerOwnershipColumns(db);
      db.exec(
        "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16, app_version='2026.9.2'",
      );
      const beforeSchema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
      const beforeMeta = db.prepare("SELECT * FROM schema_meta").all();
      const configOwner =
        await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
      mocks.readConfig.mockImplementation(configOwner.readConfigFileSnapshot);

      const result = await completePostCorePluginUpdate({
        ...updateOptions,
        pluginUpdate: { ...pluginUpdate, changed: false },
        freshDoctorRequired: false,
      });

      expect(result.pluginUpdate.status).toBe("ok");
      expect(result.configSnapshot.config.gateway?.mode).toBe("local");
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 16 });
      expect(db.prepare("SELECT * FROM schema_meta").all()).toEqual(beforeMeta);
      expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(beforeSchema);
    } finally {
      db.close();
    }
  });

  it("does not start Doctor when the lifecycle owner refuses maintenance", async () => {
    const beforeDoctor = vi.fn(async () => {
      throw new Error("Gateway owner changed");
    });
    const result = await completePostCorePluginUpdate({
      ...updateOptions,
      beforeDoctor,
    });
    expect(beforeDoctor).toHaveBeenCalledOnce();
    expect(mocks.runExec.mock.calls.some(([, args]) => args.includes("--repair"))).toBe(false);
    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      warnings: [
        expect.objectContaining({ reason: expect.stringContaining("Gateway owner changed") }),
      ],
    });
  });

  it.each([true, false])("preserves readiness failures (config exists: %s)", async (exists) => {
    mocks.readConfig.mockResolvedValue({ ...validConfigSnapshot, exists });
    mocks.runUtf8.mockResolvedValue({
      ...readinessExit,
      code: 1,
      stdout: `${JSON.stringify({
        ok: false,
        checksRun: 1,
        checksSkipped: 0,
        findings: [
          {
            checkId: "memory-core/managed-local-embedding-setup",
            severity: "error",
            source: "memory-core",
            message: "Managed local embeddings are unavailable.",
            fixHint:
              "Run `openclaw models --agent main auth login --provider llama-cpp --method local`.",
          },
        ],
      })}\n`,
    });

    const result = await completePostCorePluginUpdate(updateOptions);

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-update-readiness-failed",
      warnings: [
        {
          pluginId: "memory-core",
          reason: "memory-core/managed-local-embedding-setup",
          message: "Managed local embeddings are unavailable.",
          guidance: [
            "Run `openclaw models --agent main auth login --provider llama-cpp --method local`.",
          ],
        },
      ],
    });
  });

  it.each([
    {
      checkId: "core/doctor/security",
      message: "Open group policy permits mention-gated requests.",
      fixHint: "Review the group allowlist.",
    },
    {
      checkId: "core/doctor/lint-state-inspection",
      message: "Temporary doctor lint state snapshot cleanup did not complete.",
      fixHint: "Rerun doctor after the update.",
    },
  ])(
    "retains $checkId warnings while accepting post-plugin readiness",
    async ({ checkId, message, fixHint }) => {
      mocks.runUtf8.mockResolvedValue({
        ...readinessExit,
        stdout: JSON.stringify({
          ok: true,
          checksRun: 1,
          findings: [],
          warnings: [
            {
              checkId,
              severity: "warning",
              message,
              fixHint,
            },
          ],
        }),
      });
      const result = await completePostCorePluginUpdate(updateOptions);
      expect(result.pluginUpdate).toMatchObject({
        status: "warning",
        doctorLint: { exitCode: 0, termination: "exit", signal: null, killed: false },
        warnings: [
          {
            reason: "doctor-advisory",
            message,
            guidance: [fixHint],
          },
        ],
      });
    },
  );

  it.each([
    {
      label: "malformed output",
      stdout: "{not-json\n",
    },
    {
      label: "no declared check",
      stdout: `${JSON.stringify({ ok: true, checksRun: 0, checksSkipped: 0, findings: [] })}\n`,
    },
  ])("fails closed on $label from the updated readiness child", async ({ stdout }) => {
    mocks.runUtf8.mockResolvedValue({ ...readinessExit, stdout });

    const result = await completePostCorePluginUpdate(updateOptions);

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-update-readiness-execution-failed",
      warnings: [
        expect.objectContaining({
          message: "Updated plugin readiness checks could not be completed before restart.",
        }),
      ],
    });
  });

  it.each([
    { name: "policy exit", physical: { code: 1 }, accepted: true },
    { name: "other exit", physical: { code: 2 }, accepted: false },
    {
      name: "signal",
      physical: { code: null, termination: "signal", signal: "SIGTERM", killed: true },
      accepted: false,
    },
    {
      name: "timeout",
      physical: { code: 124, termination: "timeout", signal: "SIGTERM", killed: true },
      accepted: false,
    },
    {
      name: "overflow",
      physical: {
        code: 1,
        termination: "signal",
        signal: "SIGTERM",
        killed: true,
        outputLimitExceeded: true,
      },
      accepted: false,
    },
  ] as const)(
    "retains physical $name facts without accepting interrupted policy output",
    async ({ physical, accepted }) => {
      const finding = {
        checkId: "core/doctor/security",
        severity: "error",
        message: "Discord DMs are open.",
      };
      const execution = {
        ...readinessExit,
        ...physical,
        stdout: JSON.stringify({ ok: false, checksRun: 1, findings: [finding] }),
        stderr: "Readiness diagnostic",
      };
      mocks.runUtf8.mockResolvedValue(execution);

      const { pluginUpdate: result } = await completePostCorePluginUpdate(updateOptions);

      expect(result.status).toBe(accepted ? "warning" : "error");
      expect(result.doctorLint).toMatchObject({
        exitCode: execution.code,
        termination: execution.termination,
        signal: execution.signal,
        killed: execution.killed,
        outputLimitExceeded: execution.outputLimitExceeded,
        stderrTail: execution.stderr,
        doctorLintFindings: [{ ...finding, severity: "warning" }],
      });
      expect(result.doctorLint?.advisory?.kind).toBe(
        accepted ? "recoverable-maintenance" : undefined,
      );
    },
  );

  it("retains a readiness launch failure without inventing an exit code", async () => {
    mocks.runUtf8.mockRejectedValue(new Error("Readiness executable unavailable"));

    const { pluginUpdate: result } = await completePostCorePluginUpdate(updateOptions);

    expect(result).toMatchObject({
      status: "error",
      reason: "post-plugin-update-readiness-execution-failed",
      doctorLint: { exitCode: null },
      warnings: [expect.objectContaining({ reason: "Error: Readiness executable unavailable" })],
    });
  });

  it.each(["", "{unfinished"])(
    "preserves a failed readiness child's diagnostic when stdout is %j",
    async (stdout) => {
      mocks.runUtf8.mockResolvedValue({
        ...readinessExit,
        code: 2,
        stdout,
        stderr:
          "Earlier diagnostic line\n".repeat(100) +
          "Could not load readiness plugin https://example.test/diagnostic?token=fixture-secret",
      });

      const result = await completePostCorePluginUpdate(updateOptions);

      expect(result.pluginUpdate).toMatchObject({
        status: "error",
        reason: "post-plugin-update-readiness-execution-failed",
      });
      const reason = result.pluginUpdate.warnings?.[0]?.reason;
      expect(reason).toContain("code=2");
      expect(reason).toContain("stderr:");
      expect(reason).toContain("Could not load readiness plugin");
      expect(reason).toContain("token=<redacted>");
      expect(reason).not.toContain("fixture-secret");
      expect(reason).not.toContain("/opt/openclaw/dist/index.js");
      expect(reason?.length).toBeLessThan(600);
      expect(result.pluginUpdate.doctorLint?.stderrTail).toContain("token=<redacted>");
      expect(result.pluginUpdate.doctorLint?.stderrTail).not.toContain("fixture-secret");
    },
  );

  it("returns readiness facts without publishing update history, output, or reports", async () => {
    await withTempHome(async (home) => {
      const run = createUpdateRun({ trigger: "cli" });
      adoptUpdateRun(run.runId);
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      const before = getUpdateRun(run.runId);
      vi.mocked(defaultRuntime.log).mockClear();
      vi.mocked(defaultRuntime.error).mockClear();

      const result = await completePostCorePluginUpdate({
        ...updateOptions,
        runId: run.runId,
        freshDoctorRequired: false,
      });

      expect(result.pluginUpdate.status).toBe("ok");
      expect(result.pluginUpdate.doctorLint).toMatchObject({ exitCode: 0, termination: "exit" });
      expect(getUpdateRun(run.runId)).toEqual(before);
      expect(defaultRuntime.log).not.toHaveBeenCalled();
      expect(defaultRuntime.error).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(home, ".openclaw", "update-reports"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
