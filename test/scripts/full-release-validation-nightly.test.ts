import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  normalizePublicationIntent,
  publicationDispatchEnvelope,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  FULL_RELEASE_WAIT_TIMEOUT_MINUTES,
  parseArgs,
} from "../../scripts/full-release-validation-at-sha.mts";
import {
  evaluateWorkflowExpression,
  readTrackedText,
  readWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const nightlyPath = ".github/workflows/full-release-validation-nightly.yml";
const nightly = readWorkflow(nightlyPath);
const frv = readWorkflow(".github/workflows/full-release-validation.yml");
const job = nightly.jobs.validate;
const steps: WorkflowStep[] = job.steps;
const helperStep = steps.find((step) => step.run?.includes("pnpm ci:full-release"));

function helperArgv(sha: string) {
  const command = helperStep!.run!.replaceAll("\\\n", " ").trim();
  const [pnpm, script, ...argv] = command.split(/\s+/u);
  expect([pnpm, script]).toEqual(["pnpm", "ci:full-release"]);
  return argv.map((arg) => arg.replaceAll('"$VALIDATION_SHA"', sha));
}

describe("nightly Full Release Validation", () => {
  it("schedules every 3 hours without overlapping runs and permits manual dispatch", () => {
    expect(nightly.on.schedule).toEqual([{ cron: "7 */3 * * *" }]);
    expect(nightly.concurrency).toEqual({
      group: "full-release-validation-nightly",
      "cancel-in-progress": false,
    });
    expect(nightly.on).toHaveProperty("workflow_dispatch");
    expect(nightly.on.workflow_dispatch?.inputs).toBeUndefined();
  });

  it.each(["schedule", "workflow_dispatch"] as const)(
    "admits %s only on canonical main",
    (eventName) => {
      const expression = "${{ " + job.if + " }}";
      const context = {
        eventName,
        repository: "openclaw/openclaw",
        ref: "refs/heads/main",
        runAttempt: 1,
      };
      expect(evaluateWorkflowExpression(expression, context)).toBe(true);
      expect(
        evaluateWorkflowExpression(expression, { ...context, repository: "fork/openclaw" }),
      ).toBe(false);
      expect(evaluateWorkflowExpression(expression, { ...context, ref: "refs/heads/topic" })).toBe(
        false,
      );
    },
  );

  it("routes through the SHA-pinned helper instead of raw-dispatching mutable main", () => {
    // Full Release Validation refuses child dispatch once its workflow ref moves; the
    // helper's immutable release-ci/* transport ref is the only supported route.
    const text = readTrackedText(nightlyPath);
    expect(text).not.toMatch(/createWorkflowDispatch|gh workflow run|github-script/u);
    expect(text).not.toMatch(/--ref\s+main|ref:\s*["']?main["']?\s*$/mu);
    expect(Object.keys(nightly.jobs)).toEqual(["validate"]);
    expect(job.permissions).toEqual({ actions: "write", contents: "write" });
    // The job hosts the helper's watch, so it needs the parent waiter's runner and budget.
    expect(job["runs-on"]).toBe(frv.jobs.release_decision["runs-on"]);
    expect(job["timeout-minutes"]).toBe(FULL_RELEASE_WAIT_TIMEOUT_MINUTES);
    expect(frv.jobs.release_decision["timeout-minutes"]).toBe(FULL_RELEASE_WAIT_TIMEOUT_MINUTES);
    expect(steps[0]).toMatchObject({
      uses: expect.stringMatching(/^actions\/checkout@[0-9a-f]{40}$/u),
      with: { ref: "${{ github.sha }}", "persist-credentials": false },
    });
    expect(helperStep?.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      VALIDATION_SHA: "${{ github.sha }}",
    });
  });

  it("pins one main SHA as candidate and tooling with declared main-qualification inputs", () => {
    const sha = "a".repeat(40);
    const args = parseArgs(helperArgv(sha));
    expect(args).toMatchObject({
      sha,
      workflowSha: sha,
      targetRef: "",
      trustedWorkflowRef: "main",
      keepBranch: false,
      dryRun: false,
    });
    const { validation_purpose, ...wireInputs } = args.inputs;
    expect(wireInputs).toEqual({
      provider: "openai",
      mode: "both",
      release_profile: "stable",
      run_release_soak: "true",
      reuse_evidence: "true",
      rerun_group: "all",
      allow_unreleased_changelog: "true",
      fail_fast: "false",
    });
    for (const [key, value] of Object.entries(wireInputs)) {
      const declared = frv.on.workflow_dispatch?.inputs?.[key];
      expect(declared, key).toBeDefined();
      if (declared?.type === "choice") {
        expect(declared.options, key).toContain(value);
      }
    }
    expect(
      publicationDispatchEnvelope(null, normalizePublicationIntent(validation_purpose, undefined)),
    ).toBe(
      '{"publicationSelection":null,"trustedWorkflow":null,"validationPurpose":"main-qualification"}',
    );
  });

  it.each([true, false])(
    "honors child evidence reuse=%s from the helper transport ref",
    (reuseEvidence) => {
      const expression = frv.env.CHILD_EVIDENCE_REUSE.replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
      expect(
        runInNewContext(expression, {
          inputs: { reuse_evidence: reuseEvidence, rerun_group: "all" },
          github: { ref: "refs/heads/release-ci/aaaaaaaaaaaa-1790000000000" },
          startsWith: (value: string, prefix: string) => value.startsWith(prefix),
        }),
      ).toBe(reuseEvidence);
    },
  );
});
