import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

type Step = { uses?: string; with?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

it.each([
  [
    "ci.yml",
    [
      "check-plan",
      "check-shard",
      "check-lint-hosted-core-shard",
      "check-lint-hosted-extension-shard",
      "check-test-types-hosted-core-shard",
      "check-additional-shard",
      "checks-node-core-test-nondist-shard",
      "checks-node-compat",
      "checks-fast-core",
    ],
    "true",
  ],
  ["vitest-cache-warm.yml", ["warm"], "true"],
  ["ci-check-testbox.yml", ["check"], "true"],
  ["ci.yml", ["control-ui-performance", "check-docs"], undefined],
] as const)(
  "limits kernel containment to semantic CI jobs in %s: %j",
  (file, jobs, semanticChecks) => {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8")) as Workflow;
    for (const job of jobs) {
      const setup = workflow.jobs[job]!.steps.find((step) =>
        step.uses?.endsWith("/setup-node-env"),
      );
      expect(setup, job).toBeDefined();
      expect(setup?.with?.["semantic-checks"], job).toBe(semanticChecks);
    }
  },
);

it("keeps privileged provisioning in opted-in Linux CI setup", () => {
  const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
  expect(action.inputs["semantic-checks"].default).toBe("false");
  const setup = action.runs.steps.find((step: { run?: string }) =>
    step.run?.includes("loginctl enable-linger"),
  );
  expect(setup.if).toBe("runner.os == 'Linux' && inputs.semantic-checks == 'true'");
  expect(setup.shell).toBe("bash");
  const script = readFileSync(".github/actions/setup-node-env/semantic-memory.sh", "utf8");
  expect(setup.run).toBe(script.split("\n").slice(1).join("\n"));
  expect(script).toContain("--property=MemoryMax=67108864 --property=MemorySwapMax=0");
  expect(script).toContain("--property=OOMPolicy=kill --property=RuntimeMaxSec=10");
  expect(script).toContain('test "$(cat "/sys/fs/cgroup$group/memory.max")" = 67108864');
  expect(script).toContain('test "$(cat "/sys/fs/cgroup$group/memory.swap.max")" = 0');
  expect(script).toContain('test "$(cat "/sys/fs/cgroup$group/memory.oom.group")" = 1');
});

it.runIf(process.platform !== "win32")("rejects an unsupported runner with setup guidance", () => {
  const script = [
    "ps() { printf 'not-systemd\\n'; }",
    "sudo() { echo 'unexpected sudo' >&2; return 99; }",
    readFileSync(".github/actions/setup-node-env/semantic-memory.sh", "utf8"),
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("::error::Semantic checks require systemd");
  expect(result.stderr).toContain("https://docs.openclaw.ai/ci");
  expect(result.stderr).not.toContain("unexpected sudo");
});

it("qualifies tagged source with the workflow-pinned containment script", () => {
  const workflow = parse(readFileSync(".github/workflows/openclaw-npm-preflight.yml", "utf8"));
  const steps = workflow.jobs.check_openclaw_npm.steps;
  const source = steps.find((step: { name?: string }) => step.name === "Checkout");
  const harness = steps.find(
    (step: { name?: string }) => step.name === "Checkout trusted package source preflight",
  );
  const probe = steps.find(
    (step: { name?: string }) => step.name === "Prepare semantic check containment",
  );
  const setup = steps.find((step: { name?: string }) => step.name === "Setup Node environment");
  expect(source.with.ref).toBe("${{ inputs.tag }}");
  expect(harness.with.ref).toBe("${{ github.workflow_sha }}");
  expect(harness.with.path).toBe(".release-harness");
  expect(harness.with["sparse-checkout"].split("\n")).toContain(".github/actions/setup-node-env");
  expect(probe.run).toBe("bash .release-harness/.github/actions/setup-node-env/semantic-memory.sh");
  expect(steps.indexOf(harness)).toBeLessThan(steps.indexOf(probe));
  expect(steps.indexOf(probe)).toBeLessThan(steps.indexOf(setup));
  expect(setup.with["semantic-checks"]).toBeUndefined();
});
