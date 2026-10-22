import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelAuthStatusProvider } from "../api/types.ts";
import { collectProviderQuotaGroups, formatQuotaReset } from "./provider-quota-summary.ts";

describe("formatQuotaReset", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00.000Z"));
  });
  afterEach(() => vi.restoreAllMocks());
  it.each([
    [30 * 60_000, "30m"],
    [135 * 60_000, "2h 15m"],
    [-1, "now"],
    [0, "now"],
    [1, "<1m"],
    [59_999, "<1m"],
    [60_000, "1m"],
  ] as const)("formats a reset %i ms away as %s", (offset, expected) => {
    expect(formatQuotaReset(Date.now() + offset)).toBe(expected);
  });
  it.each([8_640_000_000_000_001, Infinity])("ignores Date-invalid timestamp %s", (timestamp) => {
    expect(formatQuotaReset(timestamp)).toBeNull();
  });
});

function provider(
  id: string,
  usage: Partial<NonNullable<ModelAuthStatusProvider["usage"]>>,
): ModelAuthStatusProvider {
  return {
    provider: id,
    displayName: "Claude",
    status: "ok",
    profiles: [{ profileId: `${id}:default`, type: "oauth", status: "ok" }],
    usage: { providerId: id, windows: [], ...usage },
  };
}
const collect = (...providers: ModelAuthStatusProvider[]) =>
  collectProviderQuotaGroups({ ts: 1, providers }, () => true);

it("collapses providers sharing identical usage into one group", () => {
  const usage: NonNullable<ModelAuthStatusProvider["usage"]> = {
    providerId: "anthropic",
    plan: "Max (20x)",
    windows: [
      { label: "5h", usedPercent: 21.6, resetAt: 1_800_000_000_000 },
      { label: "Week", usedPercent: 25 },
    ],
    billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
  };
  expect(collect(provider("anthropic", usage), provider("claude-cli", usage))).toEqual([
    {
      providers: ["anthropic", "claude-cli"],
      displayName: "Claude",
      plan: "Max (20x)",
      windows: [
        { label: "5h", usedPercent: 22, resetAt: 1_800_000_000_000 },
        { label: "Week", usedPercent: 25 },
      ],
      budgets: [{ used: 157.85, limit: 400, unit: "USD" }],
    },
  ]);
});

it("carries the account email and keeps distinct accounts in separate groups", () => {
  const account = (id: string, accountEmail: string) =>
    provider(id, {
      providerId: "anthropic",
      accountEmail,
      windows: [{ label: "5h", usedPercent: 10 }],
    });
  const groups = collect(
    account("anthropic", "work@example.com"),
    account("claude-cli", "personal@example.com"),
  );
  expect(groups.map((group) => group.accountEmail)).toEqual([
    "work@example.com",
    "personal@example.com",
  ]);
});

it("drops providers without windows or budgets and invalid budget shapes", () => {
  expect(
    collect(
      provider("anthropic", {}),
      provider("openrouter", {
        billing: [
          { type: "balance", amount: 10, unit: "USD" },
          { type: "budget", used: 5, limit: 0, unit: "USD" },
        ],
      }),
      provider("openai", { windows: [{ label: "Week", usedPercent: 140 }] }),
    ),
  ).toEqual([
    {
      providers: ["openai"],
      displayName: "Claude",
      windows: [{ label: "Week", usedPercent: 100 }],
      budgets: [],
    },
  ]);
});
