// Fetches and normalizes DeepSeek provider usage records.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  buildUsageErrorSnapshot,
  fetchUsageJson,
  parseFiniteNumber,
} from "./provider-usage.fetch.shared.js";
import { PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

type DeepSeekBalanceInfo = {
  currency?: string;
  total_balance?: string | number | null;
  granted_balance?: string | number | null;
  topped_up_balance?: string | number | null;
};

type DeepSeekBalanceResponse = {
  is_available?: boolean;
  balance_infos?: DeepSeekBalanceInfo[];
};

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

function formatCurrencyAmount(amount: number, currency?: string): string {
  if (currency === "CNY" || currency === "RMB") {
    return `¥${amount.toFixed(2)}`;
  }
  if (currency === "USD") {
    return `$${amount.toFixed(2)}`;
  }
  return currency ? `${amount.toFixed(2)} ${currency}` : amount.toFixed(2);
}

export async function fetchDeepSeekUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const parsed = await fetchUsageJson({
    provider: "deepseek",
    url: DEEPSEEK_BALANCE_URL,
    init: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
    timeoutMs,
    fetchFn,
  });
  if (!parsed.ok) {
    return parsed.snapshot;
  }

  const data = isRecord(parsed.data) ? (parsed.data as DeepSeekBalanceResponse) : undefined;
  const balances = data && Array.isArray(data.balance_infos) ? data.balance_infos : [];
  const parts: string[] = [];
  const billing: NonNullable<ProviderUsageSnapshot["billing"]> = [];
  for (const info of balances) {
    const amount = parseFiniteNumber(info.total_balance);
    if (amount === undefined) {
      continue;
    }
    const granted = parseFiniteNumber(info.granted_balance);
    const toppedUp = parseFiniteNumber(info.topped_up_balance);
    const currency = info.currency;
    const normalized = currency?.trim().toUpperCase();
    parts.push(`Balance ${formatCurrencyAmount(amount, normalized)}`);
    if (granted !== undefined && granted > 0) {
      parts.push(`Granted ${formatCurrencyAmount(granted, normalized)}`);
    }
    if (toppedUp !== undefined && toppedUp > 0 && toppedUp !== amount) {
      parts.push(`Topped up ${formatCurrencyAmount(toppedUp, normalized)}`);
    }
    if (amount >= 0) {
      billing.push({ type: "balance", amount, unit: normalized || "credits" });
    }
  }
  const summary = parts.join(" · ");
  if (!summary) {
    return buildUsageErrorSnapshot("deepseek", "No balance data");
  }

  return {
    provider: "deepseek",
    displayName: PROVIDER_LABELS.deepseek,
    windows: [],
    billing,
    summary,
    ...(data?.is_available === false ? { plan: "Unavailable" } : {}),
  };
}
