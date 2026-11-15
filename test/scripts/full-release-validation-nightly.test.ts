import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import * as publication from "../../scripts/full-release-publication-contract.mjs";
import * as validation from "../../scripts/full-release-validation-at-sha.mts";
import * as workflow from "./ci-workflow.test-support.js";

const nightlyPath = ".github/workflows/full-release-validation-nightly.yml";
const nightly = workflow.readWorkflow(nightlyPath);
const frv = workflow.readWorkflow(".github/workflows/full-release-validation.yml");
const watcher = workflow.readWorkflow(".github/workflows/full-release-state-watcher.yml").jobs
  .watch;
const job = nightly.jobs.validate;
const steps: workflow.WorkflowStep[] = job.steps;
const helperStep = steps.find((step) => step.run?.includes("pnpm ci:full-release"));
const waitMinutes = validation.FULL_RELEASE_WAIT_TIMEOUT_MINUTES;

it.each([
  ["openclaw/openclaw", "refs/heads/main", "decision", "workflow_dispatch", true],
  ["openclaw/openclaw", "refs/heads/release-ci/abcdef-123", "drain", "workflow_dispatch", true],
  ["openclaw/openclaw", "refs/heads/topic", "decision", "workflow_dispatch", false],
  ["fork/openclaw", "refs/heads/main", "decision", "workflow_dispatch", false],
  ["openclaw/openclaw", "refs/heads/main", "unknown", "workflow_dispatch", false],
  ["openclaw/openclaw", "refs/heads/main", "decision", "pull_request", false],
] as const)(
  "restricts the reusable watcher to its release caller: %s %s %s %s",
  (repository, ref, mode, eventName, allowed) => {
    expect(
      workflow.evaluateWorkflow("${{ " + watcher.if + " }}", {
        repository,
        ref,
        eventName,
        workflowRef: repository + "/.github/workflows/full-release-validation.yml@" + ref,
        inputs: { mode },
      }),
    ).toBe(allowed);
  },
);

it("schedules nightly qualification every 3 hours without overlaps, with manual dispatch", () => {
  expect(nightly.on.schedule).toEqual([{ cron: "7 */3 * * *" }]);
  expect(nightly.concurrency["cancel-in-progress"]).toBe(false);
  for (const eventName of ["schedule", "workflow_dispatch"] as const) {
    expect(workflow.evaluateWorkflow(nightly.concurrency.group, { eventName })).toBe(
      "full-release-validation-nightly",
    );
  }
  expect(nightly.on.workflow_dispatch?.inputs?.operation).toMatchObject({
    default: "full-release-validation",
    options: ["full-release-validation", "runner-canary"],
  });
});

it("isolates the main-only scheduling canary while preserving cleanup admission", () => {
  const canary = nightly.jobs.runner_canary;
  const context = {
    eventName: "workflow_dispatch" as const,
    runnerBackend: "hybrid" as const,
    inputs: { operation: "runner-canary" },
    boatReleaseRunnerGroup: "boat-watchers",
    additionalNeeds: {
      boat_nightly_runner: {
        result: "success" as const,
        outputs: { nightly_label: "owned-label" },
      },
    },
  };
  expect(workflow.evaluateWorkflow(nightly.concurrency.group, context)).toBe(
    "full-release-validation-nightly-canary",
  );
  expect(workflow.evaluateWorkflow(canary["runs-on"], context)).toEqual({
    group: "boat-watchers",
    labels: "owned-label",
  });
  expect(canary["timeout-minutes"]).toBe(10);
  expect(canary.permissions).toEqual({ contents: "read" });
  const admits = (name: string, override = {}) =>
    workflow.evaluateWorkflow(`\${{ ${nightly.jobs[name].if} }}`, { ...context, ...override });
  expect(admits("boat_nightly_runner")).toBe(true);
  expect(admits("runner_canary")).toBe(true);
  expect(admits("validate")).toBe(false);
  expect(admits("cleanup_boat_nightly_runner", { cancelled: true, failed: true })).toBe(true);
  for (const override of [
    { repository: "fork/openclaw" },
    { ref: "refs/heads/topic" },
    { eventName: "schedule" },
    { additionalNeeds: { boat_nightly_runner: { result: "failure", outputs: {} } } },
  ]) {
    expect(admits("runner_canary", override)).toBe(false);
  }
});

