import { expect, it } from "vitest";
import * as publication from "../../scripts/full-release-publication-contract.mjs";
import * as validation from "../../scripts/full-release-validation-at-sha.mts";
import * as workflow from "./ci-workflow.test-support.js";

const nightlyPath = ".github/workflows/full-release-validation-nightly.yml";
const nightly = workflow.readWorkflow(nightlyPath);
const frv = workflow.readWorkflow(".github/workflows/full-release-validation.yml");
const job = nightly.jobs.validate;
const steps: workflow.WorkflowStep[] = job.steps;
const helperStep = steps.find((step) => step.run?.includes("pnpm ci:full-release"));
const waitMinutes = validation.FULL_RELEASE_WAIT_TIMEOUT_MINUTES;

it("schedules nightly qualification every 3 hours without overlaps, with manual dispatch", () => {
  expect(nightly.on.schedule).toEqual([{ cron: "7 */3 * * *" }]);
  expect(nightly.concurrency).toEqual({
    group: "full-release-validation-nightly",
    "cancel-in-progress": false,
  });
  expect(nightly.on).toHaveProperty("workflow_dispatch");
  expect(nightly.on.workflow_dispatch?.inputs).toBeUndefined();
});

it.each(["schedule", "workflow_dispatch"] as const)("restricts %s to main", (eventName) => {
  expect(
    [
      { ref: "refs/heads/main" },
      { ref: "refs/heads/main", repository: "fork/openclaw" },
      { ref: "refs/heads/topic" },
    ].map((context) =>
      workflow.evaluateWorkflow("${{ " + job.if + " }}", { eventName, ...context }),
    ),
  ).toEqual([true, false, false]);
});

it("pins candidate, tooling and qualification inputs through the SHA-pinned helper", () => {
  const text = workflow.readTrackedText(nightlyPath);
  expect(text).not.toMatch(/createWorkflowDispatch|gh workflow run|github-script/u);
  expect(text).toContain("--trusted-workflow-ref main");
  expect(text).not.toMatch(/--ref\s+main|ref:\s*["']?main["']?\s*$/mu);
  expect(Object.keys(nightly.jobs)).toEqual(["validate"]);
  expect(job.permissions).toEqual({ actions: "write", contents: "write" });
  expect(job["runs-on"]).toBe(frv.jobs.release_decision["runs-on"]);
  expect(job["timeout-minutes"]).toBe(waitMinutes);
  expect(frv.jobs.release_decision["timeout-minutes"]).toBe(waitMinutes);
  expect(steps[0]).toMatchObject({
    uses: expect.stringMatching(/^actions\/checkout@[0-9a-f]{40}$/u),
    with: { ref: "${{ github.sha }}", "persist-credentials": false },
  });
  expect(helperStep?.env).toEqual({
    GH_TOKEN: "${{ github.token }}",
    VALIDATION_SHA: "${{ github.sha }}",
  });
  const sha = "a".repeat(40);
  const command = helperStep!.run!.replaceAll("\\\n", " ").trim();
  const [pnpm, script, ...argv] = command.split(/\s+/u);
  expect([pnpm, script]).toEqual(["pnpm", "ci:full-release"]);
  const args = validation.parseArgs(argv.map((arg) => arg.replaceAll('"$VALIDATION_SHA"', sha)));
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
  const purpose = publication.normalizePublicationIntent(validation_purpose, undefined);
  expect(publication.publicationDispatchEnvelope(null, purpose)).toBe(
    '{"publicationSelection":null,"trustedWorkflow":null,"validationPurpose":"main-qualification"}',
  );
});

it.each([true, false])("honors child evidence reuse=%s on the helper ref", (reuseEvidence) => {
  expect(
    workflow.evaluateWorkflow(frv.env.CHILD_EVIDENCE_REUSE, {
      inputs: { reuse_evidence: reuseEvidence, rerun_group: "all" },
      ref: "refs/heads/release-ci/aaaaaaaaaaaa-1790000000000",
    }),
  ).toBe(reuseEvidence);
});
