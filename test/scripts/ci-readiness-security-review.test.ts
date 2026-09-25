import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression, readCiWorkflow } from "./ci-workflow.test-support.js";
import {
  actions,
  createSecurityReviewFixture,
  jobs,
  rolePath,
  run,
  runsPath,
} from "./security-review-script.test-support.js";

const evaluate = createSecurityReviewFixture(useAutoCleanupTempDirTracker(afterEach));
const workflow = readCiWorkflow();

it.each([
  { action: "opened", draft: true },
  { action: "synchronize", draft: true },
  { action: "converted_to_draft", draft: true },
  { action: "labeled", draft: true, label: "ci:ready:fixture" },
  { action: "labeled", label: "bug" },
  { action: "unlabeled", label: "bug" },
  { action: "edited" },
  { action: "closed", merged: true },
])("preserves same-head Security Review after passive $action (draft=$draft)", (event) => {
  // Project the real producer predicates into the completed API fixture. Cheap
  // successful work changes an otherwise wholly skipped workflow to success.
  const context = {
    eventName: "pull_request" as const,
    repository: "openclaw/openclaw",
    runAttempt: 1,
    githubEvent: {
      action: event.action,
      changes: {},
      label: { name: event.label ?? "" },
      pull_request: { state: event.merged ? "closed" : "open", ...event },
    },
  };
  const emitted = ["readiness", "security-fast", "ci-gate"].map((id) => {
    const condition: string = workflow.jobs[id].if;
    return {
      name: id === "ci-gate" ? evaluateWorkflowExpression(workflow.jobs[id].name, context) : id,
      status: "completed",
      conclusion: evaluateWorkflowExpression(
        condition.startsWith("${{") ? condition : `\${{ ${condition} }}`,
        context,
      )
        ? "success"
        : "skipped",
    };
  });
  const passive = {
    ...run,
    id: 12,
    conclusion: emitted.every((job) => job.conclusion === "skipped") ? "skipped" : "success",
  };
  const result = evaluate({
    [runsPath]: { total_count: 2, workflow_runs: [passive, run] },
    [`GET ${actions}/runs/12`]: passive,
    [`GET ${actions}/runs/12/attempts/1/jobs`]: { total_count: emitted.length, jobs: emitted },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.combined).toEqual(["pending", "success"]);
  expect(passive.conclusion).toBe("skipped");
});

it.each([
  { name: "failed CI", conclusion: "failure", gate: "failure", expected: "failure" },
  { name: "failed preflight", conclusion: "failure", gate: "skipped", expected: "failure" },
  { name: "missing gate", conclusion: "success", gate: null, expected: "failure" },
  { name: "valid current CI", conclusion: "success", gate: "success", expected: "success" },
  { name: "security refusal", conclusion: "success", gate: "success", expected: "failure" },
])("keeps $name authoritative through the real Security Review entry point", (scenario) => {
  const current = { ...run, id: 11, conclusion: scenario.conclusion };
  const currentJobs = [
    {
      name: "preflight",
      status: "completed",
      conclusion: scenario.name === "failed preflight" ? "failure" : "success",
    },
    ...(scenario.gate ? [{ ...jobs.jobs[0], conclusion: scenario.gate }] : []),
  ];
  const result = evaluate({
    [runsPath]: { total_count: 2, workflow_runs: [current, run] },
    [`GET ${actions}/runs/11`]: current,
    [`GET ${actions}/runs/11/attempts/1/jobs`]: {
      total_count: currentJobs.length,
      jobs: currentJobs,
    },
    ...(scenario.name === "security refusal" ? { [rolePath]: { role_name: "write" } } : {}),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.combined.at(-1)).toBe(scenario.expected);
});

it.each([
  { status: "queued", broad: false, conclusion: null, expected: "pending" },
  { status: "in_progress", broad: false, conclusion: null, expected: "pending" },
  { status: "completed", broad: false, conclusion: "failure", expected: "failure" },
  { status: "completed", broad: false, conclusion: "success", expected: "failure" },
  { status: "completed", broad: true, conclusion: "success", expected: "success" },
])("Security Review stays $expected for $status CI (broad=$broad)", (scenario) => {
  const name = evaluateWorkflowExpression(workflow.jobs["ci-gate"].name, {
    eventName: "pull_request",
    repository: "openclaw/openclaw",
    runAttempt: 1,
    readinessEnforced: true,
    readinessBroadCi: scenario.broad,
    jobResults: { preflight: scenario.broad ? "success" : "skipped", "security-fast": "success" },
  });
  expect(name).toBe(scenario.broad ? "openclaw/ci-gate" : "CI deferred (not required)");
  const current = { ...run, id: 11, status: scenario.status, conclusion: scenario.conclusion };
  // Even an earlier same-head success cannot replace this diagnostic-only run.
  const result = evaluate({
    [runsPath]: { total_count: 2, workflow_runs: [current, run] },
    [`GET ${actions}/runs/11`]: current,
    [`GET ${actions}/runs/11/attempts/1/jobs`]: {
      total_count: 1,
      jobs: [{ name, status: "completed", conclusion: scenario.conclusion }],
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.combined.at(-1)).toBe(scenario.expected);
});
