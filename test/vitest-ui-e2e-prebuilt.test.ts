import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "../scripts/lib/local-build-metadata.mts";
import { writeUpdateCompatibilityChunks } from "../scripts/lib/update-compat-chunks.mts";
import { listCoreRuntimePostBuildOutputs } from "../scripts/runtime-postbuild.mts";
import { writeBuildInfo } from "../scripts/write-build-info.ts";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.ts";
import * as compat from "./scripts/update-compat-chunks.test-support.js";
import { assertPrebuiltUiE2eRuntime } from "./vitest/vitest.ui-e2e-prebuilt.global-setup.ts";

let root: string;
const fixtureBuildEnv = { OPENCLAW_BUILD_TIMESTAMP: "2026-09-23T00:00:00.000Z" };

function write(relative: string, contents = "fixture\n") {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });

const readBuildInfo = () =>
  JSON.parse(fs.readFileSync(path.join(root, "dist/build-info.json"), "utf8"));

function stampBuild() {
  writeBuildInfo({ rootDir: root, env: fixtureBuildEnv });
  const { buildId } = readBuildInfo();
  write(
    "dist/control-ui/index.html",
    `<html data-openclaw-control-ui-build-id="${buildId}-${"a".repeat(64)}"><script src="./assets/entry.js"></script></html>`,
  );
  metadata.writeBuildStamp({ cwd: root });
  metadata.writeRuntimePostBuildStamp({ cwd: root });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prebuilt-ui-")));
  vi.stubEnv("OPENCLAW_FORCE_BUILD", undefined);
  vi.stubEnv("OPENCLAW_FORCE_RUNTIME_POSTBUILD", undefined);
  vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", root);
  write(".gitignore", "dist/\nnode_modules/\n");
  write("package.json", '{"name":"prebuilt-ui-fixture","private":true}\n');
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  compat.writeUpdateCompatibilityBuildFixture(root);
  writeUpdateCompatibilityChunks({
    distDir: path.join(root, "dist"),
    sourceDir: root,
    inventory: compat.previousReleaseInventory,
  });
  for (const file of [
    "dist/entry.js",
    "dist/plugin-sdk/qa-lab.js",
    "dist/plugin-sdk/qa-runtime.js",
    ...listCoreRuntimePostBuildOutputs({ rootDir: root }),
  ]) {
    if (!fs.existsSync(path.join(root, file))) {
      write(file);
    }
  }
  write("dist/control-ui/assets/entry.js");
  write("dist/control-ui/sw.js");
  stampBuild();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it("rejects retained UI assets after a same-source runtime rebuild without repairing them", () => {
  const indexPath = path.join(root, "dist/control-ui/index.html");
  const index = fs.readFileSync(indexPath);
  const before = readBuildInfo();
  expect(assertPrebuiltUiE2eRuntime(root)).toEqual(expect.any(String));

  writeBuildInfo({
    rootDir: root,
    env: { OPENCLAW_BUILD_TIMESTAMP: "2026-09-23T00:01:00.000Z" },
  });
  const after = readBuildInfo();
  expect(after.commit).toBe(before.commit);
  expect(after.buildId).not.toBe(before.buildId);
  expect(() => assertPrebuiltUiE2eRuntime(root)).toThrow("Control UI assets are not ready (stale)");
  expect(fs.readFileSync(indexPath)).toEqual(index);
});

it("rejects incomplete UI without repairing it", () => {
  const target = path.join(root, "dist/control-ui/assets/entry.js");
  fs.rmSync(target, { recursive: true, force: true });
  expect(() => assertPrebuiltUiE2eRuntime(root)).toThrow("Control UI assets");
  expect(fs.existsSync(target)).toBe(false);
});

it.each([false, true])("sets the native CLI outcome after teardown (drift: %s)", (drift) => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "junction");
  write(
    "probe.test.ts",
    `import fs from "node:fs";
import { it } from "vitest";
it("finishes before the generation check", () => {
  if (${drift}) {
    fs.appendFileSync(${JSON.stringify(path.join(root, "dist/build-info.json"))}, "\\n");
  }
});`,
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "native fixture");
  stampBuild();
  const reportFile = path.join(root, ".git/report.json");
  const configFile = path.join(root, ".git/probe.config.mts");
  write(
    ".git/probe.config.mts",
    `import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
export default { resolve: sharedVitestConfig.resolve };`,
  );
  const result = spawnNodeEvalSync(
    `import { startVitest } from "vitest/node";
await startVitest("test", [], {
  root: ${JSON.stringify(root)}, config: ${JSON.stringify(configFile)},
  configLoader: "runner", watch: false,
  include: ["probe.test.ts"], pool: "forks", maxWorkers: 1,
  globalSetup: [${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.ui-e2e-prebuilt.global-setup.ts"))}],
  reporters: ["json"], outputFile: ${JSON.stringify(reportFile)},
});`,
    { cwd: repoRoot, timeout: 15_000 },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result, result.stderr).toMatchObject({ signal: null, status: drift ? 1 : 0 });
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  expect(report.numPassedTests, JSON.stringify(report) + result.stderr).toBe(1);
  if (drift) {
    expect(result.stderr).toContain("runtime generation changed during the run");
  }
});
