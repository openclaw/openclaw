// CI changed scope tests cover script detection of changed files and lanes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
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
  shouldRunNativeI18n,
  writeGitHubOutput,
} = await import("../../scripts/ci-changed-scope.mjs");

const markerPaths: string[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  for (const markerPath of markerPaths) {
    try {
      fs.unlinkSync(markerPath);
    } catch {}
  }
  markerPaths.length = 0;
});

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

function createSyntheticMergeRepo(prefix: string): { repoDir: string; staleBase: string } {
  const repoDir = tempDirs.make(prefix);

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "ci@example.invalid"]);
  git(repoDir, ["config", "user.name", "CI"]);
  writeRepoFile(repoDir, "README.md", "base\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "base"]);
  const staleBase = git(repoDir, ["rev-parse", "HEAD"]);

  git(repoDir, ["switch", "-c", "feature"]);
  writeRepoFile(repoDir, "src/pr.ts", "export const pr = true;\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "feature"]);

  git(repoDir, ["switch", "main"]);
  writeRepoFile(repoDir, "src/main-only.ts", "export const mainOnly = true;\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "main only"]);
  git(repoDir, ["merge", "--no-ff", "feature", "-m", "synthetic merge"]);

  return { repoDir, staleBase };
}

describe("parseArgs", () => {
  it("parses CI diff refs", () => {
    expect(parseArgs(["--base", "origin/main", "--head", "HEAD"])).toEqual({
      base: "origin/main",
      head: "HEAD",
      mergeHeadFirstParent: false,
    });
  });

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

function expectedScope(overrides: Partial<ReturnType<typeof detectChangedScope>> = {}) {
  return {
    runNode: false,
    runMacos: false,
    runMacosNode: false,
    runIosBuild: false,
    runAndroid: false,
    runWindows: false,
    runSkillsPython: false,
    runChangedSmoke: false,
    runControlUiI18n: false,
    runUiTests: false,
    ...overrides,
  };
}

describe("detectChangedScope", () => {
  const expectedNodeOnlyScope = expectedScope({ runNode: true });

  const expectedNodeAndChangedSmokeScope = expectedScope({ runNode: true, runChangedSmoke: true });

  it("routes only native i18n-owned paths to the native inventory job", () => {
    for (const changedPath of [
      "apps/.i18n/native-source.json",
      "apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt",
      "apps/android/wear/src/main/java/ai/openclaw/wear/WearScreens.kt",
      "apps/ios/Sources/RootTabs.swift",
      "apps/macos/Sources/OpenClaw/Settings.swift",
      "apps/shared/OpenClawKit/Sources/OpenClawKit/Client.swift",
      "scripts/native-app-i18n.ts",
      "scripts/android-app-i18n.ts",
      "scripts/apple-app-i18n.ts",
      "test/scripts/native-app-i18n.test.ts",
      ".github/workflows/native-app-locale-refresh.yml",
      ".github/workflows/ci.yml",
    ]) {
      expect(shouldRunNativeI18n([changedPath]), changedPath).toBe(true);
    }

    expect(shouldRunNativeI18n(["src/config/defaults.ts"])).toBe(false);
    expect(shouldRunNativeI18n(["scripts/install.sh"])).toBe(false);
  });

  it("fails safe when no paths are provided", () => {
    expect(detectChangedScope([])).toEqual(
      expectedScope({
        runNode: true,
        runMacos: true,
        runMacosNode: true,
        runIosBuild: true,
        runAndroid: true,
        runWindows: true,
        runSkillsPython: true,
        runChangedSmoke: true,
        runControlUiI18n: true,
        runUiTests: true,
      }),
    );
  });

  it("keeps all lanes off for docs-only changes", () => {
    expect(
      detectChangedScope([
        "docs/ci.md",
        "docs/docs.json",
        "docs/.generated/config-baseline.counts.json",
        "docs/.generated/config-baseline.sha256",
        "docs/assets/navigation.svg",
        "README.md",
      ]),
    ).toEqual({
      runNode: false,
      runMacos: false,
      runMacosNode: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("enables node lane for node-relevant files", () => {
    expect(detectChangedScope(["src/config/defaults.ts"])).toEqual(expectedNodeOnlyScope);
    expect(detectChangedScope(["src/wizard/i18n/locales/en.ts"])).toEqual(expectedNodeOnlyScope);
    expect(
      detectChangedScope([
        "src/config/defaults.ts",
        "docs/docs.json",
        "docs/.generated/config-baseline.counts.json",
        "docs/.generated/config-baseline.sha256",
        "docs/assets/navigation.svg",
      ]),
    ).toEqual(expectedNodeOnlyScope);
  });

  it.each([
    ["scripts/README.md", true],
    ["scripts/README.mdx", true],
    ["docs/docs.json", true],
    ["docs/.generated/config-baseline.counts.json", true],
    ["docs/.generated/config-baseline.sha256", true],
    ["docs/assets/navigation.svg", true],
    ["docs/script.ts", true],
    ["test/fixtures/README.md", false],
    ["src/fixtures/README.mdx", false],
    ["docs/reference/templates/README.md", false],
    ["docs/reference/templates/config.json", false],
    ["docs/.i18n/fixtures/sample.json", false],
    ["src/runtime.md", false],
    ["src/wizard/i18n/locales/en.ts", true],
    ["src/wizard/i18n/locales/zh-CN.ts", true],
    ["src/wizard/i18n/locales/zh-TW.ts", true],
    ["src/wizard/i18n/index.ts", false],
    ["src/wizard/i18n/types.ts", false],
    ["src/wizard/i18n/locales/helpers/format.ts", false],
  ] as const)(
    "classifies documentation and catalogs without excluding runtime inputs: %s",
    (file, dataOnly) => {
      expect(isNodeTestDataOnlyPath(file)).toBe(dataOnly);
    },
  );

  it("routes Skills watcher ownership to desktop Node proof without native app builds", () => {
    for (const changedPath of [
      "src/skills/runtime/refresh.ts",
      "src/skills/runtime/refresh-observation-source.ts",
      "src/skills/runtime/refresh-file-stability.ts",
      "src/skills/runtime/refresh-watch-registry.ts",
      "src/skills/runtime/refresh-file-stability.test.ts",
      "src/skills/runtime/refresh.recovery.test.ts",
      "src/skills/runtime/refresh.observation.live.test.ts",
      "src/skills/runtime/refresh.missing-root.integration.test.ts",
      "src/skills/runtime/refresh.symbolic-source.integration.test.ts",
    ]) {
      expect(detectChangedScope([changedPath]), changedPath).toEqual({
        ...expectedNodeOnlyScope,
        runMacosNode: true,
        runWindows: true,
      });
    }
    expect(detectChangedScope(["src/skills/runtime/refreshing.ts"])).toEqual(expectedNodeOnlyScope);
    expect(detectChangedScope(["src/skills/loading/workspace-skill-loader.ts"])).toEqual(
      expectedNodeOnlyScope,
    );
  });

  it("runs Android and Node CI for Android toolchain action changes", () => {
    expect(detectChangedScope([".github/actions/setup-android-toolchain/action.yml"])).toEqual({
      ...expectedNodeOnlyScope,
      runAndroid: true,
    });
  });

  it("keeps node lane off for native-only changes", () => {
    expect(detectChangedScope(["apps/macos/Sources/Foo.swift"])).toEqual(
      expectedScope({ runMacos: true, runMacosNode: true }),
    );
    expect(
      detectChangedScope(["apps/macos-mlx-tts/Sources/OpenClawMLXTTSHelper/main.swift"]),
    ).toEqual(expectedScope({ runMacos: true, runMacosNode: true }));
    expect(detectChangedScope(["apps/ios/Sources/RootTabs.swift"])).toEqual(
      expectedScope({ runIosBuild: true }),
    );
    expect(detectChangedScope(["apps/shared/OpenClawKit/Sources/Foo.swift"])).toEqual(
      expectedScope({ runMacos: true, runMacosNode: true, runIosBuild: true, runAndroid: true }),
    );
    expect(detectChangedScope(["apps/swabble/Sources/SwabbleKit/WakeWordGate.swift"])).toEqual(
      expectedScope({ runMacos: true, runMacosNode: true, runIosBuild: true }),
    );
    expect(detectChangedScope(["Swabble/Sources/SwabbleKit/WakeWordGate.swift"])).toEqual(
      expectedScope({ runMacos: true, runMacosNode: true, runIosBuild: true }),
    );
  });

  it("runs both Apple lanes for shared Swift tooling changes", () => {
    for (const toolingPath of [
      "config/swiftformat",
      "config/swiftlint.yml",
      "scripts/check-swift-tools.sh",
      "scripts/format-swift.sh",
      "scripts/install-swift-tools.sh",
      "scripts/install-xcodegen.sh",
      "scripts/lib/swift-toolchain.sh",
      "scripts/lint-swift.sh",
      "scripts/run-swiftlint.mts",
      "scripts/lib/check-limits.mts",
      "scripts/prepare-apple-mermaid.mjs",
    ]) {
      expect(detectChangedScope([toolingPath])).toEqual(
        expectedScope({ runNode: true, runMacos: true, runMacosNode: true, runIosBuild: true }),
      );
      expect(shouldRunIosScreenshots([toolingPath])).toBe(true);
    }
  });

  it("enables the iOS build lane for iOS build helper changes", () => {
    for (const helperPath of [
      "scripts/ios-team-id.sh",
      "scripts/ios-write-swift-filelist.mjs",
      "scripts/ios-write-swift-filelist.mts",
      "scripts/ios-version.ts",
      "scripts/lib/ios-version.ts",
      "scripts/lib/release-version.mjs",
      "scripts/lib/version-script-args.ts",
    ]) {
      expect(detectChangedScope([helperPath])).toEqual(
        expectedScope({ runNode: true, runIosBuild: true }),
      );
    }
  });

  it("runs the iOS build but not macOS for generated protocol model-only changes", () => {
    expect(
      detectChangedScope(["apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift"]),
    ).toEqual(expectedScope({ runIosBuild: true }));
  });

  it.each([
    ["scripts/install-simslim.sh", true],
    ["scripts/ios-simulator-prepare.sh", true],
    ["scripts/install-simslim.sh.bak", false],
    ["scripts/ios-simulator-prepare-extra.sh", false],
    ["scripts/lib/ios-simulator-prepare.sh", false],
    ["scripts/unrelated.sh", false],
  ])("routes only exact simulator helper paths: %s", (helperPath, enabled) => {
    expect(detectChangedScope([helperPath])).toMatchObject({
      runIosBuild: enabled,
      runMacos: false,
      runAndroid: false,
    });
    expect(shouldRunIosScreenshots([helperPath])).toBe(enabled);
  });

  it("enables node lane for non-native non-doc files by fallback", () => {
    expect(detectChangedScope(["README.md"])).toEqual(expectedScope());

    expect(detectChangedScope([".crabbox.yaml"])).toEqual(expectedNodeOnlyScope);
  });

  it("keeps windows lane off for non-runtime GitHub metadata files", () => {
    expect(detectChangedScope([".github/labeler.yml"])).toEqual(expectedNodeOnlyScope);
  });

  it("runs Python skill tests when skills change", () => {
    expect(detectChangedScope(["skills/skill-creator/scripts/test_quick_validate.py"])).toEqual(
      expectedScope({ runNode: true, runSkillsPython: true }),
    );
  });

  it("runs Python skill tests when shared Python config changes", () => {
    expect(detectChangedScope(["skills/pyproject.toml"])).toEqual(
      expectedScope({ runNode: true, runSkillsPython: true }),
    );
  });

  it("runs CI-owned platform lanes when the CI workflow changes", () => {
    expect(detectChangedScope([".github/workflows/ci.yml"])).toEqual(
      expectedScope({ runNode: true, runWindows: true, runUiTests: true }),
    );
  });

  it.each([
    "scripts/codesign-mac-app.sh",
    "scripts/create-dmg.sh",
    "scripts/lib/plistbuddy.sh",
    "scripts/notarize-mac-artifact.sh",
    "scripts/package-mac-app.sh",
    "scripts/package-mac-dist.sh",
    "scripts/build-and-run-mac.sh",
    "scripts/prepush-ci.sh",
    "scripts/stage-mac-node-worker.sh",
    "scripts/restart-mac.sh",
    "scripts/lib/mac-app-bundle.sh",
    "test/scripts/restart-mac.test.ts",
    "scripts/materialize-mac-node-worker.py",
    "scripts/swift-build-cache-metadata.py",
    "test/scripts/swift-build-cache-metadata.test.ts",
    "scripts/lib/mac-native-inventory.py",
    "scripts/lib/mac-bundle-mutation.py",
    "scripts/verify-mac-node-worker.mjs",
    "scripts/verify-mac-node-worker-fs.mjs",
    "scripts/lib/mac-node-worker-proof-state.mjs",
    "scripts/lib/mac-worker-portability.mjs",
    "test/helpers/mac-native.ts",
    "test/helpers/mac-signing.ts",
    "test/scripts/codesign-mac-app.test.ts",
    "test/scripts/create-dmg.test.ts",
    "test/scripts/notarize-mac-artifact.test.ts",
    "test/scripts/package-mac-app.test.ts",
    "test/scripts/package-mac-dist.test.ts",
    "test/scripts/mac-elevation-artifact.test-support.ts",
    "test/scripts/mac-native-fixtures.test-support.ts",
    "test/scripts/mac-node-worker-materialization.test-support.ts",
    "test/scripts/mac-node-worker.test.ts",
    "test/scripts/verify-mac-node-worker-fs.test.ts",
  ])("runs macOS CI for packaging owner %s", (changedPath) => {
    expect(detectChangedScope([changedPath])).toEqual(
      expectedScope({ runNode: true, runMacos: true, runMacosNode: true }),
    );
  });

  it.each<[string, boolean, boolean]>([
    ["extensions/memory-lancedb/index.test.ts", false, false],
    ["src/auto-reply/reply/streaming-directives.ts", false, false],
    ["src/process/exec.ts", true, false],
    ["src/daemon/schtasks.ts", true, false],
    ["src/daemon/schtasks-exec.ts", true, false],
    ["src/daemon/runtime-hints.windows-paths.test.ts", true, false],
    ["src/daemon/test-helpers/schtasks-fixtures.ts", true, false],
    ["src/shared/runtime-import.ts", true, false],
    ["scripts/npm-runner.mts", true, false],
    ["scripts/lib/format-generated-module.mts", true, false],
    ["scripts/lib/ci-windows-test-plan.mts", true, false],
    ["scripts/lib/vitest-build-prerequisites.mts", true, false],
    ["test/scripts/ci-windows-test-plan.test.ts", true, false],
    ["test/scripts/format-generated-module.test.ts", true, false],
    [".github/workflows/openclaw-cross-os-release-checks-reusable.yml", true, false],
    [".github/workflows/windows-testbox-probe.yml", true, false],
    ["scripts/github/run-openclaw-cross-os-release-checks.sh", true, false],
    ["scripts/openclaw-cross-os-release-checks.ts", true, false],
    ["scripts/lib/cross-os-release-checks/runtime.ts", true, false],
    ["scripts/install.ps1", true, true],
  ])(
    "runs Windows only for Windows-relevant changes (%s)",
    (changedPath, runWindows, runChangedSmoke) => {
      expect(detectChangedScope([changedPath])).toEqual(
        expectedScope({ runNode: true, runWindows, runChangedSmoke }),
      );
    },
  );

  it("runs changed-smoke for install and packaging surfaces", () => {
    expect(detectChangedScope(["scripts/install.sh"])).toEqual(expectedNodeAndChangedSmokeScope);
    expect(detectChangedScope(["scripts/install-cli.sh"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope([bundledPluginFile("matrix", "package.json")])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope([".github/workflows/install-smoke.yml"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope(["scripts/e2e/qr-import-docker.sh"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope(["scripts/e2e/gateway-network-docker.sh"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope(["scripts/e2e/Dockerfile"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope(["scripts/e2e/agents-delete-shared-workspace-docker.sh"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope(["scripts/e2e/plugin-update-unchanged-docker.sh"])).toEqual(
      expectedNodeOnlyScope,
    );
    expect(detectChangedScope(["scripts/postinstall-bundled-plugins.mjs"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope(["scripts/ci-changed-scope.mjs"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
  });

  it("runs changed-smoke for Docker-covered core runtime surfaces", () => {
    expect(detectChangedScope(["src/plugins/loader.ts"])).toEqual(expectedNodeAndChangedSmokeScope);
    expect(detectChangedScope(["src/plugin-sdk/provider-entry.ts"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope(["packages/gateway-protocol/src/schema/messages.ts"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope(["packages/gateway-client/src/client.ts"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope(["src/channels/plugins/catalog.ts"])).toEqual(
      expectedNodeAndChangedSmokeScope,
    );
    expect(detectChangedScope([bundledPluginFile("matrix", "index.ts")])).toEqual(
      expectedNodeOnlyScope,
    );
  });

  it("splits install smoke into fast and full scopes", () => {
    expect(detectInstallSmokeScope([])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: true,
    });
    expect(detectInstallSmokeScope(["docs/ci.md"])).toEqual({
      runFastInstallSmoke: false,
      runFullInstallSmoke: false,
    });
    expect(detectInstallSmokeScope(["scripts/install.sh"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: true,
    });
    expect(detectInstallSmokeScope(["scripts/install-cli.sh"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: true,
    });
    expect(detectInstallSmokeScope(["scripts/install.ps1"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: true,
    });
    expect(detectInstallSmokeScope(["Dockerfile"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: true,
    });
    expect(detectInstallSmokeScope([bundledPluginFile("matrix", "package.json")])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: false,
    });
    expect(detectInstallSmokeScope(["src/plugins/loader.ts"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: false,
    });
    expect(detectInstallSmokeScope(["packages/gateway-client/src/client.ts"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: false,
    });
    expect(detectInstallSmokeScope([bundledPluginFile("matrix", "index.ts")])).toEqual({
      runFastInstallSmoke: false,
      runFullInstallSmoke: false,
    });
  });

  it("keeps changed-smoke off for runtime-surface tests", () => {
    expect(detectChangedScope(["src/plugins/loader.test.ts"])).toEqual(expectedNodeOnlyScope);
    expect(detectChangedScope([bundledPluginFile("matrix", "index.test.ts")])).toEqual(
      expectedNodeOnlyScope,
    );
  });

  it("runs control-ui locale check only for control-ui i18n surfaces", () => {
    const expected = expectedScope({ runNode: true, runControlUiI18n: true, runUiTests: true });
    expect(detectChangedScope(["ui/src/i18n/locales/en.ts"])).toEqual(expected);

    for (const scriptPath of [
      "scripts/control-ui-i18n.ts",
      "scripts/control-ui-i18n-verify.ts",
      "scripts/lib/control-ui-i18n-catalog.ts",
      "scripts/lib/control-ui-i18n-raw-copy.ts",
      "scripts/lib/control-ui-i18n-sync-plan.ts",
    ]) {
      expect(detectChangedScope([scriptPath])).toEqual({ ...expected, runUiTests: false });
    }
  });

  it.each([
    "ui/src/pages/chat/chat-realtime.test.ts",
    "ui/package.json",
    "test/vitest/vitest.shared.config.ts",
    "scripts/ensure-playwright-chromium.mts",
  ])("runs control-ui tests for %s", (changedPath) => {
    expect(detectChangedScope([changedPath]).runUiTests).toBe(true);
  });

  it("identifies plugin contract helper changes as fast Node-only CI scope", () => {
    const bundledCapabilityMetadataPath = [
      "src/plugins/contracts",
      "inventory/bundled-capability-metadata.ts",
    ].join("/");
    expect(
      detectNodeFastScope([
        bundledCapabilityMetadataPath,
        "src/plugins/contracts/registry.ts",
        "src/plugins/contracts/tts-contract-suites.ts",
        "scripts/test-projects.test-support.mts",
        "test/scripts/test-projects.test.ts",
      ]),
    ).toEqual({
      runFastOnly: true,
      runPluginContracts: true,
      runCiRouting: true,
    });
  });

  it("identifies CI routing changes as fast Node-only CI scope", () => {
    expect(
      detectNodeFastScope([
        "scripts/check-changed.mjs",
        "scripts/ci-changed-scope.mjs",
        "scripts/run-vitest.mts",
        "scripts/test-projects.test-support.mts",
        "scripts/lib/ci-docker-seed-plan.mts",
        "test/scripts/ci-docker-seed-plan.test.ts",
        "src/commands/status.scan-result.test.ts",
        "src/scripts/ci-changed-scope.control-ui.test.ts",
        "src/scripts/ci-changed-scope.native-i18n.test.ts",
        "src/scripts/ci-changed-scope.test.ts",
        "src/scripts/ci-changed-scope.windows.test.ts",
        "test/scripts/changed-lanes.test.ts",
        "test/scripts/run-vitest.test.ts",
        "test/scripts/test-projects.test.ts",
        "docs/ci.md",
      ]),
    ).toEqual({
      runFastOnly: true,
      runPluginContracts: false,
      runCiRouting: true,
    });
  });

  it("keeps CI workflow edits off fast-only scope so native lanes can run", () => {
    expect(detectNodeFastScope([".github/workflows/ci.yml"])).toEqual({
      runFastOnly: false,
      runPluginContracts: false,
      runCiRouting: false,
    });
  });

  it("keeps broad source changes on the full Node CI scope", () => {
    expect(
      detectNodeFastScope([
        "src/plugins/contracts/manifest-loader.ts",
        "src/plugins/contracts/registry.ts",
      ]),
    ).toEqual({
      runFastOnly: false,
      runPluginContracts: false,
      runCiRouting: false,
    });
  });

  it("treats base and head as literal git args", () => {
    const markerPath = path.join(
      os.tmpdir(),
      `openclaw-ci-changed-scope-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    markerPaths.push(markerPath);

    const injectedBase =
      process.platform === "win32"
        ? `HEAD & echo injected > "${markerPath}" & rem`
        : `HEAD; touch "${markerPath}" #`;

    let error: unknown;
    try {
      listChangedPaths(injectedBase, "HEAD");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(injectedBase);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("uses the merge commit first parent instead of a stale PR payload base", () => {
    const { repoDir, staleBase } = createSyntheticMergeRepo("openclaw-ci-scope-merge-");

    expect(
      execFileSync("git", ["diff", "--name-only", staleBase, "HEAD"], {
        cwd: repoDir,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .toSorted(),
    ).toEqual(["src/main-only.ts", "src/pr.ts"]);

    expect(listChangedPaths(staleBase, "HEAD", repoDir, true)).toEqual(["src/pr.ts"]);
  });

  it("reports both sides of a rename so deleted paths force safe planning", () => {
    const repoDir = tempDirs.make("openclaw-ci-scope-rename-");
    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.email", "ci@example.invalid"]);
    git(repoDir, ["config", "user.name", "CI"]);
    writeRepoFile(repoDir, "src/old.ts", "export const value = 1;\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "base"]);
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
    const repoDir = tempDirs.make("openclaw-ci-scope-raw-paths-");
    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.email", "ci@example.invalid"]);
    git(repoDir, ["config", "user.name", "CI"]);
    writeRepoFile(repoDir, "README.md", "base\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "base"]);
    const base = git(repoDir, ["rev-parse", "HEAD"]);
    const changedPaths = [" scripts/changed-lanes.mts", "scripts/changed\nlanes.mts"];
    for (const changedPath of changedPaths) {
      writeRepoFile(repoDir, changedPath, "export {};\n");
    }
    git(repoDir, ["add", "--", ...changedPaths]);
    git(repoDir, ["commit", "-m", "raw paths"]);

    expect(listChangedPaths(base, "HEAD", repoDir).toSorted()).toEqual(changedPaths.toSorted());
  });

  it("drops oversized changed-path payloads before workflow environment interpolation", () => {
    const outputPath = path.join(os.tmpdir(), `openclaw-ci-scope-output-${Date.now()}.txt`);
    markerPaths.push(outputPath);
    const changedPaths = Array.from(
      { length: 1_000 },
      (_, index) => `src/generated/${index}-${"x".repeat(100)}.ts`,
    );
    writeGitHubOutput(
      detectChangedScope(["docs/ci.md"]),
      outputPath,
      undefined,
      undefined,
      false,
      changedPaths,
    );

    expect(parseGitHubOutput(fs.readFileSync(outputPath, "utf8")).changed_paths_json).toBe("null");
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
      const repoDir = fs.realpathSync(tempDirs.make("openclaw-ci-scope-empty-"));
      const outputPath = path.join(repoDir, "github-output.txt");
      const scriptPath = path.join(repoDir, "scripts/ci-changed-scope.mjs");

      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "ci@example.invalid"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "CI"], { cwd: repoDir });
      for (const sourcePath of [
        "scripts/ci-changed-scope.mjs",
        "scripts/lib/arg-utils.runtime.mjs",
        "scripts/lib/changed-path-facts.mjs",
        "scripts/lib/ci-native-generated-scope.mjs",
        "scripts/lib/direct-run.mjs",
        "scripts/lib/merge-head-diff-base.mjs",
      ]) {
        writeRepoFile(repoDir, sourcePath, fs.readFileSync(path.resolve(sourcePath), "utf8"));
      }
      fs.writeFileSync(path.join(repoDir, "README.md"), "test\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir });
      execFileSync("git", ["commit", "-m", "test"], { cwd: repoDir });

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
          env: { ...process.env, GITHUB_OUTPUT: outputPath },
        },
      );

      const output = parseGitHubOutput(fs.readFileSync(outputPath, "utf8"));
      if (changedPath === "test/fixtures/talk-config-contract.json") {
        console.log(
          `REAL_CI_CHANGED_SCOPE_OUTPUT run_android=${output.run_android} run_macos=${output.run_macos} run_node=${output.run_node}`,
        );
      }
      expect(Object.keys(output).toSorted()).toEqual(
        "changed_paths_json node_test_data_only run_android run_changed_smoke run_control_ui_i18n run_fast_install_smoke run_full_install_smoke run_ios_build run_ios_screenshots run_macos run_macos_node run_native_i18n run_node run_node_fast_ci_routing run_node_fast_only run_node_fast_plugin_contracts run_skills_python run_ui_tests run_windows strict_control_ui_i18n strict_native_i18n".split(
          " ",
        ),
      );
      expect(output.changed_paths_json).toBe(
        failSafe ? "null" : JSON.stringify(changedPath ? [changedPath] : []),
      );
      expect(output.node_test_data_only).toBe("false");
      for (const [key, value] of Object.entries(output)) {
        if (key !== "changed_paths_json" && key !== "node_test_data_only") {
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
