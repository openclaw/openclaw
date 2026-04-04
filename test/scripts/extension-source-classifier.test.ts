import { describe, expect, it } from "vitest";
import { classifyBundledExtensionSourcePath } from "../../scripts/lib/extension-source-classifier.mjs";

describe("classifyBundledExtensionSourcePath", () => {
  it("treats runtime barrels as non-production source", () => {
    expect(classifyBundledExtensionSourcePath("extensions/msteams/runtime-api.ts")).toMatchObject({
      isCodeFile: true,
      isRuntimeApiBarrel: true,
      isTestLike: false,
      isProductionSource: false,
    });
  });

  it("treats extension tests and fixtures as test-like across naming styles", () => {
    expect(
      classifyBundledExtensionSourcePath("extensions/feishu/src/monitor-handler.test.ts"),
    ).toMatchObject({
      isTestLike: true,
      isProductionSource: false,
    });
    expect(
      classifyBundledExtensionSourcePath("extensions/discord/src/test-fixtures/message.ts"),
    ).toMatchObject({
      isTestLike: true,
      isProductionSource: false,
    });
    expect(
      classifyBundledExtensionSourcePath("extensions/telegram/src/bot.test-harness.ts"),
    ).toMatchObject({
      isTestLike: true,
      isProductionSource: false,
    });
    expect(
      classifyBundledExtensionSourcePath("extensions/telegram/src/target-writeback.test-shared.ts"),
    ).toMatchObject({
      isTestLike: true,
      isProductionSource: false,
    });
  });

  it("keeps normal extension production files eligible for guardrails", () => {
    expect(classifyBundledExtensionSourcePath("extensions/msteams/src/send.ts")).toMatchObject({
      isCodeFile: true,
      isRuntimeApiBarrel: false,
      isTestLike: false,
      isProductionSource: true,
    });
  });
});
