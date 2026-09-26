import { describe, expect, it } from "vitest";
import { detectChangedScope, shouldRunNativeI18n } from "../../scripts/ci-changed-scope.mjs";
import { isNativeGeneratedOnlyChange } from "../../scripts/lib/ci-native-generated-scope.mjs";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";

describe("generated native locale scope", () => {
  it.each([
    ["apps/.i18n/native/de.json"],
    ["apps/ios/Resources/Localizable.xcstrings"],
    ["apps/android/app/src/main/java/ai/openclaw/app/i18n/NativeStringResources.kt"],
    [
      "apps/android/app/src/main/res/values-de/strings.xml",
      "apps/android/app/src/main/res/values/strings.xml",
    ],
  ])("recognizes generated artifacts while retaining their verifier (%j)", (...paths) => {
    expect(isNativeGeneratedOnlyChange(paths)).toBe(true);
    expect(shouldRunNativeI18n(paths)).toBe(true);
    // The fact does not globally disable main's ordinary changed-scope coverage.
    const scope = detectChangedScope(paths);
    expect(scope.runNode || scope.runIosBuild || scope.runAndroid).toBe(true);
  });

  it.each(
    [
      null,
      [],
      ["apps/android/app/src/main/res/values/strings.xml"],
      ["apps/.i18n/native-source.json"],
      ["apps/.i18n/native/de.json", "apps/ios/Sources/Example.swift"],
      ["apps/.i18n/native/de.json", "src/infra/example.ts"],
      ["apps/.i18n/native/de.json", "pnpm-lock.yaml"],
      ["apps/.i18n/native/de.json", "docs/example.md"],
    ].map((paths) => ({ paths })),
  )("retains ordinary coverage for incomplete or mixed diffs ($paths)", ({ paths }) => {
    expect(isNativeGeneratedOnlyChange(paths)).toBe(false);
  });
  it.each([
    { eventName: "pull_request" as const, author: "Bot", full: false, runBuilds: false },
    { eventName: "pull_request" as const, author: "User", full: false, runBuilds: true },
    { eventName: "pull_request" as const, author: "Bot", full: true, runBuilds: true },
    { eventName: "push" as const, author: "Bot", full: false, runBuilds: true },
    { eventName: "workflow_dispatch" as const, author: "Bot", full: false, runBuilds: true },
  ])(
    "keeps the generated-only reduction scoped to bot PRs ($eventName/$author/full=$full)",
    ({ eventName, author, full, runBuilds }) => {
      const result = runCiManifestFixture({
        bundledPlanner: true,
        eventName,
        historicalCompatibility: false,
        nativeI18nCapabilities: true,
        iosCapabilities: true,
        androidCiCapabilities: true,
        changedPaths: ["apps/ios/Resources/Localizable.xcstrings"],
        changedPlannerDependencies: ["scripts/lib/ci-native-generated-scope.mjs"],
        scopeEnv: {
          OPENCLAW_CI_PR_AUTHOR_TYPE: author,
          OPENCLAW_CI_FULL: String(full),
          OPENCLAW_CI_RUN_WINDOWS: "false",
          OPENCLAW_CI_RUN_UI_TESTS: "false",
          OPENCLAW_CI_RUN_CONTROL_UI_I18N: "false",
          OPENCLAW_CI_RUN_SKILLS_PYTHON: "false",
        },
      });
      expect(result.status, result.output).toBe(0);
      expect(result.outputs.run_node).toBe(String(runBuilds));
      expect(result.outputs.run_macos).toBe(String(runBuilds));
      expect(result.outputs.run_ios_build).toBe(String(runBuilds));
      expect(result.outputs.run_android_job).toBe(String(runBuilds));
      expect(result.outputs.run_native_i18n).toBe("true");
    },
  );
});
