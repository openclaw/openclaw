import { expect, it } from "vitest";
import type { ModelAuthStatusProvider } from "../api/types.ts";
import { collectProviderQuotaGroups } from "./provider-quota-summary.ts";

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
