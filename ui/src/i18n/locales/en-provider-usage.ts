import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  usage: {
    providerUsage: {
      title: "Provider plans & billing",
      subtitle: "Live plan, quota, balance, and budget data reported by configured providers.",
      stalled: "Provider usage did not finish loading. Refresh to retry.",
      unavailable: "Provider usage is unavailable; the last request failed. Refresh to retry.",
      balance: "Balance",
      spend: "Usage",
      budget: "Budget",
      today: "Today",
      last7Days: "7 days",
      lastDays: "{count} days",
      dailyCost: "Daily provider cost",
      requests: "{count} requests",
      inputTokens: "{count} input",
      cacheTokens: "{count} cache",
      outputTokens: "{count} output",
      topModels: "Top models",
      costCategories: "Cost categories",
      remaining: "{percent}% left",
      resets: "Resets {date}",
      exhausted: "{label} is used up.",
      checkFailed: "Check failed",
      exhaustedUntil: "{label} is used up until {date}.",
    },
  },
} satisfies TranslationMap;

export const registerProviderUsageEnglish = Object.assign(
  () => Object.assign(en.usage.providerUsage, catalog.usage.providerUsage),
  { catalog },
);
