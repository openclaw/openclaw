import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import type { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readTriageUpdateFailure } from "../../commands/triage-update.js";
import { readReleasedTriageUpdateFailure } from "../../commands/triage-update.released-reader.test-support.js";
import { writeTriageUpdateFailure } from "../../infra/update-failure-report-artifact.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";

export function registerFreshDoctorDiagnosticTests({
  mocks,
  tempDirs,
  updateOptions,
}: {
  mocks: {
    resolveEntrypoint: Mock;
    runExec: Mock;
    runUtf8: Mock<typeof import("../../process/exec.js").runUtf8CommandWithTimeout>;
  };
  tempDirs: ReturnType<typeof useAutoCleanupTempDirTracker>;
  updateOptions: Parameters<typeof completePostCorePluginUpdate>[0];
}): void {
  it("captures a real missing-module failure after long warnings for current and released readers", async () => {
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
       await import('./missing-validator.mjs');`,
    );
    mocks.resolveEntrypoint.mockResolvedValue(script);
    const { runExec } =
      await vi.importActual<typeof import("../../process/exec.js")>("../../process/exec.js");
    mocks.runExec.mockImplementation(runExec);
    const { pluginUpdate: result } = await completePostCorePluginUpdate({
      ...updateOptions,
      root,
      nodeRunner: process.execPath,
      freshDoctorRequired: false,
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
      mocks.runExec.mockRejectedValueOnce(
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
        freshDoctorRequired: false,
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
    mocks.runExec.mockRejectedValueOnce(
      Object.assign(new Error("private argv"), {
        failed: true,
        exitCode: 1,
        stderr: `Validator could not settle token=${secret} ${"context ".repeat(100)}\nprivate second line`,
      }),
    );
    const { pluginUpdate: result } = await completePostCorePluginUpdate({
      ...updateOptions,
      freshDoctorRequired: false,
    });
    expect(result.failureFacts?.[1]?.message).toMatch(/^stderr: Validator could not settle/u);
    expect(result.failureFacts?.[1]?.message?.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("private second line");
    expect(mocks.runUtf8).not.toHaveBeenCalled();
  });
}
