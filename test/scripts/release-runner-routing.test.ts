import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { evaluateWorkflowExpression, evaluateWorkflowRunner } from "./ci-workflow.test-support.js";

const dedicated = [
  "full-release-validation",
  "full-release-artifacts",
  "full-release-candidate",
  "full-release-child-evidence",
  "plugin-prerelease",
  "openclaw-release-checks",
  "openclaw-npm-preflight",
  "docker-release-prepare",
  "openclaw-cross-os-release-checks-reusable",
  "openclaw-release-publish",
  "openclaw-npm-release",
  "plugin-clawhub-release",
  "plugin-clawhub-new",
  "plugin-clawhub-postpublish",
];
const shared = [
  "install-smoke-reusable",
  "openclaw-live-and-e2e-checks-reusable",
  "openclaw-repo-e2e-reusable",
  "package-acceptance",
  "maturity-scorecard",
  "qa-profile-evidence",
  "qa-live-transports-convex",
  "npm-telegram-beta-e2e",
  "docker-release",
  "vercel-container-registry-publish",
];
// Route only for a release dispatch; ordinary events keep their labels.
const mixed = ["ci", "openclaw-performance", "plugin-npm-release"];
// Publication paths: approval and credentialed publish jobs stay on default
// GitHub-hosted labels (npm trusted publishing rejects self-hosted runners).
const publishing = new Set([
  "openclaw-release-publish",
  "openclaw-npm-release",
  "plugin-npm-release",
  "plugin-clawhub-release",
  "plugin-clawhub-new",
  "plugin-clawhub-postpublish",
  "docker-release",
  "vercel-container-registry-publish",
]);
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
const workflows = new Map(
  [...dedicated, ...shared, ...mixed].map((name) => [
    name,
    parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as Workflow,
  ]),
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

function credentialed(name: string, job: Job) {
  return (
    publishing.has(name) &&
    (job.environment !== undefined ||
      job.permissions?.["id-token"] === "write" ||
      /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)/u.test(JSON.stringify(job)))
  );
}

describe("release runner reservation", () => {
  it.each([...workflows])(
    "routes every %s worker while preserving its selected labels",
    (name, workflow) => {
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (!job["runs-on"]) {
          continue;
        }
        if (name === "ci" && jobName === "pr-fail-fast") {
          expect(
            evaluateWorkflowExpression(job.if!, {
              ...context,
              eventName: "workflow_dispatch",
              repository: "openclaw/openclaw",
              runAttempt: 1,
              preflightOutputs: { run_checks_node_core_nondist: "true" },
            }),
          ).toBe(false);
          continue;
        }
        const baseline = evaluateWorkflowRunner(job["runs-on"], context);
        expect(baseline, `${name}/${jobName}`).toBeTypeOf("string");
        expect(baseline).not.toBe("");
        const routed = evaluateWorkflowRunner(job["runs-on"], {
          ...releaseDispatch,
          runnerGroup: shared.includes(name) ? group : "",
        });
        expect(routed, `${name}/${jobName}`).toEqual(
          credentialed(name, job) ? baseline : { group, labels: baseline },
        );
      }
    },
  );

  it.each([
    ["openclaw-npm-release", "publish_openclaw_npm"],
    ["plugin-npm-release", "publish_plugins_npm"],
    ["plugin-clawhub-release", "approve_plugins_clawhub_release"],
    ["docker-release", "publish"],
  ])("classifies %s/%s as credentialed", (name, jobName) => {
    expect(credentialed(name, workflows.get(name)!.jobs[jobName]!)).toBe(true);
  });

  it.each([...shared, ...mixed])("keeps unrelated %s callers outside the release group", (name) => {
    const workflow = workflows.get(name)!;
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!job["runs-on"]) {
        continue;
      }
      for (const eventName of ["pull_request", "push", "schedule", "workflow_dispatch"] as const) {
        const ordinary = { ...context, eventName, releaseGate: true };
        if (name === "ci" && jobName === "pr-fail-fast" && eventName !== "pull_request") {
          expect(
            evaluateWorkflowExpression(job.if!, {
              ...ordinary,
              repository: "openclaw/openclaw",
              runAttempt: 1,
              preflightOutputs: { run_checks_node_core_nondist: "true" },
            }),
          ).toBe(false);
          continue;
        }
        expect(
          evaluateWorkflowRunner(job["runs-on"], { ...ordinary, releaseRunnerGroup: group }),
        ).toEqual(evaluateWorkflowRunner(job["runs-on"], ordinary));
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
        expect(
          evaluateWorkflowRunner(job.with?.runner_group, {
            ...releaseDispatch,
            runnerGroup: group,
          }),
          `${name}/${jobName} -> ${child}`,
        ).toBe(group);
      }
    }
  });

  it("retains the public Linux and native default labels", () => {
    expect(
      evaluateWorkflowRunner(
        Object.values(workflows.get("openclaw-release-publish")!.jobs)[0]?.["runs-on"],
        context,
      ),
    ).toBe("ubuntu-latest");
    expect(
      evaluateWorkflowRunner(
        workflows.get("full-release-validation")?.jobs.resolve_target?.["runs-on"],
        context,
      ),
    ).toBe("ubuntu-24.04");
    expect(
      evaluateWorkflowRunner(workflows.get("ci")?.jobs["macos-swift"]?.["runs-on"], context),
    ).toBe("xcode-27");
    expect(
      evaluateWorkflowRunner(workflows.get("ci")?.jobs["checks-windows"]?.["runs-on"], context),
    ).toBe("windows-2025");
  });
});
