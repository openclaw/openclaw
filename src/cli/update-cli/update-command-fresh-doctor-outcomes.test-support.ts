import assert from "node:assert/strict";
import { expect, it, type Mock } from "vitest";
import type { readConfigFileSnapshot } from "../../config/config.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import type { runExec, runUtf8CommandWithTimeout } from "../../process/exec.js";
import { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";

export function registerFreshDoctorOutcomeTests(
  mocks: {
    runExec: Mock<typeof runExec>;
    runUtf8: Mock<typeof runUtf8CommandWithTimeout>;
    readConfig: Mock<typeof readConfigFileSnapshot>;
  },
  updateOptions: Parameters<typeof completePostCorePluginUpdate>[0],
): void {
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
      mocks.runExec.mockImplementation(async (_command, args, options) => {
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
    mocks.runExec.mockRejectedValueOnce(
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
      mocks.runExec.mockRejectedValueOnce(
        phase === "settlement"
          ? new CommandProcessCleanupError()
          : Object.assign(new Error("Command timed out during startup"), { cleanup: "uncertain" }),
      );

      await expect(completePostCorePluginUpdate(updateOptions)).rejects.toThrow(
        "Command cleanup could not confirm that owned work stopped",
      );
      expect(mocks.runExec).toHaveBeenCalledOnce();
      expect(mocks.readConfig).not.toHaveBeenCalled();
      expect(mocks.runUtf8).not.toHaveBeenCalled();
    },
  );
}
