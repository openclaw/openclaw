import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Step = {
  name: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = {
  if: string;
  "cache-mode"?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
};
const workflow = parse(readFileSync(".github/workflows/openclaw-performance.yml", "utf8")) as {
  jobs: Record<string, Job>;
};
const job = workflow.jobs.utility_decision!;
const guard = workflow.jobs.utility_decision_guard!;
const step = (name: string, owner = job) => {
  const found = owner.steps.find((item) => item.name === name);
  if (!found) {
    throw new Error(`Missing step: ${name}`);
  }
  return found;
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const posixIt = it.skipIf(process.platform === "win32");
const runShell = (script: string, env: Record<string, string>) =>
  spawnSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, BENCHMARK_WORKLOAD: "decision-transport", ...env },
  });

it("isolates the manual benchmark from credentials, caches, publishing, and other modes", () => {
  expect(job.if).toBe(
    "${{ github.event_name == 'workflow_dispatch' && (inputs.mode == 'decision-transport' || inputs.mode == 'progress-narration') }}",
  );
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job["cache-mode"]).toBe("none");
  expect(job.env).not.toHaveProperty("ACTIONS_CACHE_MODE");
  expect(JSON.stringify(job)).not.toMatch(/secrets\.|actions\/cache|setup-node-env/);
  expect(job.env?.PNPM_CONFIG_FROZEN_LOCKFILE).toBe("true");
  for (const name of [
    "resolve_target",
    "kova",
    "source_performance",
    "publish",
    "artifact_only_guard",
    "seal_release_child_evidence",
  ]) {
    expect(workflow.jobs[name]?.if).toContain("inputs.mode != 'decision-transport'");
    expect(workflow.jobs[name]?.if).toContain("inputs.mode != 'progress-narration'");
  }
  expect(guard.needs?.toSorted()).toEqual(
    Object.keys(workflow.jobs)
      .filter((name) => name !== "utility_decision_guard" && name !== "seal_release_child_evidence")
      .toSorted(),
  );
  for (const variant of ["baseline", "candidate"]) {
    expect(step(`Set up ${variant} pnpm`)).toMatchObject({
      uses: "./.artifacts/utility-decision/helper/.github/actions/setup-pnpm-store-cache",
      with: {
        "package-manager-file": `.artifacts/utility-decision/${variant}/package.json`,
        "lockfile-path": `.artifacts/utility-decision/${variant}/pnpm-lock.yaml`,
        "cache-mode": "off",
      },
    });
    expect(step(`Install ${variant} dependencies`).run).toBe("pnpm install --frozen-lockfile");
  }
});

it("pins independent source checkouts and overlays only shared benchmark helpers", () => {
  for (const [variant, ref] of [
    ["helper", "${{ github.workflow_sha }}"],
    ["baseline", "${{ inputs.baseline_ref }}"],
    ["candidate", "${{ inputs.target_ref }}"],
  ]) {
    expect(step(`Checkout Utility and Decision ${variant}`).with).toEqual({
      ref,
      path: `.artifacts/utility-decision/${variant}`,
      "fetch-depth": 1,
      "persist-credentials": false,
    });
  }
  const build = step("Build Utility and Decision workers").run!;
  expect(build).toContain(
    "utilityBenchmarkSources[parseUtilityBenchmarkWorkload(process.env.BENCHMARK_WORKLOAD)]",
  );
  expect(build).toContain("source.entry, ...source.fixtures");
  expect(build).toContain('cp "$BENCHMARK_ROOT/helper/$file" "$BENCHMARK_ROOT/$variant/$file"');
  expect(build).toContain(
    'scripts/build-utility-decision-bench.mts "$revision" "$BENCHMARK_WORKLOAD"',
  );
});

posixIt.each([
  { baseline: "a".repeat(40), target: "b".repeat(40), attempt: "1", status: 0 },
  { baseline: "main", target: "b".repeat(40), attempt: "1", status: 1 },
  { baseline: "a".repeat(40), target: "B".repeat(40), attempt: "1", status: 1 },
  { baseline: "a".repeat(40), target: "b".repeat(40), attempt: "2", status: 1 },
  {
    baseline: "a".repeat(40),
    target: "b".repeat(40),
    attempt: "1",
    workload: "progress-narration",
    status: 0,
  },
  {
    baseline: "a".repeat(40),
    target: "b".repeat(40),
    attempt: "1",
    workload: "unknown",
    status: 1,
  },
])("validates exact refs and fresh attempts: $baseline / $attempt", (fixture) => {
  const result = runShell(step("Validate Utility and Decision request").run!, {
    BASELINE_REF: fixture.baseline,
    TARGET_REF: fixture.target,
    WORKFLOW_SHA: "c".repeat(40),
    GITHUB_RUN_ATTEMPT: fixture.attempt,
    BENCHMARK_WORKLOAD: fixture.workload ?? "decision-transport",
  });
  expect(result.status, result.stderr).toBe(fixture.status);
});

