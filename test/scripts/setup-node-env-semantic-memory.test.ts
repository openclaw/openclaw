import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

type Step = { uses?: string; with?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

it.each([
  [
    "ci.yml",
    [
      "check-shard",
      "check-lint-hosted-core-shard",
      "check-lint-hosted-extension-shard",
      "check-test-types-hosted-core-shard",
      "check-additional-shard",
      "checks-node-core-test-nondist-shard",
      "checks-node-compat",
      "checks-fast-core",
    ],
  ],
  ["vitest-cache-warm.yml", ["warm"]],
  ["openclaw-npm-preflight.yml", ["check_openclaw_npm"]],
  ["ci-check-testbox.yml", ["check"]],
] as const)("opts semantic CI jobs into kernel containment in %s", (file, jobs) => {
  const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8")) as Workflow;
  for (const job of jobs) {
    const setup = workflow.jobs[job]!.steps.find((step) => step.uses?.endsWith("/setup-node-env"));
    expect(setup?.with?.["semantic-checks"], job).toBe("true");
  }
});

it("leaves ordinary Linux setup outside privileged semantic provisioning", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as Workflow;
  for (const job of ["control-ui-performance", "check-docs"]) {
    const setup = workflow.jobs[job]!.steps.find((step) => step.uses?.endsWith("/setup-node-env"));
    expect(setup, job).toBeDefined();
    expect(setup?.with?.["semantic-checks"], job).toBeUndefined();
  }
});

it("keeps privileged provisioning in opted-in Linux CI setup", () => {
  const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
  expect(action.inputs["semantic-checks"].default).toBe("false");
  const setup = action.runs.steps.find((step: { run?: string }) =>
    step.run?.includes("prepare-semantic-checks.sh"),
  );
  expect(setup.if).toBe("runner.os == 'Linux' && inputs.semantic-checks == 'true'");
  expect(setup.run).toBe('bash "$GITHUB_ACTION_PATH/prepare-semantic-checks.sh"');
});
