import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { detectChangedScope, shouldRunNativeI18n } from "../../scripts/ci-changed-scope.mjs";
import { isNativeGeneratedOnlyChange } from "../../scripts/lib/ci-native-generated-scope.mjs";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";

describe("native protocol generation scope", () => {
  it.each(["packages/gateway-protocol/src/schema/frames.ts", "scripts/protocol-gen-swift.ts"])(
    "builds native consumers when only %s changes",
    (file) => {
      expect(detectChangedScope([file])).toMatchObject({
        runMacos: true,
        runIosBuild: true,
        runAndroid: true,
      });
    },
  );
});

describe("generated native locale scope", () => {
  it.each<{ paths: string[] | null; generated: boolean }>([
    { paths: ["apps/.i18n/native/de.json"], generated: true },
    { paths: ["apps/ios/Resources/Localizable.xcstrings"], generated: true },
    {
      paths: [
        "apps/android/app/src/main/res/values-de/strings.xml",
        "apps/android/app/src/main/res/values/strings.xml",
      ],
      generated: true,
    },
    { paths: null, generated: false },
    { paths: [], generated: false },
    { paths: ["apps/android/app/src/main/res/values/strings.xml"], generated: false },
    { paths: ["apps/.i18n/native/de.json", "apps/ios/Sources/Example.swift"], generated: false },
  ])(
    "classifies generated-only diffs and retains their verifier ($paths)",
    ({ paths, generated }) => {
      expect(isNativeGeneratedOnlyChange(paths)).toBe(generated);
      if (generated && paths) {
        expect(shouldRunNativeI18n(paths)).toBe(true);
        const scope = detectChangedScope(paths);
        expect(scope.runNode || scope.runIosBuild || scope.runAndroid).toBe(true);
      }
    },
  );

  it("refreshes and publishes the generated Tauri shell catalog for PT-PT", () => {
    const workflow = parseYaml(
      readFileSync(
        new URL("../../.github/workflows/native-app-locale-refresh.yml", import.meta.url),
        "utf8",
      ),
    ) as {
      on: { push: { paths: string[] } };
      jobs: {
        refresh: { strategy: { matrix: { locale: string[] } } };
        finalize: { steps: Array<{ uses?: string; with?: Record<string, string> }> };
      };
    };
    const publisher = workflow.jobs.finalize.steps.find(
      (step) => step.uses === "./.github/actions/publish-generated-pr",
    );
    expect(workflow.on.push.paths).toContain("apps/linux/i18n/**");
    expect(workflow.jobs.refresh.strategy.matrix.locale).toContain("pt-PT");
    expect(publisher?.with?.["generated-paths"]).toContain("apps/linux/ui/i18n/catalog.json");
    expect(publisher?.with?.["generated-paths"]).toContain("apps/linux/ui/i18n/catalog.js");
    expect(publisher?.with?.["invalidation-paths"]).toContain("apps/linux/i18n/en.json");
    expect(publisher?.with?.["invalidation-paths"]).toContain("scripts/tauri-app-i18n.ts");
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
      expect(result.outputs.run_macos).toBe(String(runBuilds && eventName !== "pull_request"));
      expect(result.outputs.run_ios_build).toBe(String(runBuilds && eventName !== "pull_request"));
      expect(result.outputs.run_android_job).toBe(String(runBuilds));
      expect(result.outputs.run_native_i18n).toBe("true");
    },
  );
});
