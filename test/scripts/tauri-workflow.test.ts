import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { minimatch } from "minimatch";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

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

it("removes uploaded Linux bundles while preserving Cargo inputs and compiler output", async () => {
  const steps = workflow.jobs.build.steps;
  const cleanup = steps.at(-1);
  expect(cleanup.name).toBe("Remove uploaded Linux bundles before caching");
  expect(cleanup.if).toBeUndefined();
  expect(cleanup["working-directory"]).toBe("apps/linux/src-tauri");
  expect(steps.at(-2).name).toBe("Upload bundles");
  const cache = steps.find((step: Step) => step.name === "Cache Cargo").with;
  expect(cache.key).toBe(
    "linux-app-v2-${{ runner.os }}-${{ hashFiles('apps/linux/src-tauri/Cargo.lock') }}",
  );
  expect(cache["restore-keys"].trim()).toBe("linux-app-v2-${{ runner.os }}-");

  await withTempDir("openclaw-linux-cargo-cache-", async (root) => {
    const removed = ["target/release/bundle/appimage/desktop.AppImage"];
    const retained = [
      "target/desktop-runtime/manifest.json",
      "target/desktop-runtime/package/openclaw.mjs",
      "target/debug/desktop-runtime/manifest.json",
      "target/debug/deps/compiled",
      "target/debug/build/build-script",
      "target/debug/.fingerprint/compiled",
      "target/debug/incremental/compiled",
      "target/release/deps/compiled",
      "target/release/openclaw-desktop",
      "target/release/desktop-runtime/manifest.json",
      "target/installers/install-cli.sh",
    ];
    const cwd = join(root, cleanup["working-directory"]);
    for (const file of [...removed, ...retained]) {
      const target = join(cwd, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "cached payload");
    }
    execSync(cleanup.run, { cwd });
    for (const file of removed) {
      expect(existsSync(join(cwd, file)), file).toBe(false);
    }
    for (const file of retained) {
      expect(readFileSync(join(cwd, file), "utf8"), file).toBe("cached payload");
    }
  });
});

it("stops Windows boundary checks when the Node fixtures fail", () => {
  const boundary = windowsJob.steps.find(
    (step: Step) => step.name === "Verify Windows runtime, installer, and desktop boundaries",
  );
  expect(boundary.run.trim().split("\n")).toEqual([
    "node --test ../scripts/test-stage-runtime.mjs ../scripts/test-stage-package.mjs",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "cargo +stable test --locked --bin openclaw-desktop",
  ]);
});

it("keeps macOS Cargo setup separate from packaging dependencies", () => {
  const job = workflow.jobs["test-macos"];
  const nodeSetup = job.steps.find((step: Step) => step.name === "Setup Node.js");
  expect(setupStep("test-macos")).toBeUndefined();
  expect(nodeSetup.shell).toBe("/bin/bash -e {0}");
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
  [["test/scripts/stage-openclaw-bun.test.ts"], false],
  [["test/scripts/actions-artifact-zip.test-support.ts"], false],
  [
    [
      "test/scripts/stage-openclaw-bun.test.ts",
      "test/scripts/actions-artifact-zip.test-support.ts",
    ],
    false,
  ],
  [["test/scripts/stage-openclaw-bun.test.ts", "scripts/stage-openclaw-bun.sh"], true],
  [["test/scripts/stage-openclaw-bun.test.ts", "scripts/lib/openclaw-bun.json"], true],
  [["test/scripts/stage-openclaw-bun.test.ts", "apps/linux/scripts/test-stage-runtime.mjs"], true],
  [["test/scripts/stage-openclaw-bun.test.ts", "apps/linux/src-tauri/src/main.rs"], true],
  [[".github/workflows/linux-app.yml"], true],
  [[".github/workflows/linux-app-release.yml"], true],
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
