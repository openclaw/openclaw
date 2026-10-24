import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { releaseChildDispatchInputs } from "../../scripts/lib/full-release-child-request.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const source = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
type Workflow = {
  jobs: Record<string, { if?: string; steps: Array<Record<string, unknown>> }>;
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
};
const workflow = parse(source) as Workflow;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function step(job: string, name: string) {
  const match = workflow.jobs[job]?.steps.find((entry) => entry.name === name);
  assert(match, `missing workflow step: ${job}/${name}`);
  return match;
}

function sparsePaths(checkout: Record<string, unknown>) {
  const value = checkout["sparse-checkout"];
  assert(typeof value === "string", "sparse-checkout must be a string");
  return value
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
}

function checkoutPath(checkout: Record<string, unknown>) {
  const path = checkout.path ?? "";
  assert(typeof path === "string", "checkout path must be a string");
  return path;
}

function runNode(args: string[], cwd: string) {
  return execFileSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
}

function copyTooling(root: string, checkout: Record<string, unknown>, extraPath?: string) {
  const destination = join(root, checkoutPath(checkout));
  for (const path of ["scripts", ...(extraPath ? [extraPath] : [])]) {
    cpSync(path, join(destination, path), { recursive: true });
  }
  return destination;
}

describe("full release metadata checkouts", () => {
  it.each([
    ["resolve_target", "Checkout trusted workflow helper", "release-tooling-identity.mjs"],
    ["evidence_reuse", "Checkout trusted workflow helper", "release-ci-summary.mjs"],
    [
      "release_execution_plan",
      "Checkout release execution plan tooling",
      "full-release-validation-state.mjs",
    ],
    ["release_decision", "Checkout release decision tooling", "full-release-validation-state.mjs"],
    ["diagnostic_drain", "Checkout diagnostic drain tooling", "full-release-validation-state.mjs"],
    ["summary", "Checkout release state verifier", "full-release-candidate-reuse.mjs"],
  ])("runs %s tooling from the complete scripts tree", (job, name, entrypoint) => {
    const checkout = step(job, name).with as Record<string, unknown>;
    expect(checkout).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false });
    if (job === "resolve_target") {
      expect(checkout).toMatchObject({ path: "workflow", "fetch-depth": 1, submodules: false });
      expect(checkout).not.toHaveProperty("sparse-checkout");
      expect(checkout).not.toHaveProperty("sparse-checkout-cone-mode");
    } else {
      expect(checkout["sparse-checkout-cone-mode"]).toBe(false);
      expect(sparsePaths(checkout)).toEqual(
        job === "evidence_reuse"
          ? ["scripts", ".github/actions/setup-pnpm-store-cache"]
          : ["scripts"],
      );
    }
    const root = copyTooling(
      tempDirs.make("release-tooling-"),
      checkout,
      job === "evidence_reuse" ? ".github/actions/setup-pnpm-store-cache" : undefined,
    );
    expect(
      runNode(["--input-type=module", "-e", `await import("./scripts/${entrypoint}");`], root),
    ).toBe("");
  });

  it("never loads target scripts as trusted tooling", () => {
    for (const [job, name] of [
      ["resolve_target", "Checkout target package manifest"],
      ["evidence_reuse", "Checkout target SHA"],
    ]) {
      const checkout = step(job, name).with as Record<string, unknown>;
      expect(checkout["sparse-checkout-cone-mode"]).toBe(false);
      expect(sparsePaths(checkout)).not.toContain("scripts");
    }
  });
});

