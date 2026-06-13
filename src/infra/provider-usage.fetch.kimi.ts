// Kimi Code usage fetcher for coding-plan quota windows.
import {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  fetchJson,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type KimiUsageRow = {
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
};

type KimiUsageLimit = KimiUsageRow & {
  name?: unknown;
  title?: unknown;
  scope?: unknown;
  duration?: unknown;
  timeUnit?: unknown;
  detail?: KimiUsageRow & {
    name?: unknown;
    title?: unknown;
    scope?: unknown;
    duration?: unknown;
    timeUnit?: unknown;
  };
  window?: {
    duration?: unknown;
    timeUnit?: unknown;
  };
};

type KimiUsageResponse = {
  usage?: KimiUsageRow;
  limits?: KimiUsageLimit[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function usagePercent(row: unknown): number | undefined {
  const record = asRecord(row);
  if (!record) {
    return undefined;
  }
  const limit = toNumber(record.limit);
  let used = toNumber(record.used);
  const remaining = toNumber(record.remaining);
  if (used === undefined && remaining !== undefined && limit !== undefined) {
    used = Math.max(0, limit - remaining);
  }
  if (used === undefined || limit === undefined || limit <= 0) {
    return undefined;
  }
  return Math.round(clampPercent((used / limit) * 100) * 100) / 100;
}

function isFiveHourLimit(item: KimiUsageLimit): boolean {
  const detail = asRecord(item.detail) ?? {};
  const window = asRecord(item.window) ?? {};
  const label = [item.name, item.title, item.scope, detail.name, detail.title, detail.scope]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).toLowerCase())
    .join(" ");
  if (label.includes("5h") || label.includes("5 hour") || label.includes("5-hour")) {
    return true;
  }

  const duration = toNumber(window.duration ?? item.duration ?? detail.duration);
  const timeUnit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "").toUpperCase();
  return (
    (duration === 300 && timeUnit.includes("MINUTE")) ||
    (duration === 5 && timeUnit.includes("HOUR"))
  );
}

export function parseKimiUsageWindows(payload: unknown): UsageWindow[] {
  const data = asRecord(payload) as KimiUsageResponse | undefined;
  if (!data) {
    return [];
  }

  const windows: UsageWindow[] = [];
  const sevenDay = usagePercent(data.usage);
  if (sevenDay !== undefined) {
    windows.push({ label: "7d", usedPercent: sevenDay });
  }

  for (const item of data.limits ?? []) {
    if (!asRecord(item) || !isFiveHourLimit(item)) {
      continue;
    }
    const row = asRecord(item.detail) ?? item;
    const fiveHour = usagePercent(row);
    if (fiveHour !== undefined) {
      windows.unshift({ label: "5h", usedPercent: fiveHour });
      break;
    }
  }

  return windows;
}

export async function fetchKimiUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  options?: { baseUrl?: string },
): Promise<ProviderUsageSnapshot> {
  const baseUrl = normalizeKimiUsageBaseUrl(options?.baseUrl);
  const res = await fetchJson(
    `${baseUrl}/usages`,
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
    return buildUsageHttpErrorSnapshot({
      provider: "kimi",
      status: res.status,
      tokenExpiredStatuses: [401, 403],
    });
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return buildUsageErrorSnapshot("kimi", "Malformed usage response");
  }

  return {
    provider: "kimi",
    displayName: PROVIDER_LABELS.kimi,
    windows: parseKimiUsageWindows(payload),
  };
}

export function normalizeKimiUsageBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl || "https://api.kimi.com/coding/v1").trim().replace(/\/+$/, "");
  if (!raw) {
    return "https://api.kimi.com/coding/v1";
  }
  if (raw.endsWith("/coding")) {
    return `${raw}/v1`;
  }
  return raw;
}
