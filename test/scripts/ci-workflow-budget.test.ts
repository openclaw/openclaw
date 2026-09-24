import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  readWorkflow,
  readWorkflowOutputs,
  runWorkflowShellScript,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ProfileOptions = {
  eventName: "pull_request" | "push" | "workflow_dispatch";
  configured?: string;
  requested?: string;
  qualification?: boolean;
  repository?: string;
  headRepository?: string;
  authorAssociation?: string;
  runAttempt?: number;
};

function resolveProfile(options: ProfileOptions) {
  const outputPath = join(tempDirs.make("openclaw-budget-profile-"), "outputs");
  const step = expectDefined(
    readCiWorkflow().jobs.preflight.steps.find(
      (candidate: WorkflowStep) => candidate.name === "Resolve logical runner profile",
    ),
    "runner profile step",
  );
  const result = runWorkflowShellScript(expectDefined(step.run, "runner profile script"), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTHOR_ASSOCIATION: options.authorAssociation ?? "CONTRIBUTOR",
      CONFIGURED_RUNNER_PROFILE: options.configured ?? "budgeted",
      GITHUB_EVENT_NAME: options.eventName,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: options.repository ?? "openclaw/openclaw",
      GITHUB_RUN_ATTEMPT: String(options.runAttempt ?? 1),
      HEAD_REPOSITORY: options.headRepository ?? "openclaw/openclaw",
      REQUESTED_RUNNER_PROFILE: options.requested ?? "default",
      QUALIFICATION_DISPATCH: String(options.qualification ?? false),
      CI_SHAPE: "default",
    },
  });
  return {
    status: result.status,
    diagnostic: `${result.stdout}${result.stderr}`,
    outputs: readWorkflowOutputs(outputPath),
  };
}

