import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi, type Mock } from "vitest";
import type { readConfigFileSnapshot } from "../../config/config.js";
import type {
  DeferredPluginMigration,
  readDeferredPluginMigrationsAsync,
} from "../../infra/deferred-plugin-migrations.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { adoptUpdateRun, createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import type { runExec, runUtf8CommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";

export function registerFreshDoctorOutcomeTests(
  mocks: {
    command: Mock<typeof runExec>;
    runUtf8: Mock<typeof runUtf8CommandWithTimeout>;
    readConfig: Mock<typeof readConfigFileSnapshot>;
    pendingMigrations: Mock<typeof readDeferredPluginMigrationsAsync>;
  },
  updateOptions: Parameters<typeof completePostCorePluginUpdate>[0],
  validConfigSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): void {
  it.each([false, true])(
    "reports plugin repairs still pending after successful Doctor (completed: %s)",
    async (completed) => {
      const pending = ["acpx", "codex"].map((pluginId): DeferredPluginMigration => ({
        pluginId,
        reason: "Doctor-only session repair remains pending.",
        command: "openclaw doctor --fix",
        requiresStateMigration: true,
      }));
      mocks.pendingMigrations
        .mockResolvedValueOnce(pending)
        .mockResolvedValue(completed ? [] : pending);
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "1");

      const { pluginUpdate: result } = await completePostCorePluginUpdate({
        ...updateOptions,
        pluginUpdate: { ...updateOptions.pluginUpdate, changed: false },
      });

      expect(result.status).toBe(completed ? "ok" : "warning");
      expect(result.warnings).toHaveLength(completed ? 0 : 2);
      if (!completed) {
        for (const pluginId of ["acpx", "codex"]) {
          expect(result.warnings).toContainEqual({
            pluginId,
            reason: "doctor-advisory",
            message: expect.stringContaining(
              `Plugin "${pluginId}" data/settings upgrade is unfinished`,
            ),
            guidance: ['Run "openclaw doctor --fix" to finish the plugin data/settings upgrade.'],
          });
        }
        expect(
          result.warnings?.every((warning) => !warning.message.includes("Let the current")),
        ).toBe(true);
      }
    },
  );

  it.each([
    { kind: "advisory", check: "doctor", code: "doctor-failed", blocks: false },
    {
      kind: "migration refusal",
      check: "state.session-participants",
      code: "step-refused",
      blocks: true,
    },
  ])(
    "retains the $kind Doctor outcome when config validation cannot settle",
    async ({ check, code, blocks }) => {
      const doctorFacts = Array.from({ length: 4 }, (_, index) => ({
        check,
        code,
        message: `Earlier failure ${index}`,
      }));
      mocks.command.mockImplementation(async (_command, args, options) => {
        if (args.includes("--repair")) {
          assert(options && typeof options === "object");
          const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
          assert(resultPath);
          await writeUpdatePostInstallDoctorResult({
            resultPath,
            result: { status: "error", failureFacts: doctorFacts },
          });
          throw Object.assign(new Error("Doctor failed"), { exitCode: 1 });
        }
        throw Object.assign(new Error("private argv"), {
          failed: true,
          timedOut: true,
          cleanup: "uncertain",
          stderr: "Validation process could not settle",
        });
      });
      const { pluginUpdate: result } = await completePostCorePluginUpdate(updateOptions);
      expect(result.status).toBe("error");
      expect(result.reason).toBe(
        blocks
          ? "post-plugin-doctor-execution-failed"
          : "post-plugin-config-validation-execution-failed",
      );
      if (blocks) {
        expect(result.failureFacts).toHaveLength(5);
        expect(result.failureFacts?.slice(0, 4)).toEqual(doctorFacts);
        expect(result.failureFacts?.[4]?.message).toContain("cleanup=uncertain");
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings?.[0]?.message).toContain(
          "Post-update plugin Doctor did not complete",
        );
      } else {
        expect(result.failureFacts).toEqual([
          expect.objectContaining({
            code: "post-plugin-config-validation-execution-failed",
            message: expect.stringContaining("cleanup=uncertain"),
          }),
          expect.objectContaining({
            code: "command-failed",
            message: "stderr: Validation process could not settle",
          }),
        ]);
        expect(result.warnings).toEqual([
          expect.objectContaining({ reason: "doctor-advisory" }),
          expect.objectContaining({
            message: "Config validation could not complete; refusing to restart.",
          }),
        ]);
      }
      expect(mocks.runUtf8).not.toHaveBeenCalled();
    },
  );

  it("records a failed plugin Doctor process as a warning after config and readiness pass", async () => {
    mocks.command.mockRejectedValueOnce(
      Object.assign(new Error("Doctor exited"), {
        exitCode: 1,
        stderr: "Plugin example: optional repair needs a running Gateway.",
      }),
    );

    const result = await completePostCorePluginUpdate(updateOptions);

    expect(result.pluginUpdate).toMatchObject({
      status: "warning",
      warnings: [
        expect.objectContaining({
          reason: "doctor-advisory",
          message: expect.stringContaining(
            "Plugin example: optional repair needs a running Gateway.",
          ),
        }),
      ],
    });
    expect(result.pluginUpdate.failureFacts).toBeUndefined();
    expect(result.configSnapshot.valid).toBe(true);
    expect(mocks.runUtf8).toHaveBeenCalledOnce();
  });

  it.each(["settlement", "startup"])(
    "blocks further work when Doctor %s leaves write custody unsettled",
    async (phase) => {
      mocks.command.mockRejectedValueOnce(
        phase === "settlement"
          ? new CommandProcessCleanupError()
          : Object.assign(new Error("Command timed out during startup"), { cleanup: "uncertain" }),
      );

      await expect(completePostCorePluginUpdate(updateOptions)).rejects.toThrow(
        "Command cleanup could not confirm that owned work stopped",
      );
      expect(mocks.command).toHaveBeenCalledOnce();
      expect(mocks.readConfig).not.toHaveBeenCalled();
      expect(mocks.runUtf8).not.toHaveBeenCalled();
    },
  );

  it.each(["cleanup", "output", "settled"])(
    "preserves an unsafe Doctor refusal when warning publication fails (%s)",
    async (fault) => {
      const original = new Error("Doctor migration refused");
      const recording =
        fault === "cleanup" ? new CommandProcessCleanupError() : new Error("Warning output failed");
      const refusal = { kind: "data-at-risk" as const, reason: "active-mutation" as const };
      mocks.command.mockImplementationOnce(async (_command, _args, options) => {
        assert(options && typeof options === "object");
        const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
        assert(resultPath);
        await writeUpdatePostInstallDoctorResult({
          resultPath,
          result: {
            status: fault === "settled" ? "ok" : "error",
            maintenanceRefusal: refusal,
            failureFacts: [{ check: "state", code: "step-refused" }],
            warnings: ["Keep the migration backup."],
          },
        });
        if (fault !== "settled") {
          throw original;
        }
        return { stdout: "", stderr: "" };
      });
      const error = await completePostCorePluginUpdate({
        ...updateOptions,
        onWarnings: () => {
          throw recording;
        },
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        cause: recording,
        errors: [
          expect.objectContaining({
            ...(fault !== "settled" ? { cause: original } : {}),
            refusal,
            failureFacts: [{ check: "state", code: "step-refused" }],
          }),
          recording,
        ],
      });
      expect(hasCommandProcessCleanupError(error)).toBe(fault === "cleanup");
      expect(mocks.readConfig).not.toHaveBeenCalled();
      expect(mocks.runUtf8).not.toHaveBeenCalled();
    },
  );
  it("returns readiness facts without publishing update history, output, or reports", async () => {
    await withTempHome(async (home) => {
      const run = createUpdateRun({ trigger: "cli" });
      adoptUpdateRun(run.runId);
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      const before = getUpdateRun(run.runId);
      const beforeDoctor = vi.fn(async () => undefined);
      mocks.readConfig.mockResolvedValue({ ...validConfigSnapshot, valid: false });
      vi.mocked(defaultRuntime.log).mockClear();
      vi.mocked(defaultRuntime.error).mockClear();

      const result = await completePostCorePluginUpdate({
        ...updateOptions,
        runId: run.runId,
        pluginUpdate: { ...updateOptions.pluginUpdate, changed: false },
        beforeDoctor,
      });

      expect(result.pluginUpdate.status).toBe("ok");
      expect(result.pluginUpdate.doctorLint).toMatchObject({ exitCode: 0, termination: "exit" });
      expect(beforeDoctor).not.toHaveBeenCalled();
      expect(result.configSnapshot.valid).toBe(false);
      expect(mocks.command.mock.calls.map(([, args]) => args)).toEqual([
        ["/opt/openclaw/dist/index.js", "config", "validate", "--json"],
      ]);
      expect(mocks.runUtf8).toHaveBeenCalledOnce();
      expect(getUpdateRun(run.runId)).toEqual(before);
      expect(defaultRuntime.log).not.toHaveBeenCalled();
      expect(defaultRuntime.error).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(home, ".openclaw", "update-reports"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
  it.each([
    { name: "policy exit", physical: { code: 1 } },
    { name: "other exit", physical: { code: 2 } },
    {
      name: "signal",
      physical: { code: null, termination: "signal", signal: "SIGTERM", killed: true },
    },
    {
      name: "timeout",
      physical: { code: 124, termination: "timeout", signal: "SIGTERM", killed: true },
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
    },
  ] as const)(
    "retains physical $name facts without accepting interrupted policy output",
    async ({ physical }) => {
      const finding = {
        checkId: "core/doctor/security",
        severity: "error",
        message: "Discord DMs are open.",
      };
      const execution = {
        ...({
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          outputLimitExceeded: undefined,
        } as const),
        ...physical,
        stdout: JSON.stringify({ ok: false, checksRun: 1, findings: [finding] }),
        stderr: "Readiness diagnostic",
      };
      mocks.runUtf8.mockResolvedValue(execution);

      const { pluginUpdate: result } = await completePostCorePluginUpdate(updateOptions);

      expect(result.status).toBe("warning");
      expect(result.doctorLint).toMatchObject({
        exitCode: execution.code,
        termination: execution.termination,
        signal: execution.signal,
        killed: execution.killed,
        outputLimitExceeded: execution.outputLimitExceeded,
        stderrTail: execution.stderr,
        doctorLintFindings: [{ ...finding, severity: "warning" }],
      });
      expect(result.doctorLint?.advisory?.kind).toBe("recoverable-maintenance");
    },
  );
}
