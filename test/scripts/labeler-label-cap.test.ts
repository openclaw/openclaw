import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compileFunction, constants } from "node:vm";
import { expect, it, vi } from "vitest";
import { parse } from "yaml";
import { withEnvAsync } from "../../src/test-utils/env.js";

type WorkflowJob = { steps: Array<{ name?: string; with?: { script?: string } }> };

const workflow = parse(readFileSync(".github/workflows/labeler.yml", "utf8")) as {
  jobs: Record<string, WorkflowJob> & { label: WorkflowJob };
};
const require = createRequire(import.meta.url);

const githubError = (message: string, status: number) =>
  Object.assign(new Error(message), { status });

function compileStep(name: string) {
  const script = workflow.jobs.label.steps.find((step) => step.name === name)?.with?.script;
  assert.ok(script, `missing workflow script: ${name}`);
  return compileFunction(
    `return (async () => {\n${script}\n})();`,
    ["context", "core", "github", "require"],
    { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  ) as (context: unknown, core: unknown, github: unknown, require: NodeJS.Require) => Promise<void>;
}
const executeSizeLabel = compileStep("Apply PR size label");
const executeMaintainerLabel = compileStep("Apply maintainer or trusted-contributor label");

function labelFixture(labelNames: string[], addError?: Error, execute = executeSizeLabel) {
  const labels = new Set(labelNames);
  const core = { warning: vi.fn() };
  const issues = {
    getLabel: vi.fn(),
    listLabelsOnIssue: vi.fn(),
    removeLabel: vi.fn(async ({ name }: { name: string }) => {
      labels.delete(name);
    }),
    addLabels: vi.fn(async ({ labels: added }: { labels: string[] }) => {
      if (addError) {
        throw addError;
      }
      if (new Set([...labels, ...added]).size > 100) {
        throw githubError("Validation Failed: Issues cannot have more than 100 labels", 422);
      }
      for (const name of added) {
        labels.add(name);
      }
    }),
  };
  const teams = {
    getMembershipForUserInOrg: vi.fn().mockResolvedValue({ data: { state: "active" } }),
  };
  const github = {
    rest: { issues, teams, pulls: { listFiles: vi.fn() } },
    paginate: async (endpoint: unknown) =>
      endpoint === issues.listLabelsOnIssue
        ? [...labels].map((name) => ({ name }))
        : [{ filename: "src/example.ts", additions: 60, deletions: 0 }],
  };
  const context = {
    repo: { owner: "openclaw", repo: "openclaw" },
    payload: { pull_request: { number: 1, user: { login: "contributor" } } },
  };
  const run = () =>
    withEnvAsync({ GITHUB_WORKSPACE: process.cwd() }, () =>
      execute(context, core, github, require),
    );
  return { run, labels, issues, teams, core };
}

const areaLabels = (count: number) => Array.from({ length: count }, (_, index) => `area: ${index}`);

it("warns and succeeds without adding a label when all 100 slots are occupied", async () => {
  const fixture = labelFixture(areaLabels(100));
  await expect(fixture.run()).resolves.toBeUndefined();
  expect(fixture.issues.addLabels).toHaveBeenCalledOnce();
  expect(fixture.labels.size).toBe(100);
  expect(fixture.core.warning).toHaveBeenCalledWith(expect.stringMatching(/size: S.*100/));
});

it.each(["size: XS", "size: S"])("replaces %s within the label cap", async (sizeLabel) => {
  const fixture = labelFixture([...areaLabels(99), sizeLabel]);
  await fixture.run();
  expect(fixture.labels).toEqual(new Set([...areaLabels(99), "size: S"]));
  expect(fixture.core.warning).not.toHaveBeenCalled();
});
it("does not label a non-member", async () => {
  const fixture = labelFixture([], undefined, executeMaintainerLabel);
  fixture.teams.getMembershipForUserInOrg.mockRejectedValue(githubError("Not Found", 404));
  await fixture.run();
  expect(fixture.issues.addLabels).not.toHaveBeenCalled();
  expect(fixture.core.warning).not.toHaveBeenCalled();
});
it.each<[number, typeof executeSizeLabel, string]>([
  [422, executeSizeLabel, "Validation Failed: label does not exist"],
  [403, executeMaintainerLabel, "Resource not accessible by integration"],
])("propagates API %i errors", async (status, execute, message) => {
  const error = githubError(message, status);
  const fixture = labelFixture([], error, execute);
  await expect(fixture.run()).rejects.toBe(error);
  expect(fixture.core.warning).not.toHaveBeenCalled();
});

it("every label-adding site routes through addLabelsWithinCap", () => {
  // The helper owns the 100-label cap; a new raw call would restore the red check from PR #137506.
  const rawCalls = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .flatMap((step) => (step.with?.script ?? "").split("\n"))
    .filter((line) => !line.trim().startsWith("//") && line.includes("issues.addLabels("));
  expect(rawCalls).toEqual([]);
});
