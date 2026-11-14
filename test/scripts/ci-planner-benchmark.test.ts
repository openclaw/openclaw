import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  measurePlannerStage,
  parsePlannerOutputs,
  parsePlannerResources,
  writePlannerReport,
} from "../../scripts/bench-ci-planner.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import {
  readWorkflow,
  readWorkflowOutputs,
  requiredWorkflowStep,
  runWorkflowShellScript,
  type WorkflowStep,
  writeExecutable,
} from "./ci-workflow.test-support.js";

describe("planner measurement protocol", () => {
  it("starts the public CLI without running a measurement for help", () => {
    const text = execFileSync(process.execPath, ["scripts/bench-ci-planner.mts", "--help"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(text).toContain("--workload <clean-installed-checkout>");
    expect(text).toContain("five serial repetitions");
  });

  it("retains the exact check-plan JSON and refuses ambiguous output", () => {
    const input = '{ "changedPaths": ["src/cron/schedule.ts"], "value": "a=b" }';
    expect(parsePlannerOutputs(`run_check_plan=true\ncheck_plan_input_json=${input}\n`)).toEqual({
      run_check_plan: "true",
      check_plan_input_json: input,
    });
    expect(() => parsePlannerOutputs("run_check_plan=true\nrun_check_plan=false\n")).toThrow(
      "duplicate key",
    );
    expect(() => parsePlannerOutputs("not an output record")).toThrow("malformed");
  });

  it("uses GNU time units and refuses unavailable or partial resource records", () => {
    expect(parsePlannerResources("planner-resources\t1.14\t0.02\t1.25\t12345\n")).toEqual({
      userCpuSeconds: 1.14,
      systemCpuSeconds: 0.02,
      commandWallSeconds: 1.25,
      maximumResidentKiB: 12345,
    });
    for (const invalid of ["", "planner-resources\t?\t0.02\t1.25\t12345", "1.14 0.02 1.25 12345"]) {
      expect(() => parsePlannerResources(invalid)).toThrow();
    }
  });

  it("retains a bounded invalid report when indentation crosses the artifact limit", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "planner-report-test-"));
    const output = path.join(scratch, "report.json");
    try {
      const report = {
        valid: true,
        summaries: [],
        flows: [{ status: "success", manifestOutputs: { payload: "" }, checkOutputs: null }],
      };
      const limit = 16 * 1024 * 1024;
      report.flows[0]!.manifestOutputs.payload = "x".repeat(
        limit - JSON.stringify(report).length - 1,
      );
      expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(limit);
      expect(Buffer.byteLength(`${JSON.stringify(report, null, 2)}\n`)).toBeGreaterThan(limit);
      expect(writePlannerReport(report, output)).toBe(false);
      expect(statSync(output).size).toBeLessThan(limit);
      const stored = JSON.parse(readFileSync(output, "utf8"));
      expect(stored.valid).toBe(false);
      expect(stored.reportError).toContain("exceeds 16 MiB");
      expect(stored.flows).toEqual([{ status: "success", valid: false, planOutputsOmitted: true }]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("planner measurement dispatch", () => {
  const workflow = readWorkflow(".github/workflows/ci-planner-benchmark.yml");
  const steps: WorkflowStep[] = workflow.jobs.measure.steps;
  const selection = requiredWorkflowStep(steps, "Validate measurement selection");
  const pinCheck = requiredWorkflowStep(
    steps,
    "Verify matching package-manager pins before installation",
  );
  const workloadPins = [
    { sha: "79f5aeb133830a1db60b55cff3cf7a617086aa07", selection: "historical" },
    { sha: "ba284782cf1705d7e5f1f085b9cdefbb55932af6", selection: "reviewed" },
  ] as const;
  const workloadSha = workloadPins[0].sha;
  const workloadCheckouts = steps.filter((step) => step.with?.path === "workload");

  function validateSelection(overrides: Record<string, string>) {
    const scratch = mkdtempSync(path.join(tmpdir(), "planner-selection-test-"));
    const output = path.join(scratch, "outputs");
    try {
      const result = runWorkflowShellScript(selection.run!, {
        cwd: scratch,
        env: {
          PATH: process.env.PATH,
          LC_ALL: "C",
          WORKLOAD_SHA: workloadSha,
          BENCHMARK_CASE: "all",
          REPETITIONS: "5",
          ...overrides,
          GITHUB_OUTPUT: output,
        },
      });
      return { status: result.status, outputs: readWorkflowOutputs(output) };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("preserves defaults and binds checkout and collection to validated inputs", () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.workload_sha.default).toBe(workloadSha);
    expect(inputs.workload_sha.type).toBe("choice");
    expect(inputs.workload_sha.options).toEqual(workloadPins.map((pin) => pin.sha));
    expect(inputs.case.default).toBe("all");
    expect(inputs.repetitions.default).toBe("5");
    expect(steps[0]).toBe(selection);
    expect(selection["working-directory"]).toBe("${{ runner.temp }}");
    expect(selection.env).toEqual({
      WORKLOAD_SHA: "${{ inputs.workload_sha }}",
      BENCHMARK_CASE: "${{ inputs.case }}",
      REPETITIONS: "${{ inputs.repetitions }}",
      LC_ALL: "C",
    });
    expect(workloadCheckouts).toHaveLength(2);
    for (const [index, pin] of workloadPins.entries()) {
      expect(workloadCheckouts[index]?.if).toBe(
        `\${{ steps.selection.outputs.workload == '${pin.selection}' }}`,
      );
      expect(workloadCheckouts[index]?.with).toEqual({
        repository: "openclaw/openclaw",
        ref: pin.sha,
        path: "workload",
        "fetch-depth": 1,
        "persist-credentials": false,
        submodules: false,
      });
    }
    const verify = requiredWorkflowStep(steps, "Verify checkout and toolchain identities");
    expect(verify.env?.WORKLOAD_SHA).toBe("${{ steps.selection.outputs.workload_sha }}");
    expect(verify.run).toContain('test "$(git -C ../workload rev-parse HEAD)" = "$WORKLOAD_SHA"');
    expect(steps.indexOf(verify)).toBeLessThan(
      steps.indexOf(
        requiredWorkflowStep(steps, "Install each checkout from its own frozen lockfile"),
      ),
    );
    expect(verify["continue-on-error"]).not.toBe(true);
    const collect = requiredWorkflowStep(steps, "Measure selected serial planner flows");
    expect(collect.env).toMatchObject({
      WORKLOAD_SHA: "${{ steps.selection.outputs.workload_sha }}",
      BENCHMARK_CASE: "${{ steps.selection.outputs.case }}",
      REPETITIONS: "${{ steps.selection.outputs.repetitions }}",
    });
    expect(collect.run).toContain('--workload-sha "$WORKLOAD_SHA"');
    expect(collect.run).toContain('--case "$BENCHMARK_CASE"');
    expect(collect.run).toContain('--repetitions "$REPETITIONS"');
    expect(steps.indexOf(pinCheck)).toBeLessThan(
      steps.indexOf(
        requiredWorkflowStep(steps, "Install each checkout from its own frozen lockfile"),
      ),
    );
  });

  it.skipIf(process.platform === "win32").each(["all", "main", "cron", "discord"])(
    "admits %s at both repetition bounds",
    (selectionName) => {
      for (const pin of workloadPins) {
        for (const repetitions of ["1", "5"]) {
          const result = validateSelection({
            WORKLOAD_SHA: pin.sha,
            BENCHMARK_CASE: selectionName,
            REPETITIONS: repetitions,
          });
          expect(result).toEqual({
            status: 0,
            outputs: {
              workload: pin.selection,
              workload_sha: pin.sha,
              case: selectionName,
              repetitions,
            },
          });
          const selected = workloadCheckouts.filter(
            (step) =>
              step.if ===
              `\${{ steps.selection.outputs.workload == '${result.outputs.workload}' }}`,
          );
          expect(selected).toHaveLength(1);
          expect(selected[0]?.with?.ref).toBe(result.outputs.workload_sha);
        }
      }
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["WORKLOAD_SHA", ""],
    ["WORKLOAD_SHA", workloadSha.toUpperCase()],
    ["WORKLOAD_SHA", workloadSha.slice(1)],
    ["WORKLOAD_SHA", `${workloadSha}0`],
    ["WORKLOAD_SHA", "g".repeat(40)],
    ["WORKLOAD_SHA", "0123456789abcdef0123456789abcdef01234567"],
    ["WORKLOAD_SHA", `${workloadSha}\nextra`],
    ["BENCHMARK_CASE", "unknown"],
    ["REPETITIONS", "0"],
    ["REPETITIONS", "6"],
    ["REPETITIONS", "1.5"],
    ["REPETITIONS", "01"],
    ["REPETITIONS", "1; echo injected"],
  ])("rejects invalid %s=%j before publishing any selection", (key, value) => {
    expect(validateSelection({ [key]: value })).toEqual({ status: 1, outputs: {} });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a mismatched checkout before runtime checks or installation",
    () => {
      const scratch = mkdtempSync(path.join(tmpdir(), "planner-checkout-identity-test-"));
      const calls = path.join(scratch, "calls");
      try {
        writeExecutable(path.join(scratch, "git"), [
          "#!/bin/sh",
          'printf "%s\n" "$*" >> "$CALLS"',
          'case "$*" in',
          '  "rev-parse HEAD") printf "%s\n" "$HARNESS_SHA" ;;',
          '  "-C ../workload rev-parse HEAD") printf "%s\n" "$ACTUAL_WORKLOAD_SHA" ;;',
          "  *) exit 99 ;;",
          "esac",
        ]);
        for (const command of ["node", "pnpm"]) {
          writeExecutable(path.join(scratch, command), [
            "#!/bin/sh",
            `echo 'unexpected ${command}' >> "$CALLS"`,
            "exit 99",
          ]);
        }
        const verify = requiredWorkflowStep(steps, "Verify checkout and toolchain identities");
        const result = runWorkflowShellScript(verify.run!, {
          cwd: scratch,
          env: {
            PATH: `${scratch}${path.delimiter}${process.env.PATH ?? ""}`,
            CALLS: calls,
            HARNESS_SHA: "a".repeat(40),
            WORKLOAD_SHA: workloadPins[0].sha,
            ACTUAL_WORKLOAD_SHA: workloadPins[1].sha,
          },
        });
        expect(result.status).toBe(1);
        expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
          "rev-parse HEAD",
          "-C ../workload rev-parse HEAD",
        ]);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses mismatched or unpinned package managers before installation",
    () => {
      const pin = `pnpm@12.15.0+sha512.${"a".repeat(128)}`;
      const scratch = mkdtempSync(path.join(tmpdir(), "planner-package-pin-test-"));
      const harness = path.join(scratch, "harness");
      const workload = path.join(scratch, "workload");
      mkdirSync(harness);
      mkdirSync(workload);
      try {
        for (const [harnessPin, workloadPin, status] of [
          [pin, pin, 0],
          [pin, pin.replace(/a$/u, "b"), 1],
          [`${pin}\n`, `${pin}\n`, 1],
          ["pnpm@12.15.0", "pnpm@12.15.0", 1],
          [pin.replace("12.15.0", "12.14.0"), pin.replace("12.15.0", "12.14.0"), 1],
        ] as const) {
          writeFileSync(
            path.join(harness, "package.json"),
            JSON.stringify({ packageManager: harnessPin }),
          );
          writeFileSync(
            path.join(workload, "package.json"),
            JSON.stringify({ packageManager: workloadPin }),
          );
          const result = runWorkflowShellScript(pinCheck.run!, {
            cwd: harness,
            env: { PATH: process.env.PATH },
          });
          expect(result.status, result.stderr).toBe(status);
          if (status !== 0) {
            expect(result.stderr).toContain("identical integrity-pinned pnpm 12.15.0");
          }
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
});

const hasGnuTime =
  process.platform === "linux" && process.version === "v24.22.1" && existsSync("/usr/bin/time");

describe.skipIf(!hasGnuTime)("real planner process boundary", () => {
  it("keeps a timed-out child visible and invalidates its accounting", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "planner-timeout-test-"));
    try {
      const result = await measurePlannerStage({
        cwd: scratch,
        script: "--eval",
        args: ["setInterval(() => {}, 1000)"],
        env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
        timeoutMs: 100,
      });
      expect(result.status).toBe("timeout");
      expect(result.cleanupValid).toBe(false);
      expect(result.resourceAccountingValid).toBe(false);
      expect(result.scratchRemoved).toBe(true);
      expect(result.unavailableReason).toBeTruthy();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  it("preserves cancellation after a complete real planning repetition", async () => {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const scratch = mkdtempSync(path.join(tmpdir(), "planner-cancel-test-"));
    const output = path.join(scratch, "report.json");
    let progress = "";
    let cancelled = false;
    try {
      const code = await runManagedCommand({
        bin: process.execPath,
        args: [
          "scripts/bench-ci-planner.mts",
          "--workload",
          root,
          "--workload-sha",
          revision,
          "--case",
          "cron",
          "--repetitions",
          "2",
          "--output",
          output,
        ],
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: 540_000,
        requireProcessTreeExit: true,
        onReady(child) {
          child.stdout!.resume();
          child.stderr!.on("data", (chunk: Buffer) => {
            progress = (progress + chunk.toString("utf8")).slice(-4096);
            if (!cancelled && progress.includes("start cron repetition 2")) {
              cancelled = true;
              child.kill("SIGTERM");
            }
          });
        },
      });
      expect(cancelled, progress).toBe(true);
      expect(code).toBe(1);
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report.valid).toBe(false);
      const [flow, interrupted] = report.flows;
      expect(flow.valid).toBe(true);
      expect(flow.manifestOutputs.run_check_plan).toBe("true");
      expect(JSON.parse(flow.manifestOutputs.check_plan_input_json).changedPaths).toEqual([
        "src/cron/schedule.ts",
      ]);
      expect(flow.check.status).toBe("success");
      expect(JSON.parse(flow.checkOutputs.check_matrix).include.length).toBeGreaterThan(0);
      expect(interrupted.status).toBe("cancelled");
      expect(interrupted.planParity).toBe("unavailable");
      expect(interrupted.error).not.toContain("differs from the first repetition");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 580_000);
});
