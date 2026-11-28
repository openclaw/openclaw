import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("keeps Mantis Slack dependency caching owned by shared setup", () => {
  const workflow = parse(readFileSync(".github/workflows/mantis-slack-desktop-smoke.yml", "utf8"));
  const steps = workflow.jobs.run_slack_desktop.steps as Array<{
    name: string;
    uses?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
  }>;
  const setupIndex = steps.findIndex((step) => step.uses === "./.github/actions/setup-node-env");
  const candidateIndex = steps.findIndex((step) => step.name === "Prepare candidate worktree");
  const candidate = steps[candidateIndex];

  expect(steps[setupIndex]?.with?.["cache-mode"]).toBe("restore");
  expect(candidateIndex).toBeGreaterThan(setupIndex);
  // Shared setup owns the workspace store used by both installs; a second
  // cache action can restore unused home paths or create a competing writer.
  expect(steps.filter((step) => step.uses?.startsWith("actions/cache"))).toEqual([]);
  expect(candidate?.env).not.toHaveProperty("PNPM_CONFIG_STORE_DIR");
  expect(candidate?.env).not.toHaveProperty("PNPM_CONFIG_CACHE_DIR");
});
