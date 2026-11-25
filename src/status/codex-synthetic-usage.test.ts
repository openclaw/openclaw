import { describe, expect, it } from "vitest";
import type { ProviderUsageSnapshot } from "../infra/provider-usage.types.js";
import { mergeUsageSummaries } from "./codex-synthetic-usage.js";

function mergeOpenAIUsage(
  base: Omit<ProviderUsageSnapshot, "provider" | "displayName">,
  synthetic: Omit<ProviderUsageSnapshot, "provider" | "displayName">,
) {
  return mergeUsageSummaries(
    { updatedAt: 1, providers: [{ provider: "openai", displayName: "OpenAI", ...base }] },
    { updatedAt: 2, providers: [{ provider: "openai", displayName: "Codex", ...synthetic }] },
  );
}

const week = { windows: [{ label: "Week", usedPercent: 40 }] };
const shortWindow = { windows: [{ label: "5h", usedPercent: 10 }] };
const balance = { type: "balance", amount: 12.5, unit: "credits" } as const;
const spend = { type: "spend", amount: 20, unit: "usd", period: "month" } as const;

describe("mergeUsageSummaries", () => {
  it("preserves OAuth plan and billing when synthetic Codex windows win", () => {
    const merged = mergeOpenAIUsage({ ...week, plan: "Plus", billing: [balance] }, shortWindow);
    expect(merged).toEqual({
      updatedAt: 1,
      providers: [
        {
          provider: "openai",
          displayName: "Codex",
          plan: "Plus",
          ...shortWindow,
          billing: [balance],
          error: undefined,
        },
      ],
    });
  });

  it("lets preferred billing replace duplicate secondary entries without dropping siblings", () => {
    const merged = mergeOpenAIUsage(
      { ...week, billing: [balance, spend] },
      { ...shortWindow, billing: [{ ...balance, amount: 8 }] },
    );
    expect(merged.providers[0]?.billing).toEqual([{ ...balance, amount: 8 }, spend]);
  });

  it.each([
    [
      "billing above errors",
      { billing: [{ ...balance, amount: 4 }] },
      "Unavailable",
      { billing: [{ ...balance, amount: 4 }], error: undefined },
    ],
    [
      "endpoint error above fallback error",
      { error: "Admin API key required" },
      "Codex account authentication required",
      { error: "Admin API key required" },
    ],
  ] satisfies Array<
    [string, Partial<ProviderUsageSnapshot>, string, Partial<ProviderUsageSnapshot>]
  >)("prefers %s", (_name, base, error, expected) => {
    const merged = mergeOpenAIUsage({ windows: [], ...base }, { windows: [], error });
    expect(merged.providers[0]).toMatchObject({ displayName: "OpenAI", ...expected });
  });
});
