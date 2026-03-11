import { buildUsageHttpErrorSnapshot, fetchJson } from "./provider-usage.fetch.shared.js";
import { PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

const KILOCODE_BALANCE_URL = "https://api.kilo.ai/api/profile/balance";

type KilocodeBalanceResponse = {
  balance?: number;
  isDepleted?: boolean;
};

export async function fetchKilocodeUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    KILOCODE_BALANCE_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return buildUsageHttpErrorSnapshot({ provider: "kilocode", status: res.status });
  }

  const data = (await res.json()) as KilocodeBalanceResponse;
  const balance = typeof data.balance === "number" ? data.balance : null;
  // Show credit balance as a plan label since Kilo's endpoint returns a dollar
  // amount rather than quota windows with usage percentages.
  const plan = balance !== null ? `$${balance.toFixed(2)}` : undefined;

  if (data.isDepleted) {
    return {
      provider: "kilocode",
      displayName: PROVIDER_LABELS.kilocode,
      windows: [],
      plan,
      error: "Depleted",
    };
  }

  return {
    provider: "kilocode",
    displayName: PROVIDER_LABELS.kilocode,
    windows: [],
    plan,
  };
}
