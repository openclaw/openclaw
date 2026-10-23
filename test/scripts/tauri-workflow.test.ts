import { readFileSync } from "node:fs";
import { minimatch } from "minimatch";
import { expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
const release = parse(readFileSync(".github/workflows/linux-app-release.yml", "utf8"));
const config = JSON.parse(readFileSync("apps/linux/src-tauri/tauri.conf.json", "utf8"));
type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string> };
const buildStep = (steps: Step[]) => steps.find((step) => step.run?.includes("@tauri-apps/cli"))!;
const setupStep = (job: string) =>
  workflow.jobs[job].steps.find((step: Step) => step.uses === "./.github/actions/setup-node-env");
const windowsJob = workflow.jobs["test-windows-power"];
const windowsBuild = buildStep(windowsJob.steps);
const override = (step: Step) =>
  JSON.parse(step.run!.match(/--config (['"])(.+)\1/)![2]!.replaceAll('\\"', '"'));

it("keeps Node without workspace dependencies for the macOS Cargo tests", () => {
  const job = workflow.jobs["test-macos"];
  expect(setupStep("test-macos").with).toMatchObject({
    "cache-mode": "off",
    "install-bun": "false",
    "install-deps": "false",
  });
  expect(job.steps.at(-1).run).toBe("cargo +stable test --locked --all-targets");
  for (const name of ["build", "test-windows-power"]) {
    expect(setupStep(name).with["install-deps"]).not.toBe("false");
  }
});

it("runs synthetic Gateway startup failures with the fixture-compiled candidate", () => {
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
    expect(buildStep(release.jobs[job].steps).env).toMatchObject({
      RELEASE_TAG: "${{ needs.validate_release.outputs.release_tag }}",
      RELEASE_SHA: "${{ needs.validate_release.outputs.tag_sha }}",
    });
  },
);

it("uses fast NSIS compression only for Windows validation", () => {
  expect(override(windowsBuild)).toEqual({
    bundle: { createUpdaterArtifacts: false, windows: { nsis: { compression: "zlib" } } },
  });

  const releaseOverride = override(buildStep(release.jobs.build_windows.steps));
  expect(releaseOverride.bundle.windows?.nsis?.compression).toBeUndefined();
  expect(config.bundle.windows?.nsis?.compression).toBeUndefined();
});

it("uses runtime-only staging before the Linux fixture supplies its package", () => {
  const build = workflow.jobs.build.steps.find(
    (step: { name: string }) => step.name === "Build native inline browser candidate",
  );
  expect(build.run).toContain("node ../scripts/stage-runtime.mjs --runtime-only");
  expect(build.env?.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS).toBeUndefined();
  expect(config.build).toMatchObject({
    beforeBuildCommand: { script: "node scripts/stage-runtime.mjs" },
    beforeDevCommand: { script: "node scripts/stage-runtime.mjs" },
  });
});

it("budgets source packaging within the Windows installer job", () => {
  const packageMinutes =
    Number(windowsBuild.env?.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS) / 60_000;

  expect(packageMinutes).toBeGreaterThanOrEqual(60);
  expect(windowsJob["timeout-minutes"] - packageMinutes).toBeGreaterThanOrEqual(40);
  expect(workflow.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS).toBeUndefined();
});
