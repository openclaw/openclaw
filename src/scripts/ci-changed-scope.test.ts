import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeFixtureFiles as writeFiles } from "../../test/scripts/z0632-fixtures.test-support.js";

const {
  detectChangedScope,
  detectNodeFastScope,
  isNodeTestDataOnlyPath,
  listChangedPaths,
  parseArgs,
  shouldRunIosScreenshots,
} = await import("../../scripts/ci-changed-scope.mjs");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function parseGitHubOutput(output: string): Record<string, string> {
  return Object.fromEntries(
    Array.from(output.trim().matchAll(/^([^=\n]+)=(.*)$/gm), ([, key, value]) => [key, value]),
  );
}

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}

function createRepo(file = "README.md", contents = "base\n") {
  const repoDir = tempDirs.make("openclaw-ci-scope-");
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "ci@example.invalid"]);
  git(repoDir, ["config", "user.name", "CI"]);
  writeFiles(repoDir, { [file]: contents });
  commitRepo(repoDir, "base");
  return repoDir;
}

function commitRepo(repoDir: string, message: string, files = ["."]) {
  git(repoDir, ["add", "--", ...files]);
  git(repoDir, ["commit", "-m", message]);
}

it("rejects missing CI diff refs", () => {
  expect(() => parseArgs(["--base", "--head", "HEAD"])).toThrow("--base requires a value");
  expect(() => parseArgs(["--head"])).toThrow("--head requires a value");
});

function expectedScope(enabled = "") {
  const lanes = "Node Macos MacosNode IosBuild Android Windows SkillsPython ControlUiI18n UiTests";
  return Object.fromEntries(
    lanes.split(" ").map((lane) => [`run${lane}`, enabled.split(" ").includes(lane)]),
  );
}

it("fails safe when no paths are provided", () => {
  expect(detectChangedScope([])).toEqual(
    Object.fromEntries(Object.keys(expectedScope()).map((lane) => [lane, true])),
  );
});

it.each<[string | string[], string, boolean?]>([
  [["docs/ci.md", "docs/docs.json", "README.md"], ""],
  [["src/config/defaults.ts", "docs/docs.json"], "Node"],
  [".crabbox.yaml", "Node"],
  ["config/test-lines-allocations/regression.txt", "Node"],
  ["src/skills/runtime/refresh.ts", "Node MacosNode Windows"],
  [".github/actions/setup-android-toolchain/action.yml", "Node Android"],
  ["apps/macos/Sources/Foo.swift", "Macos MacosNode"],
  ["apps/ios/Sources/RootTabs.swift", "IosBuild"],
  ["apps/shared/OpenClawKit/Sources/Foo.swift", "Macos MacosNode IosBuild Android"],
  ["apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift", "IosBuild"],
  ["config/swiftformat", "Node Macos MacosNode IosBuild"],
  ["scripts/run-swiftlint.mts", "Node Macos MacosNode IosBuild"],
  ["scripts/prepare-apple-mermaid.mjs", "Node Macos MacosNode IosBuild"],
  ["scripts/package-mac-app.sh", "Node Macos MacosNode"],
  ["scripts/lib/openclaw-bun.json", "Node Macos MacosNode"],
  ["scripts/stage-openclaw-bun.sh", "Node Macos MacosNode"],
  ["skills/skill-creator/scripts/test_quick_validate.py", "Node SkillsPython"],
  [".github/workflows/ci.yml", "Node Windows UiTests"],
  ["scripts/lib/ci-test-runtime.mts", "Node UiTests"],
  ["scripts/ci-xcodebuild.py", "Node IosBuild"],
  ["scripts/ci-xcodebuild.py.bak", "Node"],
  ["scripts/install.ps1", "Node Windows"],
  ["scripts/install.sh", "Node"],
  [".github/workflows/install-smoke.yml", "Node"],
  ["src/plugins/loader.ts", "Node"],
  ["packages/gateway-protocol/src/schema/messages.ts", "Node Macos MacosNode IosBuild Android"],
  ["src/plugins/loader.test.ts", "Node"],
  ["scripts/install-simslim.sh", "Node IosBuild", true],
  ["scripts/install-simslim.sh.bak", "Node", false],
])("selects only the owning lanes for %j", (paths, lanes, screenshots) => {
  const changedPaths = typeof paths === "string" ? [paths] : paths;
  expect(detectChangedScope(changedPaths)).toEqual(expectedScope(lanes));
  if (screenshots !== undefined) {
    expect(shouldRunIosScreenshots(changedPaths)).toBe(screenshots);
  }
});

