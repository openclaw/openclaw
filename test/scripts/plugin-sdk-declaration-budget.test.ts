import { describe, expect, it } from "vitest";
import {
  MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
  PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
  evaluatePluginSdkDeclarationBudget,
  isPrivateQaPluginSdkBuild,
} from "../../scripts/lib/plugin-sdk-declaration-budget.mts";

describe("plugin SDK declaration budget", () => {
  it("selects private QA mode only for the explicit build flag", () => {
    expect(isPrivateQaPluginSdkBuild({})).toBe(false);
    expect(isPrivateQaPluginSdkBuild({ OPENCLAW_BUILD_PRIVATE_QA: "0" })).toBe(false);
    expect(isPrivateQaPluginSdkBuild({ OPENCLAW_BUILD_PRIVATE_QA: "1" })).toBe(true);
  });

  it("enforces the publication budget at its exact boundary", () => {
    const ratchetBytes = MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES;
    const budgetBytes = ratchetBytes + PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES;
    const expected = {
      budgetBytes,
      ratchetBytes,
      shouldFail: false,
      varianceBytes: PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
    };
    expect(
      evaluatePluginSdkDeclarationBudget({
        declarationBytes: budgetBytes,
      }),
    ).toEqual(expected);
    expect(
      evaluatePluginSdkDeclarationBudget({
        declarationBytes: budgetBytes + 1,
      }),
    ).toEqual({ ...expected, shouldFail: true });
  });
});
