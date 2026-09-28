import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Fetches Gemini provider usage windows.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { fetchUsageJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, providerUsageLabel } from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "./provider-usage.types.js";

export async function fetchGeminiUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  provider: UsageProviderId,
): Promise<ProviderUsageSnapshot> {
  const parsed = await fetchUsageJson({
    provider,
    url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    timeoutMs,
    fetchFn,
  });
  if (!parsed.ok) {
    return parsed.snapshot;
  }
  const buckets =
    isRecord(parsed.data) && Array.isArray(parsed.data.buckets) ? parsed.data.buckets : [];
  const windows: UsageWindow[] = [];
  const families = [
    { label: "Pro", match: "pro", remaining: 1, found: false },
    { label: "Flash", match: "flash", remaining: 1, found: false },
  ];

  for (const bucket of buckets) {
    if (!isRecord(bucket)) {
      continue;
    }
    const model = typeof bucket.modelId === "string" ? bucket.modelId : "unknown";
    const frac = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : 1;
    const lower = normalizeLowercaseStringOrEmpty(model);
    for (const family of families) {
      if (lower.includes(family.match)) {
        family.found = true;
        if (frac < family.remaining) {
          family.remaining = frac;
        }
      }
    }
  }

  for (const family of families) {
    if (family.found) {
      windows.push({
        label: family.label,
        usedPercent: clampPercent((1 - family.remaining) * 100),
      });
    }
  }

  return {
    provider,
    displayName: expectDefined(providerUsageLabel(provider), "gemini provider usage label"),
    windows,
  };
}
