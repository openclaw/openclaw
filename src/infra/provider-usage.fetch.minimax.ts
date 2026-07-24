// Fetches and normalizes MiniMax provider usage records.
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { isRecord } from "../utils.js";
import { readTrimmedStringAlias } from "../utils/string-readers.js";
import {
  buildUsageHttpErrorSnapshot,
  discardUsageResponseBody,
  fetchJson,
  parseFiniteNumber,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type MinimaxBaseResp = {
  status_code?: number;
  status_msg?: string;
};

type MinimaxUsageResponse = {
  base_resp?: MinimaxBaseResp;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

type FetchMinimaxUsageOptions = {
  baseUrl?: string;
};

const DEFAULT_MINIMAX_USAGE_ORIGIN = "https://api.minimaxi.com";
const MINIMAX_USAGE_PATH = "/v1/token_plan/remains";

const RESET_KEYS = [
  "reset_at",
  "resetAt",
  "reset_time",
  "resetTime",
  "next_reset_at",
  "nextResetAt",
  "next_reset_time",
  "nextResetTime",
  "expires_at",
  "expiresAt",
  "expire_at",
  "expireAt",
  "end_time",
  "endTime",
  "window_end",
  "windowEnd",
] as const;

const PERCENT_KEYS = [
  "used_percent",
  "usedPercent",
  "used_rate",
  "usage_rate",
  "used_ratio",
  "usage_ratio",
  "usedRatio",
  "usageRatio",
] as const;

// MiniMax's usage_percent / usagePercent fields report the remaining quota
// as a percentage, not the consumed quota. Treat them as "remaining percent"
// and invert to get usedPercent. Count-based fromCounts always takes priority.
// current_interval_remaining_percent and current_weekly_remaining_percent are
// fields in the current MiniMax coding-plan API response shape (model_remains
// entries with model_name: "general" / "video"). See #110887.
//
// Interval and weekly remaining-percent keys are intentionally split: the
// interval weeklies are used in deriveUsedPercent (interval window), while
// the combined set is used in pickChatModelRemains for loose candidate
// matching. Using only interval keys in deriveUsedPercent avoids
// misrepresenting weekly quota as interval usage with mismatched timing
// metadata (start_time / end_time vs weekly_start_time / weekly_end_time).
const INTERVAL_REMAINING_PERCENT_KEYS = [
  "usage_percent",
  "usagePercent",
  "current_interval_remaining_percent",
  "currentIntervalRemainingPercent",
] as const;

const WEEKLY_REMAINING_PERCENT_KEYS = [
  "current_weekly_remaining_percent",
  "currentWeeklyRemainingPercent",
] as const;

const REMAINING_PERCENT_KEYS = [
  ...INTERVAL_REMAINING_PERCENT_KEYS,
  ...WEEKLY_REMAINING_PERCENT_KEYS,
] as const;

const USED_KEYS = [
  "used",
  "usage",
  "used_amount",
  "usedAmount",
  "used_tokens",
  "usedTokens",
  "used_quota",
  "usedQuota",
  "used_times",
  "usedTimes",
  "prompt_used",
  "promptUsed",
  "used_prompt",
  "usedPrompt",
  "prompts_used",
  "promptsUsed",
  "consumed",
] as const;

const TOTAL_KEYS = [
  "total",
  "total_amount",
  "totalAmount",
  "total_tokens",
  "totalTokens",
  "total_quota",
  "totalQuota",
  "total_times",
  "totalTimes",
  "prompt_total",
  "promptTotal",
  "total_prompt",
  "totalPrompt",
  "prompt_limit",
  "promptLimit",
  "limit_prompt",
  "limitPrompt",
  "prompts_total",
  "promptsTotal",
  "total_prompts",
  "totalPrompts",
  "current_interval_total_count",
  "currentIntervalTotalCount",
  "current_weekly_total_count",
  "currentWeeklyTotalCount",
  "limit",
  "quota",
  "quota_limit",
  "quotaLimit",
  "max",
] as const;

const REMAINING_KEYS = [
  "remain",
  "remaining",
  "remain_amount",
  "remainingAmount",
  "remaining_amount",
  "remain_tokens",
  "remainingTokens",
  "remaining_tokens",
  "remain_quota",
  "remainingQuota",
  "remaining_quota",
  "remain_times",
  "remainingTimes",
  "remaining_times",
  "prompt_remain",
  "promptRemain",
  "remain_prompt",
  "remainPrompt",
  "prompt_remaining",
  "promptRemaining",
  "remaining_prompt",
  "remainingPrompt",
  "prompts_remaining",
  "promptsRemaining",
  "prompt_left",
  "promptLeft",
  "prompts_left",
  "promptsLeft",
  "left",
  // MiniMax usage endpoints misname these: values are remaining quota, not consumed.
  // See https://github.com/MiniMax-AI/MiniMax-M2/issues/99
  "current_interval_usage_count",
  "currentIntervalUsageCount",
  "current_weekly_usage_count",
  "currentWeeklyUsageCount",
] as const;

const PLAN_KEYS = ["plan", "plan_name", "planName", "product", "tier"] as const;

const WINDOW_HOUR_KEYS = [
  "window_hours",
  "windowHours",
  "duration_hours",
  "durationHours",
  "hours",
] as const;

const WINDOW_MINUTE_KEYS = [
  "window_minutes",
  "windowMinutes",
  "duration_minutes",
  "durationMinutes",
  "minutes",
] as const;

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = parseFiniteNumber(record[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  return readTrimmedStringAlias(record, keys);
}

function parseEpoch(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestampMs = value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
    return asDateTimestampMs(timestampMs);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return asDateTimestampMs(parsed);
  }
  return undefined;
}

function hasAny(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => key in record);
}

function scoreUsageRecord(record: Record<string, unknown>): number {
  let score = 0;
  if (hasAny(record, PERCENT_KEYS)) {
    score += 4;
  }
  if (hasAny(record, TOTAL_KEYS)) {
    score += 3;
  }
  if (hasAny(record, USED_KEYS) || hasAny(record, REMAINING_KEYS)) {
    score += 2;
  }
  if (hasAny(record, RESET_KEYS)) {
    score += 1;
  }
  if (hasAny(record, PLAN_KEYS)) {
    score += 1;
  }
  return score;
}

function collectUsageCandidates(root: Record<string, unknown>): Record<string, unknown>[] {
  const MAX_SCAN_DEPTH = 4;
  const MAX_SCAN_NODES = 60;
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<object>();
  const candidates: Array<{ record: Record<string, unknown>; score: number; depth: number }> = [];
  let scanned = 0;

  while (queue.length && scanned < MAX_SCAN_NODES) {
    const next = queue.shift() as { value: unknown; depth: number };
    scanned += 1;
    const { value, depth } = next;

    if (isRecord(value)) {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      const score = scoreUsageRecord(value);
      if (score > 0) {
        candidates.push({ record: value, score, depth });
      }
      if (depth < MAX_SCAN_DEPTH) {
        for (const nested of Object.values(value)) {
          if (isRecord(nested) || Array.isArray(nested)) {
            queue.push({ value: nested, depth: depth + 1 });
          }
        }
      }
      continue;
    }

    if (Array.isArray(value) && depth < MAX_SCAN_DEPTH) {
      for (const nested of value) {
        if (isRecord(nested) || Array.isArray(nested)) {
          queue.push({ value: nested, depth: depth + 1 });
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.depth - b.depth);
  return candidates.map((candidate) => candidate.record);
}

function deriveWindowLabelFromTimestamps(record: Record<string, unknown>): string | undefined {
  const startTime = parseEpoch(record.start_time ?? record.startTime);
  const endTime = parseEpoch(record.end_time ?? record.endTime);
  if (startTime !== undefined && endTime !== undefined && endTime > startTime) {
    const durationHours = (endTime - startTime) / 3_600_000;
    if (durationHours >= 1 && Number.isFinite(durationHours)) {
      const rounded = Math.round(durationHours);
      return `${rounded}h`;
    }
    const durationMinutes = Math.round((endTime - startTime) / 60_000);
    if (durationMinutes > 0) {
      return `${durationMinutes}m`;
    }
  }
  return undefined;
}

function deriveWindowLabel(payload: Record<string, unknown>): string {
  const hours = pickNumber(payload, WINDOW_HOUR_KEYS);
  if (hours && Number.isFinite(hours)) {
    return `${hours}h`;
  }
  const minutes = pickNumber(payload, WINDOW_MINUTE_KEYS);
  if (minutes && Number.isFinite(minutes)) {
    return `${minutes}m`;
  }
  const fromTimestamps = deriveWindowLabelFromTimestamps(payload);
  if (fromTimestamps) {
    return fromTimestamps;
  }
  return "5h";
}

function deriveUsedPercent(payload: Record<string, unknown>): number | null {
  const total = pickNumber(payload, TOTAL_KEYS);
  let used = pickNumber(payload, USED_KEYS);
  const remaining = pickNumber(payload, REMAINING_KEYS);
  if (used === undefined && remaining !== undefined && total !== undefined) {
    used = total - remaining;
  }

  const fromCounts =
    total && total > 0 && used !== undefined && Number.isFinite(used)
      ? clampPercent((used / total) * 100)
      : null;

  // Count-derived usage is more stable across provider percent field variations.
  if (fromCounts !== null) {
    return fromCounts;
  }

  const percentRaw = pickNumber(payload, PERCENT_KEYS);
  if (percentRaw !== undefined) {
    return clampPercent(percentRaw <= 1 ? percentRaw * 100 : percentRaw);
  }

  // usage_percent / usagePercent / current_interval_remaining_percent in
  // MiniMax's API represent remaining quota, not consumed quota.  Invert to
  // get usedPercent.  Weekly remaining-percent fields are intentionally excluded:
  // displaying a weekly percentage with interval timing metadata
  // (start_time / end_time) would be misleading.  Weekly extraction is tracked
  // separately for a future multi-window representation.
  const remainingPercentRaw = pickNumber(payload, INTERVAL_REMAINING_PERCENT_KEYS);
  if (remainingPercentRaw !== undefined) {
    const remainingNormalized = clampPercent(
      remainingPercentRaw <= 1 ? remainingPercentRaw * 100 : remainingPercentRaw,
    );
    return clampPercent(100 - remainingNormalized);
  }

  return null;
}

// Prefer the entry whose model_name matches a chat/text model (e.g. "MiniMax-M*",
// "general") and that has a non-zero current_interval_total_count.  Models with
// total_count === 0 (speech, video, image) are not relevant to the coding-plan budget.
//
// When all entries have total_count === 0 (current MiniMax coding-plan API shape,
// see #110887), fall back to entries that carry a recognized remaining-percent field
// and prefer chat-model entries ("general" / "minimax-m") over non-chat entries
// ("video" etc.).  The candidate search uses the combined interval + weekly
// remaining-percent key set (REMAINING_PERCENT_KEYS) for loose matching, while
// deriveUsedPercent uses only INTERVAL_REMAINING_PERCENT_KEYS so that a weekly-only
// record does not display weekly quota with interval timing metadata.
function pickChatModelRemains(modelRemains: unknown[]): Record<string, unknown> | undefined {
  const records = modelRemains.filter(isRecord);
  if (records.length === 0) {
    return undefined;
  }

  const isChatModel = (name: string): boolean => {
    const lower = normalizeLowercaseStringOrEmpty(name);
    return lower.startsWith("minimax-m") || lower === "general" || lower === "";
  };

  // Pass 1: chat-model entry with non-zero current_interval_total_count.
  const chatRecord = records.find((r) => {
    const name = typeof r.model_name === "string" ? r.model_name : "";
    const total = parseFiniteNumber(r.current_interval_total_count);
    return isChatModel(name) && total !== undefined && total > 0;
  });
  if (chatRecord) {
    return chatRecord;
  }

  // Pass 2: any entry with non-zero current_interval_total_count.
  const anyRecord = records.find((r) => {
    const total = parseFiniteNumber(r.current_interval_total_count);
    return total !== undefined && total > 0;
  });
  if (anyRecord) {
    return anyRecord;
  }

  // Pass 3: chat-model entry that carries a recognized remaining-percent field
  // (current MiniMax API shape where all totals are 0 — see #110887).
  const chatByPercent = records.find((r) => {
    const name = typeof r.model_name === "string" ? r.model_name : "";
    return isChatModel(name) && hasAny(r, REMAINING_PERCENT_KEYS);
  });
  if (chatByPercent) {
    return chatByPercent;
  }

  // Pass 4: any entry that carries a recognized remaining-percent field.
  return records.find((r) => hasAny(r, REMAINING_PERCENT_KEYS));
}

function resolveMinimaxUsageUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return `${DEFAULT_MINIMAX_USAGE_ORIGIN}${MINIMAX_USAGE_PATH}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.origin}${MINIMAX_USAGE_PATH}`;
    }
  } catch {
    // Fall through to the stable CN default for malformed config values.
  }

  return `${DEFAULT_MINIMAX_USAGE_ORIGIN}${MINIMAX_USAGE_PATH}`;
}

export async function fetchMinimaxUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  options?: FetchMinimaxUsageOptions,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    resolveMinimaxUsageUrl(options?.baseUrl),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "MM-API-Source": "OpenClaw",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    await discardUsageResponseBody(res);
    return buildUsageHttpErrorSnapshot({
      provider: "minimax",
      status: res.status,
    });
  }

  const data = await readProviderJsonResponse<MinimaxUsageResponse>(res, "minimax usage").catch(
    () => null,
  );
  if (!isRecord(data)) {
    return {
      provider: "minimax",
      displayName: PROVIDER_LABELS.minimax,
      windows: [],
      error: "Invalid JSON",
    };
  }

  const baseResp = isRecord(data.base_resp) ? data.base_resp : undefined;
  if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
    return {
      provider: "minimax",
      displayName: PROVIDER_LABELS.minimax,
      windows: [],
      error: baseResp.status_msg?.trim() || "API error",
    };
  }

  const payload = isRecord(data.data) ? data.data : data;

  // Handle the model_remains array structure returned by the coding-plan
  // endpoint.  Pick the chat-model entry so that speech/video/image quotas
  // (which often have total_count === 0) don't shadow the relevant budget.
  const modelRemains = Array.isArray(payload.model_remains) ? payload.model_remains : null;
  const chatRemains = modelRemains ? pickChatModelRemains(modelRemains) : undefined;

  const usageSource = chatRemains ?? payload;
  const candidates = collectUsageCandidates(usageSource);
  let usageRecord: Record<string, unknown> = usageSource;
  let usedPercent: number | null = null;
  for (const candidate of candidates) {
    const candidatePercent = deriveUsedPercent(candidate);
    if (candidatePercent !== null) {
      usageRecord = candidate;
      usedPercent = candidatePercent;
      break;
    }
  }
  if (usedPercent === null) {
    usedPercent = deriveUsedPercent(usageSource);
  }
  if (usedPercent === null) {
    return {
      provider: "minimax",
      displayName: PROVIDER_LABELS.minimax,
      windows: [],
      error: "Unsupported response shape",
    };
  }

  const resetAt =
    parseEpoch(pickString(usageRecord, RESET_KEYS)) ??
    parseEpoch(pickNumber(usageRecord, RESET_KEYS)) ??
    parseEpoch(pickString(payload, RESET_KEYS)) ??
    parseEpoch(pickNumber(payload, RESET_KEYS));
  const windowLabel = chatRemains ? deriveWindowLabel(chatRemains) : deriveWindowLabel(usageRecord);
  const windows: UsageWindow[] = [
    {
      label: windowLabel,
      usedPercent,
      resetAt,
    },
  ];

  const modelName =
    chatRemains && typeof chatRemains.model_name === "string" ? chatRemains.model_name : undefined;
  const plan =
    pickString(usageRecord, PLAN_KEYS) ??
    pickString(payload, PLAN_KEYS) ??
    (modelName ? `Coding Plan · ${modelName}` : undefined);

  return {
    provider: "minimax",
    displayName: PROVIDER_LABELS.minimax,
    windows,
    plan,
  };
}
