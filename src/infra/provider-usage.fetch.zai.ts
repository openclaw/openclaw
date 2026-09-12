// Fetches and normalizes Z.ai provider usage records.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  fetchUsageJson,
  parseFiniteNumber,
  parseUsageResetAt,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type NormalizedZaiLimit = {
  type?: string;
  percentage?: number;
  unit?: number;
  number?: number;
  nextResetTime?: string;
};

type NormalizedZaiUsage =
  | { ok: false; message?: string }
  | {
      ok: true;
      plan?: string;
      limits: NormalizedZaiLimit[];
    };

function normalizeZaiUsage(value: unknown): NormalizedZaiUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const message = normalizeOptionalString(value.msg);
  // Numeric fields arrive as numbers in most responses, but Z.ai has been
  // observed returning string-typed numerics (e.g. "200", "40"). Parse both
  // forms like the sibling provider fetchers do, so a valid window is never
  // silently treated as missing/zero.
  if (value.success !== true || parseFiniteNumber(value.code) !== 200) {
    return { ok: false, message };
  }

  const data = isRecord(value.data) ? value.data : {};
  const rawLimits = Array.isArray(data.limits) ? data.limits : [];

  const limits: NormalizedZaiLimit[] = [];
  for (const rawLimit of rawLimits) {
    if (!isRecord(rawLimit)) {
      continue;
    }
    limits.push({
      type: normalizeOptionalString(rawLimit.type),
      percentage: parseFiniteNumber(rawLimit.percentage),
      unit: parseFiniteNumber(rawLimit.unit),
      number: parseFiniteNumber(rawLimit.number),
      nextResetTime: normalizeOptionalString(rawLimit.nextResetTime),
    });
  }

  return {
    ok: true,
    plan: normalizeOptionalString(data.planName) ?? normalizeOptionalString(data.plan),
    limits,
  };
}

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
  const usage = normalizeZaiUsage(parsed.data);
  if (!usage || !usage.ok) {
    return {
      provider: "zai",
      displayName: PROVIDER_LABELS.zai,
      windows: [],
      error: usage?.message || "API error",
    };
  }

  const windows: UsageWindow[] = [];
  for (const limit of usage.limits) {
    const percent = clampPercent(limit.percentage ?? 0);
    const nextReset = parseUsageResetAt(limit.nextResetTime);
    let windowLabel = "Limit";
    if (limit.unit === 1 && limit.number !== undefined) {
      windowLabel = `${limit.number}d`;
    } else if (limit.unit === 3 && limit.number !== undefined) {
      windowLabel = `${limit.number}h`;
    } else if (limit.unit === 5 && limit.number !== undefined) {
      windowLabel = `${limit.number}m`;
    }

    if (limit.type === "TOKENS_LIMIT") {
      windows.push({
        label: `Tokens (${windowLabel})`,
        usedPercent: percent,
        resetAt: nextReset,
      });
    } else if (limit.type === "TIME_LIMIT") {
      windows.push({
        label: "Monthly",
        usedPercent: percent,
        resetAt: nextReset,
      });
    }
  }

  return {
    provider: "zai",
    displayName: PROVIDER_LABELS.zai,
    windows,
    plan: usage.plan,
  };
}
