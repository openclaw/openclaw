import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildUsageErrorSnapshot,
  fetchUsageJson,
  parseUsageResetAt,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

export async function fetchZaiUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const parsed = await fetchUsageJson({
    provider: "zai",
    url: "https://api.z.ai/api/monitor/usage/quota/limit",
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
  const usage = isRecord(parsed.data) ? parsed.data : undefined;
  if (usage?.success !== true || asFiniteNumber(usage.code) !== 200) {
    return buildUsageErrorSnapshot("zai", normalizeOptionalString(usage?.msg) || "API error");
  }

  const data = isRecord(usage.data) ? usage.data : {};
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const windows: UsageWindow[] = [];
  for (const limit of limits) {
    if (!isRecord(limit)) {
      continue;
    }
    const type = normalizeOptionalString(limit.type);
    const percent = clampPercent(asFiniteNumber(limit.percentage) ?? 0);
    const unit = asFiniteNumber(limit.unit);
    const number = asFiniteNumber(limit.number);
    const nextReset = parseUsageResetAt(normalizeOptionalString(limit.nextResetTime));
    let windowLabel = "Limit";
    if (unit === 1 && number !== undefined) {
      windowLabel = `${number}d`;
    } else if (unit === 3 && number !== undefined) {
      windowLabel = `${number}h`;
    } else if (unit === 5 && number !== undefined) {
      windowLabel = `${number}m`;
    }

    if (type === "TOKENS_LIMIT" || type === "TIME_LIMIT") {
      windows.push({
        label: type === "TOKENS_LIMIT" ? `Tokens (${windowLabel})` : "Monthly",
        usedPercent: percent,
        resetAt: nextReset,
      });
    }
  }

  return {
    provider: "zai",
    displayName: PROVIDER_LABELS.zai,
    windows,
    plan: normalizeOptionalString(data.planName) ?? normalizeOptionalString(data.plan),
  };
}
