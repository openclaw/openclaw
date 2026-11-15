import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
) as { jobs: Record<string, { steps: { name?: string; if?: string; uses?: string }[] }> };

it.each([
  "validate_docker_e2e",
  "validate_docker_lanes",
  "validate_live_provider_suites",
  "validate_live_docker_provider_suites",
])("reclaims disk before setup only on selected hosted Linux jobs: %s", (job) => {
  const steps = workflow.jobs[job]!.steps;
  const cleanupIndex = steps.findIndex((step) => step.name === "Reclaim hosted runner disk");
  expect(cleanupIndex).toBeGreaterThanOrEqual(0);
  const cleanup = steps[cleanupIndex]!;
  const setupIndex = steps.findIndex((step) => step.uses?.includes("setup-"));
  expect(cleanupIndex).toBeLessThan(setupIndex);
  const admitted = (environment: string, os: string, selected = true, filter = "") =>
    runInNewContext(cleanup.if!, {
      runner: { environment, os },
      inputs: { release_test_profile: "stable", live_suite_filter: filter },
      matrix: {
        profiles: selected ? "stable full" : "full",
        suite_id: "selected-suite",
        suite_group: "selected-group",
      },
      steps: { selection: { outputs: { run: selected ? "true" : "" } } },
      contains: (value: string, search: string) => value.includes(search),
    });
  expect(admitted("github-hosted", "Linux")).toBe(true);
  expect(admitted("self-hosted", "Linux")).toBe(false);
  expect(admitted("github-hosted", "Windows")).toBe(false);
  expect(admitted("github-hosted", "macOS")).toBe(false);
  // Targeted Docker lanes are selected at the job boundary, not per step.
  if (job !== "validate_docker_lanes") {
    expect(admitted("github-hosted", "Linux", false)).toBe(false);
  }
  if (job === "validate_live_docker_provider_suites") {
    expect(admitted("github-hosted", "Linux", true, "unrelated-suite")).toBe(false);
    expect(admitted("github-hosted", "Linux", true, "selected-suite")).toBe(true);
    expect(admitted("github-hosted", "Linux", true, "selected-group")).toBe(true);
  }
});
