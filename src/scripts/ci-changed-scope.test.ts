import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const {
  detectChangedScope,
  detectInstallSmokeScope,
  detectNodeFastScope,
  isNodeTestDataOnlyPath,
  listChangedPaths,
  parseArgs,
  shouldRunIosScreenshots,
  writeGitHubOutput,
} = await import("../../scripts/ci-changed-scope.mjs");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["pull_request", "push", "schedule", "workflow_dispatch"])(
  "keeps Android capture scope outside ordinary PRs (%s)",
  (workflowEventName) => {
    const changedPaths = ["apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt"];
    const output = path.join(tempDirs.make("openclaw-ci-capture-scope-"), "scope.out");
    writeGitHubOutput(
      detectChangedScope(changedPaths),
      output,
      undefined,
      undefined,
      true,
      changedPaths,
      workflowEventName,
    );
    const scope = parseGitHubOutput(fs.readFileSync(output, "utf8"));
    expect(scope).toMatchObject({
      run_android: "true",
      run_native_i18n: "true",
      run_android_screenshots: String(workflowEventName !== "pull_request"),
    });
  },
);

function parseGitHubOutput(output: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of output.trim().split("\n")) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf("=");
    parsed[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return parsed;
}

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}

function writeRepoFile(repoDir: string, filePath: string, contents: string): void {
  const absolutePath = path.join(repoDir, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, "utf8");
}

function createRepo(prefix: string, file = "README.md", contents = "base\n") {
  const repoDir = tempDirs.make(prefix);
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "ci@example.invalid"]);
  git(repoDir, ["config", "user.name", "CI"]);
  writeRepoFile(repoDir, file, contents);
  commitRepo(repoDir, "base");
  return repoDir;
}

function commitRepo(repoDir: string, message: string) {
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", message]);
}

function createSyntheticMergeRepo(prefix: string): { repoDir: string; staleBase: string } {
  const repoDir = createRepo(prefix);
  const staleBase = git(repoDir, ["rev-parse", "HEAD"]);
  git(repoDir, ["switch", "-c", "feature"]);
  writeRepoFile(repoDir, "src/pr.ts", "export const pr = true;\n");
  commitRepo(repoDir, "feature");
  git(repoDir, ["switch", "main"]);
  writeRepoFile(repoDir, "src/main-only.ts", "export const mainOnly = true;\n");
  commitRepo(repoDir, "main only");
  git(repoDir, ["merge", "--no-ff", "feature", "-m", "synthetic merge"]);

  return { repoDir, staleBase };
}

describe("parseArgs", () => {
  it("rejects missing CI diff refs", () => {
    expect(() => parseArgs(["--base", "--head", "HEAD"])).toThrow("--base requires a value");
    expect(() => parseArgs(["--base", "-h", "--head", "HEAD"])).toThrow("--base requires a value");
    expect(() => parseArgs(["--head"])).toThrow("--head requires a value");
    expect(() => parseArgs(["--head", "-h"])).toThrow("--head requires a value");
    expect(() => parseArgs(["--base", ""])).toThrow("--base requires a value");
    expect(() => parseArgs([])).toThrow("--base is required");
    expect(() => parseArgs(["--head", "HEAD"])).toThrow("--base is required");
    expect(() => parseArgs(["--base", "HEAD", "--mystery"])).toThrow("Unknown argument: --mystery");
  });
});

function expectedScope(enabled = "") {
  const selected = new Set(enabled.split(" "));
  return Object.fromEntries(
    "Node Macos MacosNode IosBuild Android Windows SkillsPython ChangedSmoke ControlUiI18n UiTests"
      .split(" ")
      .map((lane) => [`run${lane}`, selected.has(lane)]),
  );
}

