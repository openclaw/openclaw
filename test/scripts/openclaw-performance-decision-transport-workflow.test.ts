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
const job = workflow.jobs.decision_transport!;
const guard = workflow.jobs.decision_transport_guard!;
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
    env: { ...process.env, ...env },
  });

it("isolates the manual benchmark from credentials, caches, publishing, and other modes", () => {
  expect(job.if).toBe(
    "${{ github.event_name == 'workflow_dispatch' && inputs.mode == 'decision-transport' }}",
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
  }
  expect(guard.needs?.toSorted()).toEqual(
    Object.keys(workflow.jobs)
      .filter(
        (name) => name !== "decision_transport_guard" && name !== "seal_release_child_evidence",
      )
      .toSorted(),
  );
  for (const variant of ["baseline", "candidate"]) {
    expect(step(`Set up ${variant} pnpm`)).toMatchObject({
      uses: "./.artifacts/decision-transport/helper/.github/actions/setup-pnpm-store-cache",
      with: {
        "package-manager-file": `.artifacts/decision-transport/${variant}/package.json`,
        "lockfile-path": `.artifacts/decision-transport/${variant}/pnpm-lock.yaml`,
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
    expect(step(`Checkout Decision transport ${variant}`).with).toEqual({
      ref,
      path: `.artifacts/decision-transport/${variant}`,
      "fetch-depth": 1,
      "persist-credentials": false,
    });
  }
  const build = step("Build Decision transport workers").run!;
  const overlayStart = build.indexOf("for file in");
  const overlay = build.slice(overlayStart, build.indexOf("; do", overlayStart));
  expect(overlay.match(/scripts\/[\w/.-]+/g)).toEqual([
    "scripts/build-decision-transport-bench.mts",
    "scripts/bench-decision-transport-worker.ts",
    "scripts/lib/benchmark-harness.mts",
    "scripts/lib/arg-utils.mts",
  ]);
  expect(build).toContain('cp "$DECISION_ROOT/helper/$file" "$DECISION_ROOT/$variant/$file"');
  expect(build).toContain('scripts/build-decision-transport-bench.mts "$revision"');
});

posixIt.each([
  { baseline: "a".repeat(40), target: "b".repeat(40), attempt: "1", status: 0 },
  { baseline: "main", target: "b".repeat(40), attempt: "1", status: 1 },
  { baseline: "a".repeat(40), target: "B".repeat(40), attempt: "1", status: 1 },
  { baseline: "a".repeat(40), target: "b".repeat(40), attempt: "2", status: 1 },
])("validates exact refs and fresh attempts: $baseline / $attempt", (fixture) => {
  const result = runShell(step("Validate Decision transport request").run!, {
    BASELINE_REF: fixture.baseline,
    TARGET_REF: fixture.target,
    WORKFLOW_SHA: "c".repeat(40),
    GITHUB_RUN_ATTEMPT: fixture.attempt,
  });
  expect(result.status, result.stderr).toBe(fixture.status);
});

it.each(["none", "", "read", "write", "write-only"])(
  "requires effective cache denial in the JavaScript action: %s",
  (cacheMode) => {
    const check = step("Verify Decision transport cache denial");
    expect(check.uses).toBe("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3");
    expect(job.steps.indexOf(check)).toBeLessThan(
      job.steps.indexOf(step("Checkout Decision transport helper")),
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

posixIt.each([0, 7])("preserves measurement exit %i and the fixed workload", (status) => {
  const root = tempDirs.make("decision-workflow-command-");
  const argsPath = join(root, "args");
  const result = runShell(
    'node() { printf "%s\\n" "$@" > "$ARGS_PATH"; return "$CHILD_STATUS"; }\n' +
      step("Measure Decision transport pair").run,
    {
      ARGS_PATH: argsPath,
      CHILD_STATUS: String(status),
      DECISION_ROOT: root,
      DECISION_OUTPUT: join(root, "results"),
      BASELINE_MANIFEST: "baseline manifest.json",
      CANDIDATE_MANIFEST: "candidate manifest.json",
    },
  );
  expect(result.status, result.stderr).toBe(status);
  expect(readFileSync(argsPath, "utf8").trim().split("\n")).toEqual([
    join(root, "helper/scripts/bench-decision-transport.mts"),
    "--baseline",
    "baseline manifest.json",
    "--candidate",
    "candidate manifest.json",
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
  const finalize = step("Finalize Decision transport artifact");
  expect(finalize.if).toBe("${{ always() }}");
  const result = runShell(finalize.run!, {
    DECISION_OUTPUT: output,
    JOB_STATUS: fixture.jobStatus,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(output, "terminal-manifest.json"), "utf8"))).toMatchObject({
    status: fixture.status,
    reportPresent: fixture.report,
    jobStatus: fixture.jobStatus,
  });
  expect(step("Upload Decision transport artifact")).toMatchObject({
    if: "${{ always() }}",
    with: {
      name: "decision-transport-${{ github.run_id }}-${{ github.run_attempt }}",
      path: ".artifacts/decision-transport/results",
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
  const result = runShell(step("Verify isolated Decision transport result", guard).run!, {
    NEEDS_JSON: JSON.stringify({
      decision_transport: { result: fixture.benchmark },
      publish: { result: fixture.unrelated },
    }),
  });
  expect(result.status, result.stderr).toBe(fixture.status);
});
