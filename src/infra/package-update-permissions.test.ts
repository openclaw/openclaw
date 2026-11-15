import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  packageUpdateStepResult,
  stagedNpmPrefix,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { UpdateFailureFactSchema } from "./update-run-schema.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

it.each(["EACCES", "EPERM"])(
  "reports npm %s with its directory and owner without retrying",
  async (code) => {
    await withTestDir({ prefix: "openclaw-permission-outcome-" }, async (base) => {
      const globalRoot = path.join(base, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const runStep = vi.fn(async ({ name, argv }: { name: string; argv: string[] }) => ({
        name,
        command: argv.join(" "),
        cwd: base,
        durationMs: 0,
        exitCode: 243,
        stderrTail: `npm error code ${code}\nnpm error syscall rename\nnpm error path ${packageRoot}\nnpm error ${code}: permission denied, rename '${packageRoot}'`,
      }));
      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });
      expect(result.reason).toBe("global-install-permission-denied");
      expect(result.failedStep?.stderrTail).toContain(globalRoot);
      expect(result.failedStep?.stderrTail).toContain(
        process.platform === "win32"
          ? "owner unavailable"
          : `UID ${(await fs.stat(globalRoot)).uid}`,
      );
      expect(result.failedStep?.stderrTail).toContain("rerun `openclaw update`");
      expect(result.failedStep?.failureFacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "global-install-permission-denied" }),
        ]),
      );
      expect(runStep).toHaveBeenCalledOnce();
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      expect(await fs.readdir(globalRoot)).toEqual(["openclaw"]);
    });
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "refuses an unwritable global directory before staging",
  async () => {
    await withTestDir({ prefix: "openclaw-permission-preflight-" }, async (base) => {
      const globalRoot = path.join(base, "lib", "node_modules");
      await writePackageRoot(path.join(globalRoot, "openclaw"), "1.0.0");
      const runStep = vi.fn();
      await fs.chmod(globalRoot, 0o555);
      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });
        expect(result.reason).toBe("global-install-permission-denied");
        expect(result.failedStep?.stderrTail).toContain(globalRoot);
        expect(result.failedStep?.stderrTail).toContain("chmod u+rwx");
        expect(runStep).not.toHaveBeenCalled();
        expect(await fs.readdir(globalRoot)).toEqual(["openclaw"]);
      } finally {
        await fs.chmod(globalRoot, 0o755);
      }
    });
  },
);

