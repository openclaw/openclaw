import { describe, expect, it } from "vitest";
import { classifyBundledExtensionSourcePath } from "../../scripts/lib/extension-source-classifier.mts";

function expectClassification(
  filePath: string,
  expected: Partial<ReturnType<typeof classifyBundledExtensionSourcePath>>,
) {
  expect(classifyBundledExtensionSourcePath(filePath)).toEqual({
    normalizedPath: filePath,
    isCodeFile: true,
    isRuntimeApiBarrel: false,
    isPublicApiBarrel: false,
    isTestLike: false,
    isInfraArtifact: false,
    isProductionSource: false,
    ...expected,
  });
}

describe("classifyBundledExtensionSourcePath", () => {
  it("treats runtime barrels as non-production source", () => {
    expectClassification("extensions/msteams/runtime-api.ts", {
      isRuntimeApiBarrel: true,
    });
  });

  it("treats extension tests and fixtures as test-like across naming styles", () => {
    for (const filePath of [
      "extensions/feishu/src/monitor-handler.test.ts",
      "extensions/discord/src/test-fixtures/message.ts",
      "extensions/telegram/src/bot.test-harness.ts",
      "extensions/telegram/src/target-writeback.test-shared.ts",
    ]) {
      expectClassification(filePath, { isTestLike: true });
    }
  });

  it("keeps normal extension production files eligible for guardrails", () => {
    expectClassification("extensions/msteams/src/send.ts", {
      isProductionSource: true,
    });
  });
});
