import { readFileSync } from "node:fs";
import { minimatch } from "minimatch";
import { expect, it } from "vitest";
import { parse } from "yaml";

it.each([
  [["apps/linux/README.md"], false],
  [["apps/linux/omarchy/README.md"], false],
  [["apps/linux/README.md", "apps/linux/src-tauri/src/main.rs"], true],
  [["apps/linux/ui/index.html"], true],
  [["apps/linux/src-tauri/resources/README.md"], true],
  [["scripts/stage-openclaw-bun.sh"], true],
  [[".github/workflows/linux-app.yml"], true],
] as const)("selects Linux app CI for %j: %s", (files, expected) => {
  const workflow = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
  const patterns: string[] = workflow.on.pull_request.paths;
  const selected = files.some((file) =>
    patterns.reduce((included, pattern) => {
      const excluded = pattern.startsWith("!");
      return minimatch(file, excluded ? pattern.slice(1) : pattern) ? !excluded : included;
    }, false),
  );
  expect(selected).toBe(expected);
  expect(workflow.on).toHaveProperty("workflow_dispatch");
});

it.each(["build_linux", "build_windows", "build_macos"])(
  "passes the verified release identity to %s despite tagless checkout",
  (job) => {
    const workflow = parse(readFileSync(".github/workflows/linux-app-release.yml", "utf8"));
    const steps = workflow.jobs[job].steps;
    const build = steps.find((step: { run?: string }) => step.run?.includes("@tauri-apps/cli"));
    expect(build.env).toMatchObject({
      RELEASE_TAG: "${{ needs.validate_release.outputs.release_tag }}",
      RELEASE_SHA: "${{ needs.validate_release.outputs.tag_sha }}",
    });
  },
);

it("budgets Windows source packaging within the desktop job", () => {
  const workflow = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
  const windows = workflow.jobs["test-windows-power"];
  const build = windows.steps.find(
    (step: { name: string }) => step.name === "Build Windows installer without publishing",
  );
  const packageMinutes = Number(build.env?.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS) / 60_000;

  expect(packageMinutes).toBeGreaterThanOrEqual(60);
  expect(windows["timeout-minutes"] - packageMinutes).toBeGreaterThanOrEqual(40);
  expect(workflow.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS).toBeUndefined();
  expect(JSON.stringify(workflow.jobs.build)).not.toContain(
    "OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS",
  );
});
