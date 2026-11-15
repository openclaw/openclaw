import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  usage: {
    providerUsage: {
      title: "Provider plans and billing",
      subtitle: "Plan, quota, balance, and budget details from your providers.",
      stalled: "Couldn’t finish loading provider usage. Refresh to try again.",
      unavailable: "Couldn’t load provider usage. Refresh to try again.",
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
      checkFailed: "Couldn’t check usage",
    },
  },
} satisfies TranslationMap;

export const registerProviderUsageEnglish = Object.assign(
  () => Object.assign(en.usage.providerUsage, catalog.usage.providerUsage),
  { catalog },
);