describe("budgeted CI routing", () => {
  it.each([
    ["openclaw/openclaw", "refs/heads/main", true],
    ["openclaw/openclaw", "refs/heads/qualification", false],
    ["contributor/fork", "refs/heads/main", false],
  ] as const)(
    "restricts the credentialed publisher to canonical main: %s %s",
    (repository, ref, allowed) => {
      const publisher = readWorkflow(".github/workflows/ci-blacksmith-budget.yml").jobs.meter;
      expect(
        evaluateWorkflowExpression(`\${{ ${publisher.if} }}`, {
          repository,
          ref,
          eventName: "workflow_dispatch",
          runnerBackend: "hybrid",
          runAttempt: 1,
        }),
      ).toBe(allowed);
      expect(publisher["runs-on"]).toBe("ubuntu-24.04");
    },
  );

  it.each([
    { eventName: "push", nodeBackend: "budgeted" },
    { eventName: "pull_request", nodeBackend: "budgeted" },
    { eventName: "pull_request", headRepository: "contributor/fork", nodeBackend: "github" },
    { eventName: "pull_request", authorAssociation: "FIRST_TIMER", nodeBackend: "github" },
    { eventName: "push", repository: "contributor/fork", nodeBackend: "github" },
    { eventName: "pull_request", runAttempt: 2, nodeBackend: "github" },
    { eventName: "workflow_dispatch", nodeBackend: "github" },
    {
      eventName: "workflow_dispatch",
      configured: "hybrid",
      requested: "budgeted",
      qualification: true,
      nodeBackend: "budgeted",
    },
  ] satisfies (ProfileOptions & { nodeBackend: string })[])(
    "uses the hosted plan with eligible paid exceptions for %j",
    ({ nodeBackend, ...options }) => {
      const result = resolveProfile(options);
      expect(result.status, result.diagnostic).toBe(0);
      expect(result.outputs).toMatchObject({
        budgeted: "true",
        effective_runner_backend: "github",
        runner_profile: "github",
        node_runner_backend: nodeBackend,
      });
    },
  );

  it("rejects a budgeted dispatch override without qualification admission", () => {
    const result = resolveProfile({
      eventName: "workflow_dispatch",
      configured: "hybrid",
      requested: "budgeted",
    });
    expect(result.status).not.toBe(0);
    expect(result.diagnostic).toContain("overrides require an admitted CI qualification");
    expect(result.outputs).toEqual({});
  });

  it("uses hosted routing when a fork cannot read the backend variable", () => {
    const workflow = readCiWorkflow();
    const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
      eventName: "pull_request",
      repository: "openclaw/openclaw",
      headRepository: "contributor/fork",
      authorAssociation: "CONTRIBUTOR",
      runnerBackend: "",
      runAttempt: 1,
      matrix: { runner: "blacksmith-32vcpu-ubuntu-2404", task: "control-ui", shard: 1 },
    };
    expect(evaluateWorkflowExpression(workflow.jobs.preflight["runs-on"], context)).toBe(
      "ubuntu-24.04",
    );
    const result = resolveProfile({
      eventName: "pull_request",
      configured: "",
      headRepository: "contributor/fork",
    });
    expect(result.status, result.diagnostic).toBe(0);
    expect(result.outputs).toMatchObject({
      budgeted: "false",
      runner_profile: "github",
      node_runner_backend: "github",
      effective_runner_backend: "github",
    });
    for (const name of Object.keys(workflow.jobs)) {
      if (name === "preflight") {
        continue;
      }
      const runner = workflow.jobs[name]["runs-on"];
      if (typeof runner !== "string") {
        continue;
      }
      const resolved = runner.startsWith("${{")
        ? evaluateWorkflowExpression(runner, { ...context, preflightOutputs: result.outputs })
        : runner;
      expect(String(resolved), name).not.toMatch(/^(?:blacksmith-|runs-on=)/u);
    }
  });

  it.each(["", "github", "hybrid", "blacksmith", "runson"])(
    "retains the existing configured backend (%j)",
    (configured) => {
      const result = resolveProfile({ eventName: "pull_request", configured });
      expect(result.status, result.diagnostic).toBe(0);
      const backend = configured || "blacksmith";
      expect(result.outputs).toMatchObject({
        budgeted: "false",
        effective_runner_backend: backend,
        runner_profile: backend === "runson" ? "hybrid" : backend,
        node_runner_backend: backend,
      });
    },
  );

  it.each(
    (["push", "pull_request"] as const).flatMap((eventName) =>
      ["true", "false", ""]
        .map((blacksmithAllowed) => ({ eventName, blacksmithAllowed, runAttempt: 1 }))
        .concat({ eventName, blacksmithAllowed: "true", runAttempt: 2 }),
    ),
  )(
    "limits Blacksmith to metered main Windows for $eventName attempt $runAttempt with admission $blacksmithAllowed",
    ({ eventName, blacksmithAllowed, runAttempt }) => {
      // Failed-job-only retries retain the original preflight outputs.
      const result = resolveProfile({ eventName });
      expect(result.status, result.diagnostic).toBe(0);
      const workflow = readCiWorkflow();
      const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
        eventName,
        repository: "openclaw/openclaw",
        runAttempt,
        runId: 12345,
        preflightOutputs: {
          ...result.outputs,
          blacksmith_allowed: blacksmithAllowed,
        },
        matrix: { runner: "blacksmith-32vcpu-ubuntu-2404", task: "control-ui", shard: 1 },
      };
      const blacksmithJobs: string[] = [];
      const runsonJobs: string[] = [];
      for (const name of Object.keys(workflow.jobs)) {
        if (name === "preflight") {
          continue;
        }
        const runner = workflow.jobs[name]["runs-on"];
        if (typeof runner !== "string") {
          continue;
        }
        const resolved = runner.startsWith("${{")
          ? evaluateWorkflowExpression(runner.replaceAll("fromJson(", "fromJSON("), context)
          : runner;
        if (String(resolved).startsWith("blacksmith-")) {
          blacksmithJobs.push(name);
        }
        if (String(resolved).startsWith("runs-on=")) {
          runsonJobs.push(name);
          expect(String(resolved), name).toContain("spot=false/retry=false");
        }
        if (runAttempt > 1) {
          expect(String(resolved), name).not.toContain("runs-on=");
        }
      }
      expect(blacksmithJobs).toEqual(
        blacksmithAllowed === "true" && eventName === "push" && runAttempt === 1
          ? ["checks-windows"]
          : [],
      );
      expect(runsonJobs).toEqual(
        runAttempt === 1 ? ["build-artifacts", "checks-ui-e2e", "checks-ui-e2e-real-gateway"] : [],
      );
      expect(
        evaluateWorkflowExpression(
          workflow.jobs["checks-node-core-test-nondist-shard"]["runs-on"],
          context,
        ),
      ).toBe("ubuntu-24.04");
      for (const name of ["qa-smoke-ci-profile", "docker-seed-e2e"]) {
        expect(evaluateWorkflowExpression(workflow.jobs[name]["runs-on"], context), name).toBe(
          "ubuntu-24.04",
        );
      }
      for (const name of ["build-artifacts", "checks-ui-e2e-real-gateway"]) {
        const labels = evaluateWorkflowExpression(workflow.jobs[name]["runs-on"], context);
        if (runAttempt === 1) {
          expect(labels).toContain("runs-on");
          expect(labels).toContain("cpu=8");
          expect(labels).toContain("ram=32");
        } else {
          expect(labels).toBe("ubuntu-24.04");
        }
      }
    },
  );
});