it.each(["none", "", "read", "write", "write-only"])(
  "requires effective cache denial in the JavaScript action: %s",
  (cacheMode) => {
    const check = step("Verify Utility and Decision cache denial");
    expect(check.uses).toBe("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3");
    expect(job.steps.indexOf(check)).toBeLessThan(
      job.steps.indexOf(step("Checkout Utility and Decision helper")),
    );
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "const core = { setFailed(message) { console.error(message); process.exitCode = 1; } };\n" +
          String(check.with?.script),
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, ACTIONS_CACHE_MODE: cacheMode },
      },
    );
    expect(result.status, result.stderr).toBe(cacheMode === "none" ? 0 : 1);
    if (cacheMode !== "none") {
      expect(result.stderr).toContain("runner-enforced cache denial");
    }
  },
);

posixIt.each([
  { candidate: "pnpm@12.10.1", status: 0 },
  { candidate: "pnpm@12.11.1", status: 1 },
])("compares measured package-manager pins, not the helper: $candidate", (fixture) => {
  const root = tempDirs.make("utility-workflow-pins-");
  for (const [variant, pin] of [
    ["helper", "pnpm@12.11.1"],
    ["baseline", "pnpm@12.10.1"],
    ["candidate", fixture.candidate],
  ] as const) {
    mkdirSync(join(root, variant));
    writeFileSync(join(root, variant, "package.json"), JSON.stringify({ packageManager: pin }));
  }
  const verify = step("Verify Utility and Decision source identities").run!;
  const result = runShell(verify.slice(verify.indexOf("node --input-type=module")), {
    BENCHMARK_ROOT: root,
  });
  expect(result.status, result.stderr).toBe(fixture.status);
});

posixIt.each([0, 7])("preserves measurement exit %i and the fixed workload", (status) => {
  const root = tempDirs.make("decision-workflow-command-");
  const argsPath = join(root, "args");
  const result = runShell(
    'node() { printf "%s\\n" "$@" > "$ARGS_PATH"; return "$CHILD_STATUS"; }\n' +
      step("Measure Utility and Decision pair").run,
    {
      ARGS_PATH: argsPath,
      CHILD_STATUS: String(status),
      BENCHMARK_ROOT: root,
      BENCHMARK_OUTPUT: join(root, "results"),
      BASELINE_MANIFEST: "baseline manifest.json",
      CANDIDATE_MANIFEST: "candidate manifest.json",
    },
  );
  expect(result.status, result.stderr).toBe(status);
  expect(readFileSync(argsPath, "utf8").trim().split("\n")).toEqual([
    join(root, "helper/scripts/bench-utility-decision.mts"),
    "--baseline",
    "baseline manifest.json",
    "--candidate",
    "candidate manifest.json",
    "--workload",
    "decision-transport",
    "--runs",
    "20",
    "--requests",
    "50",
    "--json",
    "--output",
    join(root, "results/report.json"),
  ]);
});

posixIt.each([
  { jobStatus: "failure", report: false, status: "failure" },
  { jobStatus: "success", report: false, status: "failure" },
  { jobStatus: "success", report: true, status: "success" },
])("retains a terminal outcome after $jobStatus with report=$report", (fixture) => {
  const root = tempDirs.make("decision-workflow-outcome-");
  const output = join(root, "results");
  mkdirSync(output);
  if (fixture.report) {
    writeFileSync(join(output, "report.json"), "{}");
  }
  const finalize = step("Finalize Utility and Decision artifact");
  expect(finalize.if).toBe("${{ always() }}");
  const result = runShell(finalize.run!, {
    BENCHMARK_OUTPUT: output,
    JOB_STATUS: fixture.jobStatus,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(output, "terminal-manifest.json"), "utf8"))).toMatchObject({
    status: fixture.status,
    reportPresent: fixture.report,
    jobStatus: fixture.jobStatus,
    workload: "decision-transport",
  });
  expect(step("Upload Utility and Decision artifact")).toMatchObject({
    if: "${{ always() }}",
    with: {
      name: "utility-decision-${{ inputs.mode }}-${{ github.run_id }}-${{ github.run_attempt }}",
      path: ".artifacts/utility-decision/results",
      "if-no-files-found": "error",
      "retention-days": 14,
    },
  });
});

posixIt.each([
  { benchmark: "success", unrelated: "skipped", status: 0 },
  { benchmark: "failure", unrelated: "skipped", status: 1 },
  { benchmark: "success", unrelated: "success", status: 1 },
])("enforces isolation with benchmark=$benchmark and unrelated=$unrelated", (fixture) => {
  const result = runShell(step("Verify isolated Utility and Decision result", guard).run!, {
    NEEDS_JSON: JSON.stringify({
      utility_decision: { result: fixture.benchmark },
      publish: { result: fixture.unrelated },
    }),
  });
  expect(result.status, result.stderr).toBe(fixture.status);
});
