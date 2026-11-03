import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { releaseChildDispatchInputs } from "../../scripts/lib/full-release-child-request.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const source = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
const workflow = parse(source) as {
  jobs: Record<
    string,
    {
      if?: string;
      env?: Record<string, string>;
      needs?: string[];
      steps: Array<Record<string, unknown>>;
    }
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
    expect(String(workflow.jobs.qualify_npm_package?.if)).not.toContain("github.run_attempt");
    expect(workflow.jobs.release_execution_plan?.needs).toEqual(
      expect.arrayContaining([
        "prepare_npm_package",
        "qualify_npm_package",
        "prepare_plugin_npm",
        "prepare_docker_release",
      ]),
    );
    for (const jobName of ["release_decision", "diagnostic_drain"]) {
      expect(workflow.jobs[jobName]?.needs).toEqual(
        expect.arrayContaining([
          "prepare_npm_package",
          "qualify_npm_package",
          "prepare_plugin_npm",
          "prepare_docker_release",
        ]),
      );
    }
    expect(workflow.jobs.summary?.env).toMatchObject({
      NPM_PREPARATION_RESULT: "${{ needs.prepare_npm_package.result }}",
      NPM_QUALIFICATION_RESULT: "${{ needs.qualify_npm_package.result }}",
      PLUGIN_NPM_PREPARATION_RESULT: "${{ needs.prepare_plugin_npm.result }}",
      DOCKER_PREPARATION_RESULT: "${{ needs.prepare_docker_release.result }}",
    });
    expect(source).not.toContain("continuationSource");
    expect(source).not.toContain("continuation_plan_json");
  });

  it.each([
    ["failure", false, "/workspace"],
    ["success", true, "/workspace/qualification-verifier"],
  ] as const)(
    "uses materialized verifier paths after %s target resolution",
    (result, verifierCheckedOut, verifierRoot) => {
      const verifierSha = "a".repeat(40);
      const targetSha = "b".repeat(40);
      const evaluate = (expression: unknown): unknown => {
        assert(typeof expression === "string");
        return runInNewContext(expression.replace(/^\$\{\{|\}\}$/gu, ""), {
          needs: {
            resolve_target: {
              result,
              outputs: {
                source_admission_json: JSON.stringify({
                  qualificationAdmission: { workflowSha: verifierSha },
                }),
                sha: targetSha,
              },
            },
          },
          github: { workspace: "/workspace" },
          fromJSON: JSON.parse,
          format: (pattern: string, value: string) => pattern.replace("{0}", value),
        });
      };
      for (const jobName of [
        "release_decision",
        "diagnostic_drain",
        "summary",
        "release_execution_plan",
        "evidence_reuse",
      ]) {
        const job = workflow.jobs[jobName];
        assert(job);
        const checkout = step(jobName, "Checkout admitted qualification verifier");
        expect(evaluate(checkout.if), jobName).toBe(verifierCheckedOut);
        expect(evaluate((checkout.with as Record<string, unknown>).ref), jobName).toBe(verifierSha);
        if (job.env?.RELEASE_STATE_SCRIPT) {
          expect(evaluate(job.env.RELEASE_STATE_SCRIPT), jobName).toBe(
            `${verifierRoot}/scripts/full-release-validation-state.mjs`,
          );
        }
        for (const entry of job.steps) {
          const env = entry.env as Record<string, unknown> | undefined;
          if (env?.OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR) {
            const root =
              jobName === "evidence_reuse" && !verifierCheckedOut
                ? "/workspace/workflow"
                : verifierRoot;
            expect(evaluate(env.OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR), jobName).toBe(
              `${root}/scripts/release-ci-summary.mjs`,
            );
          }
        }
      }
      for (const [jobName, stepName] of [
        ["evidence_reuse", "Find reusable validation evidence"],
        ["summary", "Write release validation manifest"],
      ] as const) {
        const env = step(jobName, stepName).env as Record<string, unknown>;
        expect(evaluate(env.TARGET_SHA)).toBe(targetSha);
      }
    },
  );

  it("restores the immutable attempt-one plan instead of rebuilding child identity", () => {
    const cache = step("release_execution_plan", "Cache immutable release execution plan");
    const restore = step(
      "release_execution_plan",
      "Restore immutable release execution plan artifact",
    );
    const inputsRestore = step(
      "release_execution_plan",
      "Restore immutable release execution plan inputs",
    );
    const inputsUpload = step(
      "release_execution_plan",
      "Upload immutable release execution plan inputs",
    );
    const upload = step("release_execution_plan", "Upload immutable release execution plan");
    expect(cache).toMatchObject({
      id: "plan_cache",
      "continue-on-error": true,
      with: {
        key: "full-release-execution-plan-v2-${{ github.run_id }}",
        path: "full-release-execution-plan",
      },
    });
    expect(cache.with).not.toHaveProperty("fail-on-cache-miss");
    expect(restore).toMatchObject({
      id: "plan_restore",
      "continue-on-error": true,
      if: "${{ always() && github.run_attempt != 1 && steps.plan_cache.outputs.cache-hit != 'true' }}",
      with: {
        "github-token": "${{ github.token }}",
        name: "full-release-execution-plan-${{ github.run_id }}",
        path: "${{ github.workspace }}/full-release-execution-plan",
        "run-id": "${{ github.run_id }}",
      },
    });
    expect(inputsRestore).toMatchObject({
      id: "plan_inputs_restore",
      if: "${{ always() && github.run_attempt != 1 && steps.plan_cache.outputs.cache-hit != 'true' && steps.plan_restore.outcome != 'success' }}",
      with: {
        name: "full-release-execution-plan-inputs-${{ github.run_id }}-1",
        path: "${{ github.workspace }}/full-release-execution-plan-inputs",
        "run-id": "${{ github.run_id }}",
      },
    });
    expect(inputsUpload).toMatchObject({
      id: "plan_inputs_upload",
      if: "${{ github.run_attempt == 1 && steps.plan_inputs.outcome == 'success' }}",
      with: {
        name: "full-release-execution-plan-inputs-${{ github.run_id }}-1",
        overwrite: false,
      },
    });
    expect(upload).toMatchObject({
      if: "${{ always() && steps.plan.outputs.sha256 != '' && steps.plan.outputs.source_parent_attempt == '1' && (steps.plan_inputs_upload.outcome == 'success' || steps.plan_inputs_restore.outcome == 'success') }}",
      with: {
        name: "full-release-execution-plan-${{ github.run_id }}",
        overwrite: false,
      },
    });
    const earlyRestore = step("resolve_target", "Restore immutable plan for publication admission");
    expect(earlyRestore.with).toEqual(cache.with);
    expect(earlyRestore.uses).toContain("actions/cache/restore@");
    expect(earlyRestore.if).toBe("github.run_attempt != 1");
    const restoredUpload = step(
      "resolve_target",
      "Upload restored immutable release execution plan",
    );
    expect(restoredUpload.if).toBe(
      "${{ github.run_attempt != 1 && steps.publication_plan_cache.outputs.cache-hit == 'true' }}",
    );
    expect(restoredUpload.with).toEqual(upload.with);
    expect(step("resolve_target", "Upload immutable publication admission").if).toBeUndefined();
    const resolver = workflow.jobs.resolve_target;
    if (!resolver) {
      throw new Error("missing resolve_target job");
    }
    const steps = resolver.steps;
    expect(
      steps.indexOf(step("resolve_target", "Restore immutable plan for publication admission")),
    ).toBeLessThan(steps.indexOf(step("resolve_target", "Admit publication source")));
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
