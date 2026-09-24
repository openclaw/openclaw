import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { evaluateWorkflowRunner } from "./ci-workflow.test-support.js";

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
];
const mixed = ["ci", "openclaw-performance"];
type Job = { "runs-on"?: string; uses?: string; with?: Record<string, string> };
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

describe("release runner reservation", () => {
  it.each([...workflows])(
    "routes every %s worker while preserving its selected labels",
    (name, workflow) => {
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (!job["runs-on"]) {
          continue;
        }
        const baseline = evaluateWorkflowRunner(job["runs-on"], context);
        expect(baseline, `${name}/${jobName}`).toBeTypeOf("string");
        expect(baseline).not.toBe("");
        expect(
          evaluateWorkflowRunner(job["runs-on"], {
            ...context,
            releaseRunnerGroup: group,
            runnerGroup: shared.includes(name) ? group : "",
            dispatchId: "full-release-validation-123-1",
          }),
          `${name}/${jobName}`,
        ).toEqual({ group, labels: baseline });
      }
    },
  );

  it.each([...shared, ...mixed])("keeps unrelated %s callers outside the release group", (name) => {
    const workflow = workflows.get(name)!;
    for (const job of Object.values(workflow.jobs)) {
      if (!job["runs-on"]) {
        continue;
      }
      for (const eventName of ["pull_request", "push", "schedule", "workflow_dispatch"] as const) {
        const ordinary = { ...context, eventName, releaseGate: true };
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
            ...context,
            runnerGroup: group,
            releaseRunnerGroup: group,
            dispatchId: "full-release-validation-123-1",
          }),
          `${name}/${jobName} -> ${child}`,
        ).toBe(group);
      }
    }
  });

  it("retains the public Linux and native default labels", () => {
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
