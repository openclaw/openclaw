import { describe, expect, it } from "vitest";
import {
  MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
  PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
  evaluatePluginSdkDeclarationBudget,
  isPrivateQaPluginSdkBuild,
} from "../../scripts/lib/plugin-sdk-declaration-budget.mts";
import { publicPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mts";

// #129388 continuation public surface, measured by check-plugin-sdk-exports on clean `pnpm build`s.
const continuationDeclarationGrowth = {
  previousRatchetBytes: 5_320_000,
  upstreamBytes: 5_376_289, // upstream 41bdde2111
  candidateBytes: 5_397_222, // continuation candidate 04b22c0682
  // Public roots that publish the continuation contracts, and the bundled plugins reading them.
  consumers: {
    "agent-harness": ["extensions/codex (disableContinuationTools)"],
    "agent-harness-runtime": [
      "extensions/codex (continueWorkOpts, requestCompactionOpts, drainsContinuationDelegateQueue)",
    ],
    "diagnostic-runtime": [
      "extensions/codex (runWithDiagnosticTraceContext)",
      "extensions/diagnostics-otel (DiagnosticTraceContext.parentSpanIdSource)",
    ],
    "session-store-runtime": ["core (SessionEntry continuation fields)"],
    "system-event-runtime": ["core (SystemEvent managed delivery fields)"],
    "reply-runtime": ["core (GetReplyOptions continuation trigger and lineage)"],
    "config-contracts": ["core (agents.defaults.continuation)"],
    core: ["core (SubagentRunRecord continuation and spawn custody fields)"],
  },
};

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

  it("raises only the ratchet, by the measured continuation growth", () => {
    const { previousRatchetBytes, upstreamBytes, candidateBytes, consumers } =
      continuationDeclarationGrowth;
    const fits = (declarationBytes: number) =>
      !evaluatePluginSdkDeclarationBudget({ declarationBytes }).shouldFail;
    // Unrelated growth keeps exactly the headroom upstream had before the continuation surface.
    const upstreamHeadroomBytes =
      previousRatchetBytes + PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES - upstreamBytes;
    expect(fits(candidateBytes)).toBe(true);
    expect(fits(candidateBytes + upstreamHeadroomBytes)).toBe(true);
    expect(fits(candidateBytes + upstreamHeadroomBytes + 1)).toBe(false);
    expect(MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES).toBe(
      previousRatchetBytes + candidateBytes - upstreamBytes,
    );
    expect(PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES).toBe(64 * 1024);
    expect(
      Object.keys(consumers).filter((root) => !publicPluginSdkEntrypoints.includes(root)),
    ).toEqual([]);
  });
});
