import { expect, it } from "vitest";
import { evaluateWorkflowRunner as runner, readWorkflow } from "./ci-workflow.test-support.js";

const names = (text: string) => text.trim().split(/\s+/u);
const dedicated = names(`
  full-release-validation full-release-artifacts full-release-candidate
  full-release-child-evidence plugin-prerelease openclaw-release-checks openclaw-npm-preflight
  docker-release-prepare openclaw-cross-os-release-checks-reusable openclaw-release-publish
  openclaw-npm-release plugin-clawhub-release plugin-clawhub-new plugin-clawhub-postpublish
`);
const shared = names(`
  install-smoke-reusable openclaw-live-and-e2e-checks-reusable openclaw-repo-e2e-reusable
  package-acceptance maturity-scorecard qa-profile-evidence qa-live-transports-convex
  npm-telegram-beta-e2e docker-release vercel-container-registry-publish
`);
const mixed = ["ci", "openclaw-performance", "plugin-npm-release"];
// npm trusted publishing rejects self-hosted runners.
const publishing = new Set(
  names(`
  openclaw-release-publish openclaw-release-promote openclaw-npm-release plugin-npm-release
  plugin-clawhub-release plugin-clawhub-new plugin-clawhub-postpublish docker-release
  vercel-container-registry-publish
`),
);
type Job = {
  if?: string;
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
const loadWorkflow = (name: string): Workflow => readWorkflow(`.github/workflows/${name}.yml`);
const workflows = new Map(
  [...dedicated, ...shared, ...mixed].map((name) => [name, loadWorkflow(name)]),
);
const group = 'Release "reserved"';
const context = {
  matrix: { runner: "ubuntu-24.04", group: "fixture", task: "test", check_name: "fixture" },
  runnerBackend: "github" as const,
  preflightOutputs: { node_runner_backend: "github" },
};
const releaseDispatch = {
  ...context,
  releaseRunnerGroup: group,
  dispatchId: "full-release-validation-123-1",
  releasePublishRunId: "123",
};
const reserved = { ...releaseDispatch, runnerGroup: group };
const ordinaryEvents = ["pull_request", "workflow_dispatch"] as const;

const credentialed = (name: string, job: Job) =>
  publishing.has(name) &&
  (job.environment !== undefined ||
    job.permissions?.["id-token"] === "write" ||
    /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)/u.test(JSON.stringify(job)));

it("keeps the credentialed Linux promotion dispatcher on GitHub-hosted runners", () => {
  const name = "openclaw-release-promote";
  const job = loadWorkflow(name).jobs.publish_linux!;
  expect(credentialed(name, job)).toBe(true);
  expect(runner(job["runs-on"], releaseDispatch)).toBe("ubuntu-latest");
});

it("reserves release workers while preserving ordinary and credentialed runner labels", () => {
  for (const [name, workflow] of workflows) {
    const events = [undefined, ...([...shared, ...mixed].includes(name) ? ordinaryEvents : [])];
    const releaseContext = { ...releaseDispatch, runnerGroup: shared.includes(name) ? group : "" };
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!job["runs-on"]) {
        continue;
      }
      for (const event of events) {
        const release = event === undefined;
        const eventName = event ?? "workflow_dispatch";
        const ordinary = { ...context, eventName, ...(release ? {} : { releaseGate: true }) };
        if (
          name === "ci" &&
          ((jobName === "pr-failure-report" && eventName !== "pull_request") ||
            jobName === "check-extension-package-boundary")
        ) {
          continue;
        }
        const baseline = runner(job["runs-on"], release ? context : ordinary);
        if (release) {
          expect(baseline, `${name}/${jobName}`).toBeTypeOf("string");
          expect(baseline).not.toBe("");
        }
        const routed = runner(
          job["runs-on"],
          release ? releaseContext : { ...ordinary, releaseRunnerGroup: group },
        );
        expect(routed, `${name}/${jobName}/${eventName}/${release}`).toEqual(
          !release || credentialed(name, job) ? baseline : { group, labels: baseline },
        );
      }
    }
  }
});

it("forwards the reservation through shared workers and nested reusable calls", () => {
  for (const name of shared) {
    expect(workflows.get(name)?.on.workflow_call?.inputs?.runner_group?.default, name).toBe("");
  }
  for (const [name, workflow] of workflows) {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const child = /^\.\/\.github\/workflows\/(.+)\.yml$/u.exec(job.uses ?? "")?.[1];
      if (!child || !shared.includes(child)) {
        continue;
      }
      expect(runner(job.with?.runner_group, reserved), `${name}/${jobName} -> ${child}`).toBe(
        group,
      );
    }
  }
});
