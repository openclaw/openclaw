import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import {
  CI_MANIFEST_FIXTURE_TARGETS,
  runCiManifestFixture,
} from "./ci-workflow-manifest.test-support.js";

function manifest(options: Omit<Parameters<typeof runCiManifestFixture>[0], "bundledPlanner">) {
  const result = runCiManifestFixture({ bundledPlanner: true, ...options });
  expect(result.status, result.output).toBe(0);
  return result;
}
const heavyLanes = [
  "run_ui_real_gateway",
  "run_checks_windows",
  "run_macos_node",
  "run_macos_swift",
  "run_ios_build",
  "run_android_screenshots",
  "run_published_driver_update",
] as const;

it("does not budget a disabled PR screenshot request", () => {
  const results = ["false", "true"].map((hint) => {
    const result = manifest({
      runnerProfile: "hybrid",
      eventName: "pull_request",
      changedPaths: ["apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt"],
      scopeEnv: { OPENCLAW_CI_RUN_ANDROID_SCREENSHOTS: hint },
    });
    expect(result.outputs.run_android_screenshots).toBe("false");
    return result.outputs;
  });
  const disabledHint = expectDefined(results[0], "disabled screenshot hint");
  const enabledHint = expectDefined(results[1], "enabled screenshot hint");
  for (const key of ["hybrid_hosted_base_rows", "hybrid_hosted_total_rows"]) {
    expect(expectDefined(enabledHint[key], key)).toBe(expectDefined(disabledHint[key], key));
  }
});

it.each([
  { eventName: "pull_request", headRepository: "openclaw/openclaw", deferred: true },
  { eventName: "pull_request", headRepository: "contributor/openclaw", deferred: true },
  { eventName: "push", deferred: false },
  { eventName: "schedule", deferred: false },
  { eventName: "workflow_dispatch", deferred: false },
  { eventName: "workflow_dispatch", releaseGate: true, deferred: false },
] as const)("selects heavy lanes for $eventName $headRepository $releaseGate", (scenario) => {
  const { eventName, deferred } = scenario;
  const releaseGate = "releaseGate" in scenario && scenario.releaseGate;
  const revision = "a".repeat(40);
  const result = manifest({
    historicalCompatibility: false,
    iosCapabilities: true,
    macosNodeParts: true,
    protocolCoverage: true,
    openClawKitTests: true,
    eventName,
    releaseGate,
    changedPaths: ["src/infra/update-runner.ts", "apps/ios/Sources/Main.swift"],
    selectedTestTargets: Object.values(CI_MANIFEST_FIXTURE_TARGETS).flat(),
    scopeEnv: {
      OPENCLAW_CI_HEAD_REPOSITORY:
        "headRepository" in scenario
          ? expectDefined(scenario.headRepository, "PR head repository")
          : "openclaw/openclaw",
      OPENCLAW_CI_WORKFLOW_REVISION: revision,
      OPENCLAW_CI_VALIDATION_TIER: eventName === "schedule" ? "main" : "full",
      OPENCLAW_CI_RUN_ANDROID_SCREENSHOTS: "true",
      OPENCLAW_CI_RUN_UI_TESTS: "true",
    },
  });
  expect(result.outputs.run_pr_madge_import_cycles).toBe(String(deferred));
  expect(result.outputs.run_pr_kysely_guardrails).toBe(String(deferred));
  for (const flag of heavyLanes) {
    expect(result.outputs[flag], flag).toBe(String(!deferred));
  }
});
