import { readFileSync } from "node:fs";
import { minimatch } from "minimatch";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("runs synthetic Gateway startup failures with the fixture-compiled candidate", () => {
  const workflow = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
  const steps: { run?: string }[] = workflow.jobs.build.steps;
  const fixtureBuild = steps.findIndex((step) => step.run?.includes("stage_onboarding_runtime.py"));
  const packageBuild = steps.findIndex((step) => step.run?.includes("@tauri-apps/cli"));
  const failures = steps.flatMap((step, index) =>
    step.run?.includes("--local-start-failure") ? [{ script: step.run, index }] : [],
  );

  expect(fixtureBuild).toBeGreaterThanOrEqual(0);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.index).toBeGreaterThan(fixtureBuild);
  expect(failures[0]?.index).toBeLessThan(packageBuild);
  expect(failures[0]?.script).toContain("target/debug/openclaw-desktop --local-start-failure");
  expect(failures[0]?.script).not.toContain("target/release/openclaw-desktop");
});

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

it("uses fast NSIS compression only for Windows validation", () => {
  const workflow = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
  const build = workflow.jobs["test-windows-power"].steps.find((step: { run?: string }) =>
    step.run?.includes("@tauri-apps/cli"),
  );
  const override = JSON.parse(build.run.match(/--config '([^']+)'/)[1]);
  expect(override).toEqual({
    bundle: { createUpdaterArtifacts: false, windows: { nsis: { compression: "zlib" } } },
  });

  const release = parse(readFileSync(".github/workflows/linux-app-release.yml", "utf8"));
  const releaseBuild = release.jobs.build_windows.steps.find((step: { run?: string }) =>
    step.run?.includes("@tauri-apps/cli"),
  );
  const releaseOverride = JSON.parse(
    releaseBuild.run.match(/--config "(.+)"/)[1].replaceAll('\\"', '"'),
  );
  expect(releaseOverride.bundle.windows?.nsis?.compression).toBeUndefined();
  const config = JSON.parse(readFileSync("apps/linux/src-tauri/tauri.conf.json", "utf8"));
  expect(config.bundle.windows?.nsis?.compression).toBeUndefined();
});

it("uses runtime-only staging before the Linux fixture supplies its package", () => {
  const workflow = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
  const build = workflow.jobs.build.steps.find(
    (step: { name: string }) => step.name === "Build native inline browser candidate",
  );
  expect(build.run).toContain("node ../scripts/stage-runtime.mjs --runtime-only");
  expect(build.env?.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS).toBeUndefined();
  const config = JSON.parse(readFileSync("apps/linux/src-tauri/tauri.conf.json", "utf8"));
  expect(config.build.beforeBuildCommand.script).toBe("node scripts/stage-runtime.mjs");
  expect(config.build.beforeDevCommand.script).toBe("node scripts/stage-runtime.mjs");
});

it("budgets source packaging within the Windows installer job", () => {
  const workflow = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
  const job = workflow.jobs["test-windows-power"];
  const build = job.steps.find(
    (step: { name: string }) => step.name === "Build Windows installer without publishing",
  );
  const packageMinutes = Number(build.env?.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS) / 60_000;

  expect(packageMinutes).toBeGreaterThanOrEqual(60);
  expect(job["timeout-minutes"] - packageMinutes).toBeGreaterThanOrEqual(40);
  expect(workflow.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS).toBeUndefined();
});