describe("full release same-parent recovery workflow", () => {
  it("normalizes scalar dispatch defaults and rejects unfamiliar declarations", () => {
    const contents = `on:
  workflow_dispatch:
    inputs:
      enabled:
        type: boolean
      count:
        type: number
      label:
        type: string
      quoted:
        type: string
        default: "value"
      ref:
        type: choice
        default: main
        options:
          - main
      dispatch_id:
        type: string
        default: "quoted"
`;
    const expected = { enabled: "false", count: "0", label: "", quoted: "value", ref: "main" };
    expect(releaseChildDispatchInputs(contents, [])).toEqual(expected);
    expect(
      releaseChildDispatchInputs(contents, [
        "-f",
        "label=exact=bytes",
        "-f",
        "dispatch_id=ignored",
      ]),
    ).toEqual({ ...expected, label: "exact=bytes" });
    expect(() => releaseChildDispatchInputs(contents, ["-f", "unknown=true"])).toThrow("argument");
    expect(() =>
      releaseChildDispatchInputs(contents.replace("    inputs:", "    inputs: &defaults"), []),
    ).toThrow();
  });

  it.each(["failure", "success", "missing"])(
    "reports %s locale diagnostics without changing validation evidence",
    (conclusion) => {
      const summaryStep = step("diagnostic_drain", "Summarize locale validation");
      const root = tempDirs.make("openclaw-release-locales-");
      const diagnosticPath = join(root, "diagnostics.json");
      const summaryPath = join(root, "summary.md");
      const jobs = [
        { name: "native-i18n", conclusion: "success" },
        { name: "control-ui-i18n", conclusion },
      ];
      const diagnostic = JSON.stringify({
        state: "blocked_complete",
        children: conclusion === "missing" ? {} : { normalCi: { timing: { jobs } } },
      });
      writeFileSync(diagnosticPath, diagnostic);
      const output = execFileSync("bash", ["-e", "-c", String(summaryStep.run)], {
        env: {
          PATH: process.env.PATH,
          DIAGNOSTIC_DRAIN_PATH: diagnosticPath,
          GITHUB_STEP_SUMMARY: summaryPath,
        },
        encoding: "utf8",
      });
      const summary = readFileSync(summaryPath, "utf8");
      expect(summary).toContain(
        `| control-ui-i18n | ${conclusion === "missing" ? "not recorded" : conclusion} |`,
      );
      expect(summary).toContain(
        `| native-i18n | ${conclusion === "missing" ? "not recorded" : "success"} |`,
      );
      expect(output.includes("::warning::")).toBe(conclusion === "failure");
      if (conclusion === "failure") {
        expect(summary).toContain("> [!WARNING]");
      }
      expect(readFileSync(diagnosticPath, "utf8")).toBe(diagnostic);
    },
  );

  it("has no continuation payload and dispatches child work only on attempt one", () => {
    expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty("continuation_plan_json");
    for (const job of [
      "normal_ci",
      "plugin_prerelease_independent",
      "plugin_prerelease_candidate",
      "release_checks_independent",
      "release_checks_candidate",
      "npm_telegram",
      "performance",
    ]) {
      expect(String(workflow.jobs[job]?.if), job).toContain("github.run_attempt == 1");
    }
    for (const [job, dispatch] of [
      ["prepare_npm_package", "Dispatch immutable npm artifact producer"],
      ["prepare_docker_release", "Dispatch immutable Docker artifact producer"],
      ["candidate_acquisition", "Dispatch immutable validation candidate producer"],
    ] as const) {
      expect(String(workflow.jobs[job]?.if), job).not.toContain("github.run_attempt");
      const dispatchCondition = step(job, dispatch).if;
      const recoveryCondition = step(job, "Recover original artifact producer").if ?? "true";
      assert(typeof dispatchCondition === "string");
      assert(typeof recoveryCondition === "string");
      for (const reused of job === "candidate_acquisition" ? [undefined] : ["false", "true"]) {
        for (const attempt of [1, 2]) {
          const context = {
            github: { run_attempt: attempt },
            env: { PUBLICATION_ARTIFACTS_REUSED: reused },
          };
          expect(runInNewContext(dispatchCondition, context)).toBe(
            attempt === 1 && reused !== "true",
          );
          expect(runInNewContext(recoveryCondition, context)).toBe(reused !== "true");
        }
      }
    }
    expect(String(workflow.jobs.qualify_npm_package?.if)).not.toContain("github.run_attempt");
  });

  it("keeps immutable plan artifacts parent-bound and non-overwriting", () => {
    const artifactSteps = Object.values(workflow.jobs)
      .flatMap(({ steps }) => steps)
      .filter((entry) =>
        /^(?:Upload|Download|Restore).*immutable release execution plan/u.test(String(entry.name)),
      );
    expect(artifactSteps.length).toBeGreaterThan(0);
    for (const entry of artifactSteps) {
      const options = entry.with as Record<string, unknown>;
      expect(options.name).toContain("${{ github.run_id }}");
      if (String(entry.name).startsWith("Upload")) {
        expect(options.overwrite).toBe(false);
      } else if (String(entry.name).startsWith("Restore")) {
        expect(options["run-id"]).toBe("${{ github.run_id }}");
      }
    }
    const steps = workflow.jobs.resolve_target!.steps;
    expect(
      steps.indexOf(step("resolve_target", "Restore immutable plan for publication admission")),
    ).toBeLessThan(steps.indexOf(step("resolve_target", "Admit publication source")));
  });

  it("waits for installation quota before candidate dispatch", () => {
    const candidateSteps = workflow.jobs.candidate_acquisition?.steps ?? [];
    const quotaIndex = candidateSteps.findIndex(
      (candidate) => candidate?.name === "Wait for candidate acquisition GitHub API quota",
    );
    const dispatchIndex = candidateSteps.findIndex(
      (candidate) => candidate?.name === "Dispatch immutable validation candidate producer",
    );
    expect(quotaIndex).toBeGreaterThan(-1);
    expect(dispatchIndex).toBeGreaterThan(quotaIndex);
    expect(String(candidateSteps[quotaIndex]?.if)).toContain("github.run_attempt == 1");
  });

  it("only fail-fast decision collection can cancel children", () => {
    expect(step("release_decision", "Evaluate release decision").env).toMatchObject({
      FAIL_FAST: "${{ inputs.fail_fast }}",
      FULL_RELEASE_STATE_MODE: "decision",
    });
    expect(step("diagnostic_drain", "Drain child diagnostics").env).toMatchObject({
      FAIL_FAST: "false",
      FULL_RELEASE_STATE_MODE: "drain",
    });
  });
});
