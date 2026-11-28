import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";

function manifest(options: Omit<Parameters<typeof runCiManifestFixture>[0], "bundledPlanner">) {
  const result = runCiManifestFixture({ bundledPlanner: true, ...options });
  expect(result.status, result.output).toBe(0);
  return result;
}

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
