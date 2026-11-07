import { expect, it } from "vitest";
import { evaluateWorkflowRunner as runner, readWorkflow } from "./ci-workflow.test-support.js";

type Job = {
  "runs-on"?: string;
  uses?: string;
  with?: Record<string, unknown>;
  steps?: { uses?: string; if?: string; with?: Record<string, unknown> }[];
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

// Artifact-owned work must not inherit a self-hosted release reservation.
it("keeps artifact producers and FRV plugin consumers on hosted runners", () => {
  const artifacts = workflow("full-release-artifacts");
  const candidate = workflow("full-release-candidate");
  const plugins = workflow("plugin-prerelease");
  expect(artifacts.jobs.npm!.with?.use_github_hosted_runners).toBe(true);
  expect(artifacts.jobs.docker!.with?.use_github_hosted_runners).toBe(true);
  expect(candidate.jobs.prepare!.with?.use_github_hosted_runners).toBe(true);
  expect(plugins.jobs["plugin-prerelease-docker-suite"]!.with?.use_github_hosted_runners).toBe(
    true,
  );
  for (const source of [artifacts, candidate, plugins]) {
    for (const job of Object.values(source.jobs)) {
      if (job["runs-on"]) {
        expect(
          runner(job["runs-on"], {
            ...reserved,
            runnerBackend: "hybrid",
            inputs: { full_release_validation: true },
          }),
        ).toBe("ubuntu-24.04");
      }
    }
  }
});

it("lets explicit hosted selection override groups without changing unselected callers", () => {
  for (const name of [
    "openclaw-npm-preflight",
    "openclaw-live-and-e2e-checks-reusable",
    "openclaw-repo-e2e-reusable",
    "docker-release-prepare",
  ]) {
    const labels =
      name === "docker-release-prepare" ? ["ubuntu-24.04", "ubuntu-24.04-arm"] : ["ubuntu-24.04"];
    for (const [jobName, job] of Object.entries(workflow(name).jobs)) {
      if (!job["runs-on"]) {
        continue;
      }
      for (const label of labels) {
        const selection = {
          ...reserved,
          runnerBackend: "hybrid" as const,
          matrix: { runner: label },
        };
        const expected =
          name === "docker-release-prepare" && jobName === "build" ? label : "ubuntu-24.04";
        expect(runner(job["runs-on"], { ...selection, useGithubHostedRunners: true }), name).toBe(
          expected,
        );
        const unreserved = runner(job["runs-on"], {
          ...selection,
          releaseRunnerGroup: "",
          runnerGroup: "",
        });
        expect(runner(job["runs-on"], selection), name).toEqual({ group, labels: unreserved });
      }
    }
  }
  for (const job of Object.values(workflow("plugin-prerelease").jobs)) {
    if (job["runs-on"]) {
      expect(runner(job["runs-on"], reserved)).toEqual({ group, labels: "ubuntu-24.04" });
    }
  }
});

it.each([false, true])(
  "builds live image artifacts with the selected builder (hosted=%s)",
  (hosted) => {
    const steps = workflow("openclaw-live-and-e2e-checks-reusable").jobs.prepare_live_test_image!
      .steps!;
    const selected = steps
      .filter((step) => step.uses?.startsWith("docker/") || step.uses?.startsWith("useblacksmith/"))
      .filter((step) =>
        runner("${{ " + step.if + " }}", {
          ...reserved,
          useGithubHostedRunners: hosted,
          inputs: { shared_image_policy: "no-push-artifact" },
        }),
      );
    expect(selected.map((step) => step.uses!.split("@")[0])).toEqual(
      hosted
        ? ["docker/setup-buildx-action", "docker/build-push-action"]
        : ["useblacksmith/setup-docker-builder", "useblacksmith/build-push-action"],
    );
    expect(selected[1]!.with).toMatchObject({
      load: true,
      push: false,
      provenance: false,
      sbom: false,
    });
  },
);
