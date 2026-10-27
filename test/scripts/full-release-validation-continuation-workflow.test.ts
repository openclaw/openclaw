import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { releaseChildDispatchInputs } from "../../scripts/lib/full-release-child-request.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8")) as {
  jobs: Record<
    string,
    { if?: string; env?: Record<string, string>; steps: Array<Record<string, unknown>> }
  >;
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const allSteps = Object.values(workflow.jobs).flatMap(({ steps }) => steps);

function step(job: string, name: string) {
  const match = workflow.jobs[job]?.steps.find((entry) => entry.name === name);
  assert(match, `missing workflow step: ${job}/${name}`);
  return match;
}

it("runs release tooling only from the trusted revision without persisted credentials", () => {
  const tooling = allSteps.filter((entry) =>
    /^Checkout (?:trusted workflow|.*tooling|release state verifier)/u.test(String(entry.name)),
  );
  expect(tooling.length).toBeGreaterThan(0);
  for (const entry of tooling) {
    const checkout = entry.with as Record<string, unknown>;
    expect(checkout).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false });
    const sparseCheckout = checkout["sparse-checkout"];
    if (sparseCheckout !== undefined) {
      assert(typeof sparseCheckout === "string");
      expect(sparseCheckout.split(/\s+/u)).toContain("scripts");
    }
  }
  const targets = allSteps.filter((entry) => String(entry.name).startsWith("Checkout target"));
  expect(targets.length).toBeGreaterThan(0);
  for (const entry of targets) {
    const checkout = entry.with as Record<string, unknown>;
    expect(checkout.path).not.toBe("workflow");
    expect(String(checkout["sparse-checkout"]).split(/\s+/u)).not.toContain("scripts");
  }
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

  it("dispatches fresh child work only on attempt one while allowing artifact recovery", () => {
    expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty("continuation_plan_json");
    let workloadDispatches = 0;
    let artifactDispatches = 0;
    for (const job of Object.values(workflow.jobs)) {
      const artifact = job.env?.CHILD_WORKFLOW_KIND?.startsWith("artifact-");
      const dispatches = job.steps.filter((entry) => String(entry.name).startsWith("Dispatch"));
      for (const dispatch of dispatches) {
        const env = dispatch.env as Record<string, unknown> | undefined;
        if (!artifact && env?.CHILD_WORKFLOW_KIND) {
          workloadDispatches += 1;
          expect(String(job.if)).toContain("github.run_attempt == 1");
        } else if (artifact) {
          artifactDispatches += 1;
          expect(String(job.if)).not.toContain("github.run_attempt");
          const recovery = job.steps.find(
            (entry) => entry.name === "Recover original artifact producer",
          );
          assert(recovery);
          for (const reused of job.env?.PUBLICATION_ARTIFACTS_REUSED
            ? ["false", "true"]
            : [undefined]) {
            for (const attempt of [1, 2]) {
              const context = {
                github: { run_attempt: attempt },
                env: { PUBLICATION_ARTIFACTS_REUSED: reused },
              };
              expect(runInNewContext(String(dispatch.if), context)).toBe(
                attempt === 1 && reused !== "true",
              );
              const recoveryCondition: unknown = recovery.if ?? "true";
              assert(typeof recoveryCondition === "string");
              expect(runInNewContext(recoveryCondition, context)).toBe(reused !== "true");
            }
          }
        }
      }
    }
    expect(workloadDispatches).toBeGreaterThan(0);
    expect(artifactDispatches).toBeGreaterThan(0);
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
