import { expect, it } from "vitest";
import {
  evaluateWorkflowExpression as expression,
  evaluateWorkflowRunner as runner,
  readWorkflow,
} from "./ci-workflow.test-support.js";

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
const jobs = (name: string) => workflows.get(name)!.jobs;
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
const ordinaryEvents = ["pull_request", "push", "schedule", "workflow_dispatch"] as const;

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
  const credentialedJobs: Record<string, string> = {
    "openclaw-npm-release": "publish_openclaw_npm",
    "plugin-npm-release": "publish_plugins_npm",
    "plugin-clawhub-release": "approve_plugins_clawhub_release",
    "docker-release": "publish",
  };
  const defaultLabels: [unknown, string][] = [
    [Object.values(jobs("openclaw-release-publish"))[0]?.["runs-on"], "ubuntu-latest"],
    [jobs("full-release-validation").resolve_target?.["runs-on"], "ubuntu-24.04"],
    [jobs("ci")["macos-swift"]?.["runs-on"], "xcode-27"],
    [jobs("ci")["checks-windows"]?.["runs-on"], "windows-2025"],
  ];
  for (const [selector, label] of defaultLabels) {
    expect(runner(selector, context)).toBe(label);
  }
  for (const [name, workflow] of workflows) {
    const pinnedJob = credentialedJobs[name];
    if (pinnedJob) {
      expect(credentialed(name, workflow.jobs[pinnedJob]!)).toBe(true);
    }
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
          expect(
            expression(job.if!.startsWith("${{") ? job.if! : `\${{ ${job.if} }}`, {
              ...ordinary,
              repository: "openclaw/openclaw",
              runAttempt: 1,
              preflightOutputs: {
                run_checks_node_core_nondist: "true",
                shared_sdk_declarations: "false",
              },
            }),
          ).toBe(false);
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
