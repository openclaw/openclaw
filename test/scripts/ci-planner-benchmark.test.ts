import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
