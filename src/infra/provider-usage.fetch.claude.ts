// Fetches Claude provider usage windows.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { cancelUnreadResponseBody } from "./http-body.js";
import {
  buildUsageHttpErrorSnapshot,
  fetchJson,
  parseUsageResetAt,
  readUsageJson,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

function readClaudeWindow(
  value: unknown,
  label: string,
  includeReset = false,
): UsageWindow | undefined {
  const window = isRecord(value) ? value : undefined;
  const utilization = asFiniteNumber(window?.utilization);
  if (utilization === undefined) {
    return undefined;
  }
  return {
    label,
    usedPercent: clampPercent(utilization),
    ...(includeReset ? { resetAt: parseUsageResetAt(window?.resets_at) } : {}),
  };
}

// Normalize fields independently: malformed optional data must not discard
// valid sibling windows or billing in either OAuth or web usage responses.
function parseClaudeUsage(value: unknown) {
  const usage = isRecord(value) ? value : {};
  const windows: UsageWindow[] = [];

  const fiveHour = readClaudeWindow(usage.five_hour, "5h", true);
  if (fiveHour) {
    windows.push(fiveHour);
  }

  const sevenDay = readClaudeWindow(usage.seven_day, "Week", true);
  if (sevenDay) {
    windows.push(sevenDay);
  }

  const modelWindow =
    readClaudeWindow(usage.seven_day_sonnet, "Sonnet") ??
    readClaudeWindow(usage.seven_day_opus, "Opus");
  if (modelWindow) {
    windows.push(modelWindow);
  }

  const knownLabels = new Set(windows.map((window) => window.label.toLowerCase()));
  for (const limit of Array.isArray(usage.limits) ? usage.limits : []) {
    if (!isRecord(limit)) {
      continue;
    }
    const percent = asFiniteNumber(limit.percent);
    if (limit.is_active === false || percent === undefined) {
      continue;
    }
    const scope = isRecord(limit.scope) ? limit.scope : undefined;
    const model = scope && isRecord(scope.model) ? scope.model : undefined;
    const label =
      normalizeOptionalString(model?.display_name) ?? normalizeOptionalString(model?.id);
    if (!label || knownLabels.has(label.toLowerCase())) {
      continue;
    }
    knownLabels.add(label.toLowerCase());
    windows.push({
      label,
      usedPercent: clampPercent(percent),
      resetAt: parseUsageResetAt(limit.resets_at),
    });
  }

  const extra = isRecord(usage.extra_usage) ? usage.extra_usage : undefined;
  return {
    windows,
    extra_usage: extra
      ? {
          is_enabled: extra.is_enabled === true,
          monthly_limit: asFiniteNumber(extra.monthly_limit),
          used_credits: asFiniteNumber(extra.used_credits),
          utilization: asFiniteNumber(extra.utilization),
          currency: normalizeOptionalString(extra.currency),
        }
      : undefined,
  };
}

function buildClaudeUsageWindows(
  usage: ReturnType<typeof parseClaudeUsage>,
  options?: { skipExtraUsage?: boolean },
): UsageWindow[] {
  const { extra_usage: extraUsage } = usage;
  // Skipped when the caller also emits an extra-usage budget billing entry;
  // rendering both would duplicate the same credits as window and budget.
  if (
    !options?.skipExtraUsage &&
    extraUsage?.is_enabled === true &&
    extraUsage.utilization !== undefined
  ) {
    return [
      ...usage.windows,
      { label: "Extra usage", usedPercent: clampPercent(extraUsage.utilization) },
    ];
  }

  return usage.windows;
}

function resolveClaudeWebSessionKey(): string | undefined {
  const direct =
    process.env.CLAUDE_AI_SESSION_KEY?.trim() ?? process.env.CLAUDE_WEB_SESSION_KEY?.trim();
  if (direct?.startsWith("sk-ant-")) {
    return direct;
  }

  const cookieHeader = process.env.CLAUDE_WEB_COOKIE?.trim();
  if (!cookieHeader) {
    return undefined;
  }
  const stripped = cookieHeader.replace(/^cookie:\s*/i, "");
  const match = stripped.match(/(?:^|;\s*)sessionKey=([^;\s]+)/i);
  const value = match?.[1]?.trim();
  return value?.startsWith("sk-ant-") ? value : undefined;
}

async function fetchClaudeWebUsage(
  sessionKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot | null> {
  const headers: Record<string, string> = {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: "application/json",
  };

  const orgRes = await fetchJson(
    "https://claude.ai/api/organizations",
    { headers },
    timeoutMs,
    fetchFn,
  );
  if (!orgRes.ok) {
    await cancelUnreadResponseBody(orgRes);
    return null;
  }

  const parsedOrgs = await readUsageJson("anthropic", orgRes);
  if (!parsedOrgs.ok) {
    return null;
  }
  const firstOrg = Array.isArray(parsedOrgs.data) ? parsedOrgs.data[0] : undefined;
  const orgId = isRecord(firstOrg) ? normalizeOptionalString(firstOrg.uuid) : undefined;
  if (!orgId) {
    return null;
  }

  const usageRes = await fetchJson(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { headers },
    timeoutMs,
    fetchFn,
  );
  if (!usageRes.ok) {
    await cancelUnreadResponseBody(usageRes);
    return null;
  }

  const parsedUsage = await readUsageJson("anthropic", usageRes);
  if (!parsedUsage.ok) {
    return null;
  }
  const usage = parseClaudeUsage(parsedUsage.data);
  const windows = buildClaudeUsageWindows(usage);

  if (windows.length === 0) {
    return null;
  }
  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
  };
}

export async function fetchClaudeUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  options?: { useWebSession?: boolean },
): Promise<ProviderUsageSnapshot> {
  if (options?.useWebSession) {
    const sessionKey = resolveClaudeWebSessionKey();
    if (sessionKey) {
      const web = await fetchClaudeWebUsage(sessionKey, timeoutMs, fetchFn);
      if (web) {
        return web;
      }
    }
    return {
      provider: "anthropic",
      displayName: PROVIDER_LABELS.anthropic,
      windows: [],
      error: "Claude web usage unavailable",
    };
  }

  const res = await fetchJson(
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "openclaw",
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    let message: string | undefined;
    try {
      const data = await readProviderJsonResponse<{
        error?: { message?: unknown } | null;
      }>(res, "Anthropic usage error");
      const raw = data?.error?.message;
      if (typeof raw === "string" && raw.trim()) {
        message = raw.trim();
      }
    } catch {
      // ignore parse errors
    }

    // OAuth tokens can lack user:profile scope required by the usage endpoint.
    // When a claude.ai browser sessionKey is available, fall back to the web API.
    if (res.status === 403 && message?.includes("scope requirement user:profile")) {
      const sessionKey = resolveClaudeWebSessionKey();
      if (sessionKey) {
        const web = await fetchClaudeWebUsage(sessionKey, timeoutMs, fetchFn);
        if (web) {
          return web;
        }
      }
    }

    return buildUsageHttpErrorSnapshot({
      provider: "anthropic",
      status: res.status,
      message,
    });
  }

  const parsed = await readUsageJson("anthropic", res);
  if (!parsed.ok) {
    return parsed.snapshot;
  }
  const usage = parseClaudeUsage(parsed.data);
  const extra = usage.extra_usage;
  const unit = extra?.currency?.toUpperCase() || "USD";
  const billing =
    extra?.is_enabled === true &&
    extra.used_credits !== undefined &&
    extra.used_credits >= 0 &&
    extra.monthly_limit !== undefined &&
    extra.monthly_limit >= 0
      ? [
          {
            type: "budget" as const,
            // Anthropic reports extra-usage currency in minor units.
            used: extra.used_credits / 100,
            limit: extra.monthly_limit / 100,
            unit,
            period: "month",
          },
        ]
      : undefined;
  const windows = buildClaudeUsageWindows(usage, { skipExtraUsage: Boolean(billing) });

  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
    ...(billing ? { billing } : {}),
  };
}