it.each([
  ["EACCES", "unknown"],
  ["EACCES", "stage"],
  ["EPERM", "unknown"],
  ["EACCES", "outside"],
  ["EACCES", "dest"],
  [undefined, "text-only"],
  [undefined, "unexpected-error"],
  [undefined, "causes"],
  [undefined, "private-prose"],
  [undefined, "saved-private-prose"],
] as const)("retains local exceptions with public-safe reports (%s, %s)", async (code, kind) => {
  await withTestDir({ prefix: "openclaw-validating-error-" }, async (base) => {
    const globalRoot = path.join(base, "lib/node_modules");
    const packageRoot = path.join(globalRoot, "openclaw");
    const env = { HOME: "/Users/Private Operator", OPENCLAW_STATE_DIR: path.join(base, "state") };
    await writePackageRoot(packageRoot, "1.0.0");
    const original = Object.assign(
      new Error(
        kind.includes("private-prose") || kind === "stage"
          ? "Candidate validation refused for customer AcmeInternal during merger planning"
          : "Candidate validation refused token=fixture-private-token /Users/Private Operator/secret",
        {
          cause:
            kind === "causes"
              ? Object.assign(new TypeError("Nested validation refused"), {
                  code: "ENOTSUP",
                  syscall: "open",
                  path: "/Users/Private Operator/hidden",
                  cause: Object.assign(new Error("Worker refused"), { code: "SQLITE_BUSY" }),
                })
              : undefined,
        },
      ),
      {
        ...(code ? { code } : {}),
        errno: -13,
        syscall: "spawn",
        ...(kind === "outside" ? { path: `${globalRoot}-other/worker` } : {}),
        ...(kind === "dest" ? { dest: path.join(packageRoot, "worker") } : {}),
      },
    );
    original.stack = `Error: validation\n    at validate (${fileURLToPath(new URL("./package-update-steps.ts", import.meta.url))}:605:7)`;
    if (kind === "text-only") {
      original.message += " EACCES";
    }
    const validateCandidate = vi.fn(async () => {
      throw original;
    });
    const stageFault =
      kind === "stage" ? vi.spyOn(fs, "mkdtemp").mockRejectedValue(original) : undefined;
    const result = await runGlobalPackageUpdateSteps({
      installTarget: createNpmTarget(globalRoot),
      installSpec: "openclaw@2.0.0",
      packageName: "openclaw",
      runCommand: createRootRunner(globalRoot),
      timeoutMs: 1000,
      env,
      runStep: async (step) => {
        await writePackageRoot(
          path.join(stagedNpmPrefix(step.argv), "lib/node_modules/openclaw"),
          "2.0.0",
        );
        return packageUpdateStepResult(step);
      },
      validateCandidate,
    }).finally(() => stageFault?.mockRestore());
    expect(validateCandidate).toHaveBeenCalledTimes(kind === "stage" ? 0 : 1);
    const check = kind === "stage" ? "package-stage" : "package-update";
    expect(result.failedStep).toMatchObject({ name: check, exitCode: 1 });
    const failed = result.failedStep!;
    const facts = failed.failureFacts ?? [];
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check,
          errorName: "Error",
          code: code ?? "Error",
          location: "src/infra/package-update-steps.ts:605:7",
          message: expect.stringContaining("Candidate validation refused"),
        }),
      ]),
    );
    const status = result.steps.flatMap(updateRunStepsFromResultStep);
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "validating-error",
        recordedRun: {
          runId: "validating-error",
          steps: result.steps.flatMap(updateRunStepsFromResultStep),
        },
        result: {
          status: "error",
          mode: "npm",
          durationMs: 1,
          steps: kind === "unexpected-error" || kind === "saved-private-prose" ? [] : result.steps,
          reason: result.reason ?? "unexpected-error",
        },
      },
      { env },
    );
    const local = JSON.stringify(status);
    for (const detail of ["Candidate validation refused", "errno=-13", "syscall=spawn", "path="]) {
      expect(local).toContain(detail);
    }
    if (kind.includes("private-prose") || kind === "stage") {
      expect(local).toContain("AcmeInternal during merger planning");
    }
    expect(report.body).not.toMatch(
      /Candidate validation refused|AcmeInternal|merger planning|errno=-13|syscall=spawn/u,
    );
    expect(report.body).toContain("Details retained locally");
    for (const output of [local, report.body]) {
      expect(output).toContain("src/infra/package-update-steps.ts:605:7");
      expect(output).not.toMatch(/Private Operator|fixture-private-token|hidden|secret/);
      if (kind !== "dest") {
        expect(output).not.toContain("chmod");
      }
      if (code) {
        expect(output).toContain(code);
      }
    }
    if (kind === "causes") {
      for (const detail of [
        "ENOTSUP",
        "TypeError",
        "Nested validation refused",
        "SQLITE_BUSY",
        "Worker refused",
      ]) {
        expect(local).toContain(detail);
      }
      expect(report.body).toContain("ENOTSUP");
      expect(report.body).toContain("SQLITE_BUSY");
      expect(report.body).not.toMatch(/Nested validation refused|Worker refused/u);
    }
    if (code || kind === "text-only") {
      expect(result.reason).toBe("global-install-permission-denied");
      expect(failed.stderrTail).toContain(
        kind === "dest" ? "rerun `openclaw update`" : "denied path",
      );
      if (kind === "dest" && process.platform !== "win32") {
        expect(failed.stderrTail).toContain("chmod u+rwx");
      }
    }
    for (const fact of facts) {
      expect(UpdateFailureFactSchema.safeParse(fact).success).toBe(true);
    }
    expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
  });
});
