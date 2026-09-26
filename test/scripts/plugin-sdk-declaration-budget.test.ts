import { describe, expect, it } from "vitest";
import {
  MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
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

  it.each([
    [false, "public", MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES],
    [true, "private-qa-public-entry", MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES],
  ] as const)(
    "enforces the %s build's %s budget at its exact boundary",
    (buildPrivateQa, budgetKind, ratchetBytes) => {
      const budgetBytes = ratchetBytes + PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES;
      const expected = {
        budgetBytes,
        budgetKind,
        ratchetBytes,
        shouldFail: false,
        varianceBytes: PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
      };
      expect(
        evaluatePluginSdkDeclarationBudget({
          buildPrivateQa,
          declarationBytes: budgetBytes,
        }),
      ).toEqual(expected);
      expect(
        evaluatePluginSdkDeclarationBudget({
          buildPrivateQa,
          declarationBytes: budgetBytes + 1,
        }),
      ).toEqual({ ...expected, shouldFail: true });
    },
  );
});