describe("detectChangedScope", () => {
  it("fails safe when no paths are provided", () => {
    expect(detectChangedScope([])).toEqual(
      Object.fromEntries(Object.keys(expectedScope()).map((lane) => [lane, true])),
    );
  });

  it.each<[string | string[], string]>([
    [["docs/ci.md", "docs/docs.json", "README.md"], ""],
    [["src/config/defaults.ts", "docs/docs.json"], "Node"],
    [".crabbox.yaml", "Node"],
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
    ["scripts/install.ps1", "Node Windows ChangedSmoke"],
    ["scripts/install.sh", "Node ChangedSmoke"],
    [".github/workflows/install-smoke.yml", "Node ChangedSmoke"],
    ["src/plugins/loader.ts", "Node ChangedSmoke"],
    [
      "packages/gateway-protocol/src/schema/messages.ts",
      "Node ChangedSmoke Macos MacosNode IosBuild Android",
    ],
    ["src/plugins/loader.test.ts", "Node"],
  ])("selects only the owning lanes for %j", (paths, lanes) => {
    expect(detectChangedScope(typeof paths === "string" ? [paths] : paths)).toEqual(
      expectedScope(lanes),
    );
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

  it.each([
    ["scripts/install-simslim.sh", true],
    ["scripts/install-simslim.sh.bak", false],
  ])("routes only exact iOS build helper paths: %s", (file, enabled) => {
    expect(detectChangedScope([file])).toEqual(expectedScope(enabled ? "Node IosBuild" : "Node"));
    expect(shouldRunIosScreenshots([file])).toBe(enabled);
  });

  it.each<[string[], boolean, boolean]>([
    [[], true, true],
    [["docs/ci.md"], false, false],
    [["scripts/install.sh"], true, true],
    [["extensions/matrix/package.json"], true, false],
    [["src/plugins/loader.ts"], true, false],
    [["src/plugins/loader.test.ts"], false, false],
    [["extensions/matrix/index.ts"], false, false],
  ])("splits install smoke for %j", (paths, runFastInstallSmoke, runFullInstallSmoke) => {
    expect(detectInstallSmokeScope(paths)).toEqual({ runFastInstallSmoke, runFullInstallSmoke });
  });

  it.each<[string[], boolean, boolean, boolean]>([
    [
      ["src/plugins/contracts/registry.ts", "scripts/test-projects.test-support.mts"],
      true,
      true,
      true,
    ],
    [["scripts/check-changed.mjs", "docs/ci.md"], true, false, true],
    [[".github/workflows/ci.yml"], false, false, false],
    [
      ["src/plugins/contracts/registry.ts", "src/plugins/contracts/manifest-loader.ts"],
      false,
      false,
      false,
    ],
  ])(
    "restricts fast-only Node scope for %j",
    (paths, runFastOnly, runPluginContracts, runCiRouting) => {
      expect(detectNodeFastScope(paths)).toEqual({ runFastOnly, runPluginContracts, runCiRouting });
    },
  );

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
    const { repoDir, staleBase } = createSyntheticMergeRepo("openclaw-ci-scope-merge-");

    expect(git(repoDir, ["diff", "--name-only", staleBase, "HEAD"]).split("\n").toSorted()).toEqual(
      ["src/main-only.ts", "src/pr.ts"],
    );

    expect(listChangedPaths(staleBase, "HEAD", repoDir, true)).toEqual(["src/pr.ts"]);
  });

  it("reports both sides of a rename so deleted paths force safe planning", () => {
    const repoDir = createRepo(
      "openclaw-ci-scope-rename-",
      "src/old.ts",
      "export const value = 1;\n",
    );
    const base = git(repoDir, ["rev-parse", "HEAD"]);
    fs.renameSync(path.join(repoDir, "src/old.ts"), path.join(repoDir, "src/new.ts"));
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "rename"]);

    expect(listChangedPaths(base, "HEAD", repoDir)).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("preserves leading spaces and newlines in Git filename tokens", () => {
    if (process.platform === "win32") {
      return;
    }
    const repoDir = createRepo("openclaw-ci-scope-raw-paths-");
    const base = git(repoDir, ["rev-parse", "HEAD"]);
    const changedPaths = [" scripts/changed-lanes.mts", "scripts/changed\nlanes.mts"];
    for (const changedPath of changedPaths) {
      writeRepoFile(repoDir, changedPath, "export {};\n");
    }
    git(repoDir, ["add", "--", ...changedPaths]);
    git(repoDir, ["commit", "-m", "raw paths"]);

    expect(listChangedPaths(base, "HEAD", repoDir).toSorted()).toEqual(changedPaths.toSorted());
  });

  it.each<[string, string, string, boolean, string[]?]>([
    ["missing base", "", "missing", true, ["--head", "HEAD"]],
    ["unknown option", "", "missing", true, ["--base", "HEAD", "--head", "HEAD", "--mystery"]],
    ["empty diff without a manifest", "", "missing", false],
    ["declared native test", "src/process/exec.windows.integration.test.ts", "valid", false],
    ["Mac fixture helper", "test/scripts/mac-script-fixture.test-support.ts", "valid", false],
    ["shared Talk fixture", "test/fixtures/talk-config-contract.json", "valid", false],
    ["unrelated process test", "src/process/exec.test.ts", "valid", false],
    ["missing manifest", "src/process/exec.test.ts", "missing", true],
    ["invalid manifest", "src/process/exec.test.ts", "invalid", true],
    ["empty native inventory", "src/process/exec.test.ts", "empty", true],
  ])(
    "runs zero-install scope detection for %s",
    (_label, changedPath, manifest, failSafe, cliArgs) => {
      const repoDir = fs.realpathSync(
        createRepo("openclaw-ci-scope-empty-", "README.md", "test\n"),
      );
      const outputPath = path.join(repoDir, "github-output.txt");
      const scriptPath = path.join(repoDir, "scripts/ci-changed-scope.mjs");

      for (const sourcePath of [
        "scripts/ci-changed-scope.mjs",
        "scripts/native-protocol-inputs.json",
        "scripts/lib/arg-utils.runtime.mjs",
        "scripts/lib/changed-path-facts.mjs",
        "scripts/lib/ci-native-generated-scope.mjs",
        "scripts/lib/direct-run.mjs",
        "scripts/lib/merge-head-diff-base.mjs",
      ]) {
        writeRepoFile(repoDir, sourcePath, fs.readFileSync(path.resolve(sourcePath), "utf8"));
      }

      if (manifest !== "missing") {
        const contents =
          manifest === "valid"
            ? fs.readFileSync("package.json", "utf8")
            : manifest === "invalid"
              ? "{"
              : JSON.stringify({ scripts: { "test:windows:ci:1": "" } });
        writeRepoFile(repoDir, "package.json", contents);
      }
      if (changedPath) {
        writeRepoFile(repoDir, changedPath, "export {};\n");
        git(repoDir, ["add", changedPath]);
        git(repoDir, ["commit", "-m", "changed test"]);
      }
      const base = changedPath ? "HEAD^" : "HEAD";
      expect(fs.existsSync(path.join(repoDir, "node_modules"))).toBe(false);
      execFileSync(
        process.execPath,
        [scriptPath, ...(cliArgs ?? ["--base", base, "--head", "HEAD"])],
        {
          cwd: repoDir,
          env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: outputPath },
        },
      );

      const output = parseGitHubOutput(fs.readFileSync(outputPath, "utf8"));
      expect(Object.keys(output).toSorted()).toEqual(
        "changed_paths_file changed_paths_json node_test_data_only run_android run_android_screenshots run_changed_smoke run_control_ui_i18n run_fast_install_smoke run_full_install_smoke run_ios_build run_ios_screenshots run_macos run_macos_node run_native_i18n run_node run_node_fast_ci_routing run_node_fast_only run_node_fast_plugin_contracts run_skills_python run_ui_tests run_windows strict_control_ui_i18n strict_native_i18n".split(
          " ",
        ),
      );
      expect(output.changed_paths_json).toBe(
        failSafe ? "null" : JSON.stringify(changedPath ? [changedPath] : []),
      );
      expect(
        fs.readFileSync(expectDefined(output.changed_paths_file, "changed-path manifest"), "utf8"),
      ).toBe(output.changed_paths_json);
      expect(output.node_test_data_only).toBe("false");
      for (const [key, value] of Object.entries(output)) {
        if (!key.startsWith("changed_paths_") && key !== "node_test_data_only") {
          const selected =
            (failSafe && !key.startsWith("run_node_fast")) ||
            (key === "run_node" && Boolean(changedPath)) ||
            (key === "run_android" && changedPath === "test/fixtures/talk-config-contract.json") ||
            (key === "run_macos_node" &&
              (changedPath === "test/scripts/mac-script-fixture.test-support.ts" ||
                changedPath === "test/fixtures/talk-config-contract.json")) ||
            (key === "run_macos" && changedPath === "test/fixtures/talk-config-contract.json") ||
            (key === "run_windows" &&
              changedPath === "src/process/exec.windows.integration.test.ts");
          expect(value, key).toBe(String(selected));
        }
      }
    },
  );
});
