import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  type UpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";
import { runGitDoctorStep } from "./update-runner-git-steps.js";
import type { UpdateStepResult } from "./update-runner-types.js";

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
