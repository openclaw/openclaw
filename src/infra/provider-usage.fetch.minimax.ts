import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "../utils.js";
import { readTrimmedStringAlias } from "../utils/string-readers.js";
import {
  buildUsageErrorSnapshot,
  fetchUsageJson,
  parseFiniteNumber,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type MinimaxBaseResp = {
  status_code?: number;
  status_msg?: string;
};

type FetchMinimaxUsageOptions = {
  baseUrl?: string;
};

const DEFAULT_MINIMAX_USAGE_ORIGIN = "https://api.minimaxi.com";
const MINIMAX_USAGE_PATH = "/v1/token_plan/remains";

function snakeAndCamelFields(...names: string[]): string[] {
  return names.flatMap((name) => {
    const camel = name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    return camel === name ? [name] : [name, camel];
  });
}

const RESET_KEYS = snakeAndCamelFields(
  "reset_at",
  "reset_time",
  "next_reset_at",
  "next_reset_time",
  "expires_at",
  "expire_at",
  "end_time",
  "window_end",
);

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

// Legacy usage_percent / usagePercent fields report remaining quota, not consumption.
// Generic payloads keep count priority; canonical model rows opt into the provider's
// dedicated remaining-percent fields as their authoritative values.
const REMAINING_PERCENT_KEYS = ["usage_percent", "usagePercent"] as const;

const CURRENT_INTERVAL_TOTAL_KEYS = snakeAndCamelFields("current_interval_total_count");
const CURRENT_INTERVAL_REMAINING_KEYS = snakeAndCamelFields("current_interval_usage_count");
const CURRENT_INTERVAL_REMAINING_PERCENT_KEYS = snakeAndCamelFields(
  "current_interval_remaining_percent",
);
const CURRENT_INTERVAL_STATUS_KEYS = snakeAndCamelFields("current_interval_status");
const CURRENT_WEEKLY_TOTAL_KEYS = snakeAndCamelFields("current_weekly_total_count");
const CURRENT_WEEKLY_REMAINING_KEYS = snakeAndCamelFields("current_weekly_usage_count");
const CURRENT_WEEKLY_REMAINING_PERCENT_KEYS = snakeAndCamelFields(
  "current_weekly_remaining_percent",
);
const CURRENT_WEEKLY_STATUS_KEYS = snakeAndCamelFields("current_weekly_status");
const MODEL_REMAINING_PERCENT_KEYS = [
  ...CURRENT_INTERVAL_REMAINING_PERCENT_KEYS,
  ...CURRENT_WEEKLY_REMAINING_PERCENT_KEYS,
] as const;

const USED_KEYS = snakeAndCamelFields(
  "used",
  "usage",
  "used_amount",
  "used_tokens",
  "used_quota",
  "used_times",
  "prompt_used",
  "used_prompt",
  "prompts_used",
  "consumed",
);

const TOTAL_KEYS = [
  ...snakeAndCamelFields(
    "total",
    "total_amount",
    "total_tokens",
    "total_quota",
    "total_times",
    "prompt_total",
    "total_prompt",
    "prompt_limit",
    "limit_prompt",
    "prompts_total",
    "total_prompts",
  ),
  ...CURRENT_INTERVAL_TOTAL_KEYS,
  ...CURRENT_WEEKLY_TOTAL_KEYS,
  ...snakeAndCamelFields("limit", "quota", "quota_limit", "max"),
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
  ...snakeAndCamelFields(
    "prompt_remain",
    "remain_prompt",
    "prompt_remaining",
    "remaining_prompt",
    "prompts_remaining",
    "prompt_left",
    "prompts_left",
  ),
  "left",
  // MiniMax usage endpoints misname these: values are remaining quota, not consumed.
  // See https://github.com/MiniMax-AI/MiniMax-M2/issues/99
  ...CURRENT_INTERVAL_REMAINING_KEYS,
  ...CURRENT_WEEKLY_REMAINING_KEYS,
] as const;

const PLAN_KEYS = ["plan", "plan_name", "planName", "product", "tier"] as const;

const WINDOW_HOUR_KEYS = snakeAndCamelFields("window_hours", "duration_hours", "hours");

const WINDOW_MINUTE_KEYS = snakeAndCamelFields("window_minutes", "duration_minutes", "minutes");

function pickNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
  parse = parseFiniteNumber,
): number | undefined {
  for (const key of keys) {
    const parsed = parse(record[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function parseEpoch(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestampMs = value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
    return asDateTimestampMs(timestampMs);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = parseFiniteNumber(value);
    if (numeric !== undefined) {
      return parseEpoch(numeric);
    }
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
  if (hasAny(record, PERCENT_KEYS) || hasAny(record, MODEL_REMAINING_PERCENT_KEYS)) {
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

function pickUsageRecord(
  root: Record<string, unknown>,
): { record: Record<string, unknown>; usedPercent: number } | undefined {
  const MAX_SCAN_DEPTH = 4;
  const MAX_SCAN_NODES = 60;
  const queue: Array<{ value: Record<string, unknown> | unknown[]; depth: number }> = [
    { value: root, depth: 0 },
  ];
  let best: { record: Record<string, unknown>; usedPercent: number } | undefined;
  let bestScore = 0;

  for (const { value, depth } of queue) {
    if (isRecord(value)) {
      const score = scoreUsageRecord(value);
      // Breadth-first order already favors shallower records and the first tied record.
      if (score > bestScore) {
        const usedPercent = deriveUsedPercent(value);
        if (usedPercent !== null) {
          best = { record: value, usedPercent };
          bestScore = score;
        }
      }
    }
    if (depth >= MAX_SCAN_DEPTH || queue.length >= MAX_SCAN_NODES) {
      continue;
    }
    for (const nested of Array.isArray(value) ? value : Object.values(value)) {
      if (queue.length >= MAX_SCAN_NODES) {
        break;
      }
      if (isRecord(nested) || Array.isArray(nested)) {
        queue.push({ value: nested, depth: depth + 1 });
      }
    }
  }

  return best;
}

function deriveWindowLabel(payload: Record<string, unknown>): string {
  const hours = pickNumber(payload, WINDOW_HOUR_KEYS);
  if (hours) {
    return `${hours}h`;
  }
  const minutes = pickNumber(payload, WINDOW_MINUTE_KEYS);
  if (minutes) {
    return `${minutes}m`;
  }
  const startTime = parseEpoch(payload.start_time ?? payload.startTime);
  const endTime = parseEpoch(payload.end_time ?? payload.endTime);
  if (startTime !== undefined && endTime !== undefined && endTime > startTime) {
    const durationHours = (endTime - startTime) / 3_600_000;
    if (durationHours >= 1) {
      return `${Math.round(durationHours)}h`;
    }
    const durationMinutes = Math.round((endTime - startTime) / 60_000);
    if (durationMinutes > 0) {
      return `${durationMinutes}m`;
    }
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

  // Count-derived usage is more stable across provider percent field variations.
  if (total && total > 0 && used !== undefined && Number.isFinite(used)) {
    return clampPercent((used / total) * 100);
  }

  const percentRaw = pickNumber(payload, PERCENT_KEYS);
  if (percentRaw !== undefined) {
    return clampPercent(percentRaw <= 1 ? percentRaw * 100 : percentRaw);
  }

  // usage_percent / usagePercent in MiniMax's API represents remaining quota,
  // not consumed quota. Invert to get usedPercent.
  const remainingPercent = pickNumber(payload, REMAINING_PERCENT_KEYS);
  return remainingPercent === undefined
    ? null
    : 100 - clampPercent(remainingPercent <= 1 ? remainingPercent * 100 : remainingPercent);
}

// MiniMax's current API uses `general` for the chat quota and can report zero counts
// with authoritative percentage fields. Prefer that owner before status-based fallbacks.
function pickChatModelRemains(modelRemains: unknown[]): Record<string, unknown> | undefined {
  const records = modelRemains
    .filter(isRecord)
    .filter(
      (record) =>
        hasAny(record, MODEL_REMAINING_PERCENT_KEYS) ||
        (pickNumber(record, CURRENT_INTERVAL_TOTAL_KEYS) ?? 0) > 0 ||
        (pickNumber(record, CURRENT_WEEKLY_TOTAL_KEYS) ?? 0) > 0,
    );
  return (
    records.find((record) => {
      const name = normalizeLowercaseStringOrEmpty(record.model_name);
      return name === "general" || name.startsWith("minimax-m");
    }) ??
    records.find((record) =>
      [CURRENT_INTERVAL_STATUS_KEYS, CURRENT_WEEKLY_STATUS_KEYS].some((keys) => {
        const status = pickNumber(record, keys);
        return status === 1 || status === 2;
      }),
    ) ??
    records[0]
  );
}

function deriveMinimaxModelWindows(record: Record<string, unknown>): {
  recognized: boolean;
  windows: UsageWindow[];
} {
  const windows: UsageWindow[] = [];
  let recognized = false;
  for (const window of [
    {
      total: CURRENT_INTERVAL_TOTAL_KEYS,
      remaining: CURRENT_INTERVAL_REMAINING_KEYS,
      remainingPercent: CURRENT_INTERVAL_REMAINING_PERCENT_KEYS,
      status: CURRENT_INTERVAL_STATUS_KEYS,
      reset: snakeAndCamelFields("end_time"),
    },
    {
      label: "Week",
      total: CURRENT_WEEKLY_TOTAL_KEYS,
      remaining: CURRENT_WEEKLY_REMAINING_KEYS,
      remainingPercent: CURRENT_WEEKLY_REMAINING_PERCENT_KEYS,
      status: CURRENT_WEEKLY_STATUS_KEYS,
      reset: snakeAndCamelFields("weekly_end_time"),
    },
  ]) {
    const remainingPercent = pickNumber(record, window.remainingPercent);
    const total = pickNumber(record, window.total);
    const remaining = pickNumber(record, window.remaining);
    const used = total !== undefined && remaining !== undefined ? total - remaining : undefined;
    const usedPercent =
      remainingPercent !== undefined
        ? 100 - clampPercent(remainingPercent)
        : total && total > 0 && used !== undefined && Number.isFinite(used)
          ? clampPercent((used / total) * 100)
          : null;
    if (usedPercent === null) {
      continue;
    }
    recognized = true;
    // Status 3 is unlimited: recognize the model without exposing a bounded bar.
    if (pickNumber(record, window.status) === 3) {
      continue;
    }
    windows.push({
      label: window.label ?? deriveWindowLabel(record),
      usedPercent,
      resetAt: pickNumber(record, window.reset, parseEpoch),
    });
  }
  return { recognized, windows };
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
  const parsed = await fetchUsageJson({
    provider: "minimax",
    url: resolveMinimaxUsageUrl(options?.baseUrl),
    init: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "MM-API-Source": "OpenClaw",
      },
    },
    timeoutMs,
    fetchFn,
    malformedResponseError: "Invalid JSON",
  });
  if (!parsed.ok) {
    return parsed.snapshot;
  }
  const data = parsed.data;
  if (!isRecord(data)) {
    return buildUsageErrorSnapshot("minimax", "Invalid JSON");
  }

  const baseResp = isRecord(data.base_resp) ? (data.base_resp as MinimaxBaseResp) : undefined;
  if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
    return buildUsageErrorSnapshot("minimax", baseResp.status_msg?.trim() || "API error");
  }

  const payload = isRecord(data.data) ? data.data : data;

  // Handle the model_remains array structure returned by the coding-plan
  // endpoint.  Pick the chat-model entry so that speech/video/image quotas
  // (which often have total_count === 0) don't shadow the relevant budget.
  const modelRemains = Array.isArray(payload.model_remains) ? payload.model_remains : null;
  const chatRemains = modelRemains ? pickChatModelRemains(modelRemains) : undefined;

  const usageSource = chatRemains ?? payload;
  let usageRecord: Record<string, unknown> = usageSource;
  const modelUsage = chatRemains ? deriveMinimaxModelWindows(chatRemains) : undefined;
  let windows = modelUsage?.windows ?? [];
  if (modelUsage?.recognized !== true) {
    const selected = pickUsageRecord(usageSource);
    if (selected) {
      usageRecord = selected.record;
    }
    const usedPercent = selected?.usedPercent ?? deriveUsedPercent(usageSource);
    if (usedPercent === null) {
      return buildUsageErrorSnapshot("minimax", "Unsupported response shape");
    }

    const resetAt =
      pickNumber(usageRecord, RESET_KEYS, parseEpoch) ??
      pickNumber(payload, RESET_KEYS, parseEpoch);
    windows = [
      {
        label: deriveWindowLabel(usageRecord),
        usedPercent,
        resetAt,
      },
    ];
  }

  const modelName =
    chatRemains && typeof chatRemains.model_name === "string" ? chatRemains.model_name : undefined;
  const plan =
    readTrimmedStringAlias(usageRecord, PLAN_KEYS) ??
    readTrimmedStringAlias(payload, PLAN_KEYS) ??
    (modelName ? `Coding Plan · ${modelName}` : undefined);

  return {
    provider: "minimax",
    displayName: PROVIDER_LABELS.minimax,
    windows,
    plan,
  };
}