it.each([
  ["scripts/README.mdx", true],
  ["docs/docs.json", true],
  ["docs/reference/templates/config.json", false],
  ["src/runtime.md", false],
  ["src/wizard/i18n/locales/en.ts", true],
  ["src/wizard/i18n/locales/helpers/format.ts", false],
] as const)("classifies data-only inputs: %s", (file, dataOnly) => {
  expect(isNodeTestDataOnlyPath(file)).toBe(dataOnly);
});

it.each<[string[], string]>([
  [["src/plugins/contracts/registry.ts", "scripts/test-projects.test-support.mts"], "all"],
  [["scripts/check-changed.mjs", "docs/ci.md"], "ci"],
  [[".github/workflows/ci.yml"], ""],
  [["src/plugins/contracts/registry.ts", "src/plugins/contracts/manifest-loader.ts"], ""],
])("restricts fast-only Node scope for %j", (paths, scope) => {
  expect(detectNodeFastScope(paths)).toEqual({
    runFastOnly: scope !== "",
    runPluginContracts: scope === "all",
    runCiRouting: scope !== "",
  });
});

it("treats base and head as literal git args", () => {
  const markerPath = path.join(tempDirs.make("openclaw-ci-scope-injection-"), "injected");

  const injectedBase =
    process.platform === "win32"
      ? `HEAD & echo injected > "${markerPath}" & rem`
      : `HEAD; touch "${markerPath}" #`;

  expect(() => listChangedPaths(injectedBase, "HEAD")).toThrow(injectedBase);
  expect(fs.existsSync(markerPath)).toBe(false);
});

it("uses the merge commit first parent instead of a stale PR payload base", () => {
  const repoDir = createRepo();
  const staleBase = git(repoDir, ["rev-parse", "HEAD"]);
  git(repoDir, ["switch", "-c", "feature"]);
  writeFiles(repoDir, { "src/pr.ts": "export const pr = true;\n" });
  commitRepo(repoDir, "feature");
  git(repoDir, ["switch", "main"]);
  writeFiles(repoDir, { "src/main-only.ts": "export const mainOnly = true;\n" });
  commitRepo(repoDir, "main only");
  git(repoDir, ["merge", "--no-ff", "feature", "-m", "synthetic merge"]);
  expect(listChangedPaths(staleBase, "HEAD", repoDir, true)).toEqual(["src/pr.ts"]);
});

it.each(["rename", "raw paths"])("preserves %s in Git diff filename tokens", (change) => {
  if (change === "raw paths" && process.platform === "win32") {
    return;
  }
  const repoDir = createRepo("src/old.ts", "export const value = 1;\n");
  const base = git(repoDir, ["rev-parse", "HEAD"]);
  const changedPaths =
    change === "rename"
      ? ["src/new.ts", "src/old.ts"]
      : [" scripts/changed-lanes.mts", "scripts/changed\nlanes.mts"];
  if (change === "rename") {
    fs.renameSync(path.join(repoDir, "src/old.ts"), path.join(repoDir, "src/new.ts"));
  } else {
    for (const changedPath of changedPaths) {
      writeFiles(repoDir, { [changedPath]: "export {};\n" });
    }
  }
  commitRepo(repoDir, change);
  const actual = listChangedPaths(base, "HEAD", repoDir);
  expect(change === "rename" ? actual : actual.toSorted()).toEqual(changedPaths.toSorted());
});

