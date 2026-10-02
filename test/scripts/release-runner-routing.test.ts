import { expect, it } from "vitest";
import { evaluateWorkflowRunner as runner, readWorkflow } from "./ci-workflow.test-support.js";

type Job = {
  "runs-on"?: string;
  uses?: string;
  with?: Record<string, string>;
  environment?: unknown;
  permissions?: Record<string, string>;
};
type Workflow = {
  on: { workflow_call?: { inputs?: Record<string, { default?: unknown }> } };
  jobs: Record<string, Job>;
};
const workflow = (name: string): Workflow => readWorkflow(`.github/workflows/${name}.yml`);
const group = 'Release "reserved"';
const context = {
  runnerBackend: "github" as const,
  preflightOutputs: { node_runner_backend: "github" },
};
const reserved = {
  ...context,
  releaseRunnerGroup: group,
  runnerGroup: group,
  dispatchId: "full-release-validation-123-1",
  releasePublishRunId: "123",
};

it.each([
  ["full-release-validation", "resolve_target"],
  ["install-smoke-reusable", "preflight"],
  ["ci", "checks-fast-core"],
])("routes %s/%s through the reservation without changing its label", (name, job) => {
  const selector = workflow(name).jobs[job]!["runs-on"];
  const label = runner(selector, context);
  expect(label).toMatch(/^ubuntu-/u);
  expect(runner(selector, reserved)).toEqual({ group, labels: label });
  if (name === "ci") {
    for (const eventName of ["pull_request", "workflow_dispatch"] as const) {
      expect(runner(selector, { ...reserved, eventName, dispatchId: "", releaseGate: true })).toBe(
        label,
      );
    }
  }
});

it("keeps credentialed publishers on GitHub-hosted runners despite a reservation", () => {
  const publishers = `
    openclaw-release-publish openclaw-release-promote openclaw-npm-release plugin-npm-release
    plugin-clawhub-release plugin-clawhub-new plugin-clawhub-postpublish docker-release
    vercel-container-registry-publish
  `
    .trim()
    .split(/\s+/u);
  for (const name of publishers) {
    for (const job of Object.values(workflow(name).jobs)) {
      if (
        job["runs-on"] &&
        (job.environment !== undefined ||
          job.permissions?.["id-token"] === "write" ||
          /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)/u.test(JSON.stringify(job)))
      ) {
        expect(runner(job["runs-on"], reserved), name).toMatch(/^(?:ubuntu|windows|macos)-/u);
      }
    }
  }
});

it("forwards reservations through reusable calls in both release orchestrators", () => {
  for (const name of ["full-release-validation", "openclaw-release-checks"]) {
    for (const [jobName, job] of Object.entries(workflow(name).jobs)) {
      const child = /^\.\/\.github\/workflows\/(.+)\.yml$/u.exec(job.uses ?? "")?.[1];
      if (!child || !workflow(child).on.workflow_call?.inputs?.runner_group) {
        continue;
      }
      expect(workflow(child).on.workflow_call?.inputs?.runner_group?.default, child).toBe("");
      expect(runner(job.with?.runner_group, reserved), `${name}/${jobName}`).toBe(group);
    }
  }
});