it.each([
  ["watch", "queued", true],
  ["watch", "queued", false],
  ["watch", "in_progress", false],
  ["cancel", "in_progress", true],
  ["cancel", "in_progress", false],
] as const)("bounds canary %s from %s (completes=%s)", async (phase, status, completes) => {
  const cleanup = nightly.jobs.cleanup_boat_nightly_runner;
  const cleanupSteps: workflow.WorkflowStep[] = cleanup.steps;
  const step = cleanupSteps.find((candidate) =>
    phase === "watch"
      ? candidate.id === "canary_wait"
      : candidate.name === "Cancel an unfinished canary before cleanup",
  )!;
  const outputs = new Map<string, unknown>();
  const failures: string[] = [];
  let now = 0;
  let calls = 0;
  let cancelled = false;
  const script = step.with?.script;
  if (typeof script !== "string") {
    throw new Error("Missing canary script");
  }
  const execution = runInNewContext(`(async () => { ${script} })()`, {
    context: { repo: { owner: "openclaw", repo: "openclaw" }, runId: 123, sha: "source" },
    process: { env: { GITHUB_RUN_ATTEMPT: "2", CANARY_LABEL: "owned-label" } },
    Date: { now: () => now },
    setTimeout: (callback: () => void, delay: number) => {
      now += delay;
      callback();
    },
    core: {
      setOutput: (key: string, value: unknown) => outputs.set(key, value),
      setFailed: (message: string) => failures.push(message),
    },
    github: {
      rest: {
        actions: {
          cancelWorkflowRun: async (request: unknown) => {
            expect(request).toMatchObject({ run_id: 123, request: { timeout: 10_000 } });
            cancelled = true;
          },
          listJobsForWorkflowRunAttempt: async (request: unknown) => {
            expect(request).toMatchObject({
              run_id: 123,
              attempt_number: 2,
              request: { timeout: 10_000 },
            });
            return {
              data: {
                jobs: [
                  {
                    name: "Verify Boat runner scheduling",
                    head_sha: "source",
                    labels: ["owned-label"],
                    status: completes && calls++ > 0 ? "completed" : status,
                    conclusion: "success",
                    runner_id: 7,
                    runner_name: "owned-label",
                  },
                ],
              },
            };
          },
        },
      },
    },
  });
  if (phase === "cancel" && !completes) {
    await expect(execution).rejects.toThrow("Canary cancellation did not settle");
  } else {
    await execution;
  }
  if (phase === "watch") {
    expect(outputs.get("terminal")).toBe(String(completes));
    expect(outputs.get("succeeded")).toBe(completes || "false");
    expect(failures).toHaveLength(completes ? 0 : 1);
  }
  expect(cancelled).toBe(phase === "cancel");
  expect(now).toBe(completes ? 5_000 : 300_000);
  expect(cleanup.needs).not.toContain("runner_canary");
  const cancel = cleanupSteps.findIndex(
    (candidate) => candidate.name === "Cancel an unfinished canary before cleanup",
  );
  expect(cancel).toBeLessThan(cleanupSteps.findIndex((candidate) => candidate.id === "nightly"));
  expect(cleanupSteps[cancel]?.if).toContain("always()");
  expect(cleanupSteps.find((candidate) => candidate.id === "nightly")!.if).toBe("always()");
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
  expect(text).not.toMatch(/createWorkflowDispatch|gh workflow run/u);
  expect(text).toContain("--trusted-workflow-ref main");
  expect(text).not.toMatch(/--ref\s+main|ref:\s*["']?main["']?\s*$/mu);
  expect(Object.keys(nightly.jobs)).toEqual([
    "boat_nightly_runner",
    "runner_canary",
    "validate",
    "cleanup_boat_nightly_runner",
  ]);
  expect(job.permissions).toEqual({ actions: "write", contents: "write" });
  expect(workflow.evaluateWorkflow(job["runs-on"], { runnerBackend: "github" })).toBe(
    "ubuntu-24.04",
  );
  expect(job["timeout-minutes"]).toBe(waitMinutes);
  expect(watcher["timeout-minutes"]).toBe(waitMinutes);
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

it("routes long watchers to their own Boat runner and always cleans up after them", () => {
  for (const [selected, provision, waiters, cleanup] of [
    [
      frv,
      "boat_release_runners",
      ["release_decision", "diagnostic_drain"],
      "cleanup_boat_release_runners",
    ],
    [nightly, "boat_nightly_runner", ["validate"], "cleanup_boat_nightly_runner"],
  ] as const) {
    const failedProvision = {
      runnerBackend: "boat" as const,
      ref: "refs/heads/main",
      additionalNeeds: { [provision]: { result: "failure" as const, outputs: {} } },
    };
    for (const name of waiters) {
      const waiter = selected.jobs[name];
      expect(waiter.needs).toContain(provision);
      const runnerJob = selected === frv ? watcher : waiter;
      expect(runnerJob["timeout-minutes"]).toBe(720);
      if (selected === frv) {
        expect(waiter.uses).toBe(
          "openclaw/openclaw/.github/workflows/full-release-state-watcher.yml@ad1621f7e9d896dfdcc202d007e766e6c30153df",
        );
      }
      expect(
        workflow.evaluateWorkflow(runnerJob["runs-on"], {
          inputs: { runner_label: "selected-watcher" },
          runnerBackend: "boat",
          releaseRunnerGroup: "hosted-controls",
          boatReleaseRunnerGroup: "boat-watchers",
          additionalNeeds: {
            [provision]: {
              result: "success",
              outputs: {
                decision_label: "decision",
                drain_label: "drain",
                nightly_label: "nightly",
              },
            },
          },
        }),
      ).toMatchObject({ group: "boat-watchers" });
      expect(workflow.evaluateWorkflow(`\${{ ${waiter.if} }}`, failedProvision)).toBe(false);
      expect(
        workflow.evaluateWorkflow(`\${{ ${waiter.if} }}`, {
          ...failedProvision,
          additionalNeeds: { [provision]: { result: "success", outputs: {} } },
        }),
      ).toBe(true);
    }
    expect(selected.jobs[cleanup].needs).toEqual([provision, ...waiters]);
    expect(
      workflow.evaluateWorkflow(`\${{ ${selected.jobs[cleanup].if} }}`, {
        ...failedProvision,
        failed: true,
        cancelled: true,
      }),
    ).toBe(true);
    expect(
      workflow.evaluateWorkflow(`\${{ ${selected.jobs[provision].if} }}`, {
        ...failedProvision,
        cancelled: true,
      }),
    ).toBe(false);
  }
});

it.each([true, false])("honors child evidence reuse=%s on the helper ref", (reuseEvidence) => {
  expect(
    workflow.evaluateWorkflow(frv.env.CHILD_EVIDENCE_REUSE, {
      inputs: { reuse_evidence: reuseEvidence, rerun_group: "all" },
      ref: "refs/heads/release-ci/aaaaaaaaaaaa-1790000000000",
    }),
  ).toBe(reuseEvidence);
});
