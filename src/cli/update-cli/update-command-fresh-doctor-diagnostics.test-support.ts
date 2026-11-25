import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readTriageUpdateFailure } from "../../commands/triage-update.js";
import { readReleasedTriageUpdateFailure } from "../../commands/triage-update.released-reader.test-support.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "../../infra/update-doctor-result.js";
import { writeTriageUpdateFailure } from "../../infra/update-failure-report-artifact.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import type { CommandOptions } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";
import { UpdateFinalizationOutput } from "./update-finalization-output.js";

export function registerFreshDoctorDiagnosticTests({
  mocks,
  tempDirs,
  updateOptions,
}: {
  mocks: {
    resolveEntrypoint: Mock;
    command: Mock;
    runUtf8: Mock<typeof import("../../process/exec.js").runUtf8CommandWithTimeout>;
  };
  tempDirs: ReturnType<typeof useAutoCleanupTempDirTracker>;
  updateOptions: Parameters<typeof completePostCorePluginUpdate>[0];
}): void {
  it.for(["pre-plugin", "post-plugin"] as const)(
    "shows %s Doctor phases before settlement without losing captured diagnostics",
    async (phase, { signal }) => {
      setLoggerOverride({ consoleLevel: "info", consoleStyle: "compact" });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const ready = createDeferred();
      const release = createDeferred();
      const output = new UpdateFinalizationOutput();
      const onDoctorStep = vi.fn();
      const captured = {
        stdout: "Captured Doctor stdout\n",
        stderr: "Doctor: private fixture label\nDoctor: state schema\n",
      };
      mocks.command.mockImplementationOnce(async (_command, _args, options: CommandOptions) => {
        options.onOutputChunk?.(Buffer.from(captured.stdout), "stdout");
        options.onOutputChunk?.(Buffer.from(captured.stderr), "stderr");
        ready.resolve();
        await release.promise;
        await fs.writeFile(
          options.env![UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]!,
          JSON.stringify({ status: "ok" }),
        );
        return captured;
      });
      const work = output.run(() =>
        runUpdateFinalizationDoctorInFreshProcess({
          ...updateOptions,
          phase,
          root: tempDirs.make("fresh-doctor-progress-"),
          timeoutMs: undefined,
          json: true,
          onDoctorStep,
        }),
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(ready.promise, work, "Doctor settled before its phase"),
          signal,
        );
        expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toEqual([
          "Doctor: state schema\n",
        ]);
        expect(stdout).not.toHaveBeenCalled();
        expect(defaultRuntime.error).not.toHaveBeenCalled();
        expect(defaultRuntime.log).not.toHaveBeenCalled();
        expect(onDoctorStep).not.toHaveBeenCalled();
        expect(output.snapshot()).toMatchObject({
          phase,
          stdout: { excerpt: captured.stdout },
          stderr: { excerpt: captured.stderr },
        });
        release.resolve();
        await withinTest(work, signal);
        expect(onDoctorStep).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ name: `${phase} doctor`, exitCode: 0 }),
        );
        // Terminal replay retains both diagnostic streams, including the live phase.
        expect(vi.mocked(defaultRuntime.error).mock.calls).toEqual([
          [captured.stdout.trimEnd()],
          [captured.stderr.trimEnd()],
        ]);
        expect(defaultRuntime.log).not.toHaveBeenCalled();
        expect(stdout).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await work.catch(() => {});
        output.close();
        stderr.mockRestore();
        stdout.mockRestore();
        resetLogger();
      }
    },
  );

  it.each(["info", "warning", "error"] as const)(
    "retains inline fallback %s findings without suppressing readiness errors",
    async (severity) => {
      vi.stubEnv("OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS", "reported-checks");
      mocks.command.mockImplementationOnce(async (_command, _args, options: CommandOptions) => {
        await fs.writeFile(
          options.env![UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]!,
          JSON.stringify({ status: "ok" }),
        );
        return { stdout: "", stderr: "" };
      });
      const finding = {
        checkId: "core/doctor/command-owner",
        severity,
        message: "Fixture inspection finding",
      };
      mocks.runUtf8.mockResolvedValueOnce({
        code: 1,
        signal: null,
        killed: false,
        termination: "exit",
        stdout: JSON.stringify({ ok: false, checksRun: 1, findings: [finding] }),
        stderr: "",
      });
      const { pluginUpdate } = await completePostCorePluginUpdate(updateOptions);
      expect(mocks.runUtf8).toHaveBeenCalledWith(
        expect.arrayContaining(["--all", "--severity-min", "info"]),
        expect.any(Object),
      );
      expect(pluginUpdate.status).toBe(
        severity === "error" ? "error" : severity === "warning" ? "warning" : "ok",
      );
      expect(pluginUpdate.doctorLint?.doctorLintFindings).toEqual([finding]);
      expect(pluginUpdate.doctorLint?.deferredInspectionCheckIds).toEqual(
        severity === "error" ? undefined : [],
      );
    },
  );

  it.each([
    { label: "missing receipt", selectors: undefined, deferred: true, changed: true, all: true },
    { label: "invalid receipt", selectors: [" "], deferred: true, changed: true, all: true },
    { label: "empty receipt", selectors: [], deferred: true, changed: true, all: false },
    {
      label: "selected receipt",
      selectors: ["core/doctor/hooks-model"],
      deferred: true,
      changed: true,
      all: false,
    },
    { label: "inline Doctor", selectors: undefined, deferred: false, changed: true, all: false },
    { label: "no fresh Doctor", selectors: undefined, deferred: true, changed: false, all: false },
  ])(
    "falls back to inline inspection only for an unusable deferred $label",
    async ({ selectors, deferred, changed, all }) => {
      vi.stubEnv(
        "OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS",
        deferred ? "reported-checks" : "0",
      );
      if (changed) {
        mocks.command.mockImplementationOnce(async (_command, _args, options: CommandOptions) => {
          await fs.writeFile(
            options.env![UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]!,
            JSON.stringify({ status: "ok", deferredInspectionCheckIds: selectors }),
          );
          return { stdout: "", stderr: "" };
        });
      }
      const result = await completePostCorePluginUpdate({
        ...updateOptions,
        pluginUpdate: { ...updateOptions.pluginUpdate, changed },
      });
      expect(result.pluginUpdate.status).toBe("ok");
      expect(result.pluginUpdate.doctorLint?.deferredInspectionCheckIds).toEqual(
        all ? [] : undefined,
      );
      expect(mocks.runUtf8).toHaveBeenCalledExactlyOnceWith(
        all ? expect.arrayContaining(["--all"]) : expect.not.arrayContaining(["--all"]),
        expect.objectContaining({
          env: expect.objectContaining({
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
          }),
        }),
      );
    },
  );

  it("records an untraced Doctor once with explicitly unknown deferred selectors", async () => {
    mocks.command.mockResolvedValueOnce({ stdout: "", stderr: "" });
    const onDoctorStep = vi.fn();
    await runUpdateFinalizationDoctorInFreshProcess({
      ...updateOptions,
      phase: "pre-plugin",
      root: tempDirs.make("fresh-doctor-untraced-"),
      onDoctorStep,
    });
    expect(onDoctorStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "pre-plugin doctor",
        exitCode: 0,
        deferredInspectionCheckIds: null,
      }),
    );
    expect(onDoctorStep.mock.calls[0]?.[0].diagnostics).toBeUndefined();
  });

  it("captures an explicitly reported missing-module failure after long warnings for current and released readers", async () => {
    const root = tempDirs.make("post-plugin-validation-command-");
    const stateDir = path.join(root, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const secret = "sk-test-validation-secret-1234567890";
    const script = path.join(root, "validator.mjs");
    await fs.writeFile(
      script,
      `import assert from 'node:assert/strict';
       assert.deepEqual(process.argv.slice(2), ['config', 'validate', '--json']);
       process.stderr.write(${JSON.stringify(`Loading validator token=${secret} ${"context ".repeat(100)}\n`)});
       process.stdout.write(JSON.stringify({valid: false, error: 'Runtime failed'}));
       await assert.rejects(import('./missing-validator.mjs'), (error) => {
         assert.ok(error instanceof Error);
         assert.match(error.message, /(?:Cannot find|Module not found)/i);
         assert.ok(error.message.includes('missing-validator.mjs'));
         console.error(error);
         return true;
       });
       // The validator owns its public diagnostic, independently of the runtime's printer.
       process.stderr.write('Error [ERR_MODULE_NOT_FOUND]: missing validator module\\n');
       process.exitCode = 1;`,
    );
    mocks.resolveEntrypoint.mockResolvedValue(script);
    const { runExec } =
      await vi.importActual<typeof import("../../process/exec.js")>("../../process/exec.js");
    mocks.command.mockImplementation(runExec);
    const { pluginUpdate: result } = await completePostCorePluginUpdate({
      ...updateOptions,
      root,
      nodeRunner: process.execPath,
      pluginUpdate: { ...updateOptions.pluginUpdate, changed: false },
    });
    expect(result.reason).toBe("post-plugin-config-validation-execution-failed");
    expect(result.failureFacts).toHaveLength(3);
    expect(result.failureFacts?.[0]?.message).toContain("code 1");
    expect(result.failureFacts?.[1]?.message).toBe("stderr: ERR_MODULE_NOT_FOUND");
    expect(result.failureFacts?.every((fact) => (fact.message?.length ?? 0) <= 200)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(root);
    const updateResult: UpdateRunResult = {
      status: "error",
      mode: "npm",
      durationMs: 0,
      reason: "post-update-plugins",
      postUpdate: { plugins: result },
      steps: [
        {
          name: "plugin-convergence",
          command: "config validate --json",
          cwd: root,
          durationMs: 0,
          exitCode: 1,
          failureFacts: result.failureFacts,
        },
      ],
    };
    const report = renderUpdateRunReport(updateRunReportInputFromResult(updateResult));
    const publicReport = await prepareUpdateFailureReport(
      { attemptId: "validator-missing-module", result: updateResult },
      { env: process.env, stateDir },
    );
    for (const body of [report.markdown, publicReport.body]) {
      expect(body).toContain("ERR_MODULE_NOT_FOUND");
      expect(body).not.toContain(secret);
      expect(body).not.toContain(root);
    }
    const outputPath = await writeTriageUpdateFailure(
      { result: updateResult },
      { env: process.env, outputPath: path.join(root, "failure.json") },
    );
    for (const read of [readTriageUpdateFailure, readReleasedTriageUpdateFailure]) {
      const failure = await read(outputPath, { env: process.env, stateDir });
      expect(failure).toMatchObject({
        result: {
          reason: "post-update-plugins",
          postUpdate: {
            plugins: {
              reason: "post-plugin-config-validation-execution-failed",
              warnings: [
                expect.objectContaining({
                  reason: expect.stringContaining("ERR_MODULE_NOT_FOUND"),
                  message: "Config validation could not complete; refusing to restart.",
                }),
              ],
            },
          },
        },
      });
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain("doctor --fix");
    }
    expect(mocks.runUtf8).not.toHaveBeenCalled();
  });

  it.each(["stderr", "stdout"] as const)(
    "retains a later public cause from %s without exposing multiline private details",
    async (stream) => {
      const secret = "sk-test-validation-secret-1234567890";
      mocks.command.mockRejectedValueOnce(
        Object.assign(new Error("private argv"), {
          failed: true,
          exitCode: 1,
          [stream]: [
            `Loading validator token=${secret} ${"context ".repeat(100)}`,
            "node:internal/modules/esm/resolve:272",
            "throw new Error('private source frame');",
            "^",
            "Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath is unavailable",
            "    at file:///private/fixture/validator.mjs:1:1",
            "private@example.test",
          ].join("\r\n\u2028\u2029"),
        }),
      );
      const { pluginUpdate: result } = await completePostCorePluginUpdate({
        ...updateOptions,
        pluginUpdate: { ...updateOptions.pluginUpdate, changed: false },
      });
      expect(result.failureFacts).toEqual([
        expect.objectContaining({ message: "Command exited with code 1" }),
        {
          check: "config",
          code: "command-failed",
          message: `${stream}: ERR_PACKAGE_PATH_NOT_EXPORTED`,
        },
      ]);
      expect(result.warnings?.[0]?.reason).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
      for (const privateValue of [
        secret,
        "private argv",
        "private source",
        "/private/fixture",
        "private@example.test",
      ]) {
        expect(JSON.stringify(result)).not.toContain(privateValue);
      }
      expect(mocks.runUtf8).not.toHaveBeenCalled();
    },
  );

  it("keeps the bounded redacted diagnostic when output has no recognized public cause", async () => {
    const secret = "sk-test-validation-secret-1234567890";
    mocks.command.mockRejectedValueOnce(
      Object.assign(new Error("private argv"), {
        failed: true,
        exitCode: 1,
        stderr: `Validator could not settle token=${secret} ${"context ".repeat(100)}\nprivate second line`,
      }),
    );
    const { pluginUpdate: result } = await completePostCorePluginUpdate({
      ...updateOptions,
      pluginUpdate: { ...updateOptions.pluginUpdate, changed: false },
    });
    expect(result.failureFacts?.[1]?.message).toMatch(/^stderr: Validator could not settle/u);
    expect(result.failureFacts?.[1]?.message?.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("private second line");
    expect(mocks.runUtf8).not.toHaveBeenCalled();
  });
}