const androidSource = "apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt";
const manifests = {
  valid: fs.readFileSync("package.json", "utf8"),
  invalid: "{",
  empty: JSON.stringify({ scripts: { "test:windows:ci:1": "" } }),
};
it.each<[string, string, keyof typeof manifests | "missing", string | null, string[]?, string?]>([
  ["missing base", "", "missing", null, ["--head", "HEAD"]],
  ["unknown option", "", "missing", null, ["--base", "HEAD", "--head", "HEAD", "--mystery"]],
  ["empty diff without a manifest", "", "missing", ""],
  ["Windows native", "src/process/exec.windows.integration.test.ts", "valid", "node windows"],
  ["Mac fixture", "test/scripts/mac-script-fixture.test-support.ts", "valid", "node macos_node"],
  [
    "Talk fixture",
    "test/fixtures/talk-config-contract.json",
    "valid",
    "node android macos macos_node",
  ],
  ["Android PR", androidSource, "valid", "android native_i18n", undefined, "pull_request"],
  ["Android push", androidSource, "valid", "android android_screenshots native_i18n"],
  ["unrelated process test", "src/process/exec.test.ts", "valid", "node"],
  ["missing manifest", "src/process/exec.test.ts", "missing", null],
  ["invalid manifest", "src/process/exec.test.ts", "invalid", null],
  ["empty native inventory", "src/process/exec.test.ts", "empty", null],
])(
  "runs zero-install scope detection for %s",
  (_label, changedPath, manifest, selectedLanes, cliArgs, event = "push") => {
    const failSafe = selectedLanes === null;
    const repoDir = fs.realpathSync(createRepo());
    const outputPath = path.join(repoDir, "github-output.txt");
    const scriptPath = path.join(repoDir, "scripts/ci-changed-scope.mjs");

    const scriptFiles =
      "ci-changed-scope.mjs native-protocol-inputs.json lib/arg-utils.runtime.mjs lib/changed-path-facts.mjs lib/ci-native-generated-scope.mjs lib/direct-run.mjs lib/merge-head-diff-base.mjs";
    for (const file of scriptFiles.split(" ")) {
      const sourcePath = `scripts/${file}`;
      writeFiles(repoDir, { [sourcePath]: fs.readFileSync(sourcePath, "utf8") });
    }

    if (manifest !== "missing") {
      writeFiles(repoDir, { "package.json": manifests[manifest] });
    }
    if (changedPath) {
      writeFiles(repoDir, { [changedPath]: "export {};\n" });
      commitRepo(repoDir, "changed test", [changedPath]);
    }
    const base = changedPath ? "HEAD^" : "HEAD";
    expect(fs.existsSync(path.join(repoDir, "node_modules"))).toBe(false);
    execFileSync(
      process.execPath,
      [scriptPath, ...(cliArgs ?? ["--base", base, "--head", "HEAD"])],
      {
        cwd: repoDir,
        env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: outputPath },
      },
    );

    const output = parseGitHubOutput(fs.readFileSync(outputPath, "utf8"));
    const flags =
      "run_android run_android_screenshots run_control_ui_i18n run_ios_build run_ios_screenshots run_macos run_macos_node run_native_i18n run_node run_node_fast_ci_routing run_node_fast_only run_node_fast_plugin_contracts run_skills_python run_ui_tests run_windows strict_control_ui_i18n strict_native_i18n".split(
        " ",
      );
    const enabled = failSafe
      ? flags.filter((key) => !key.startsWith("run_node_fast"))
      : selectedLanes.split(" ").map((lane) => `run_${lane}`);
    expect(output).toEqual({
      ...Object.fromEntries(flags.map((key) => [key, String(enabled.includes(key))])),
      changed_paths_file: expect.any(String),
      changed_paths_json: failSafe ? "null" : JSON.stringify(changedPath ? [changedPath] : []),
      node_test_data_only: "false",
    });
    expect(
      fs.readFileSync(expectDefined(output.changed_paths_file, "changed-path manifest"), "utf8"),
    ).toBe(output.changed_paths_json);
  },
);
