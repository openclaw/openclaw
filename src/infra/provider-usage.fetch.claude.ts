import { buildUsageHttpErrorSnapshot, fetchJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type ClaudeUsageResponse = {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  seven_day_sonnet?: { utilization?: number };
  seven_day_opus?: { utilization?: number };
};

type ClaudeWebOrganizationsResponse = Array<{
  uuid?: string;
  name?: string;
}>;

type ClaudeWebUsageResponse = ClaudeUsageResponse;

type SessionKeyCandidateSource =
  | "override"
  | "CLAUDE_AI_SESSION_KEY"
  | "CLAUDE_WEB_SESSION_KEY"
  | "CLAUDE_WEB_COOKIE"
  | "none";

type SessionKeyResolution = {
  sessionKey?: string;
  cookieHeader?: string;
  source: SessionKeyCandidateSource;
  hadCandidate: boolean;
  parsedFromCookie: boolean;
};

type ClaudeWebUsageAttempt = {
  snapshot: ProviderUsageSnapshot | null;
  debug: {
    orgStatus?: number;
    usageStatus?: number;
    orgCount?: number;
    hasOrgId?: boolean;
    usageWindows?: number;
    orgHint?: "cloudflare_challenge" | "unauthorized" | "other";
    usageHint?: "cloudflare_challenge" | "unauthorized" | "other";
  };
};

const CLOUDFLARE_BACKOFF_MS = 15 * 60 * 1000;
let claudeCloudflareBackoffUntilMs = 0;

function formatBackoffRemaining(targetMs: number, now = Date.now()): string {
  const diff = Math.max(0, targetMs - now);
  const minutes = Math.ceil(diff / 60000);
  return `${minutes}m`;
}

function buildClaudeUsageWindows(data: ClaudeUsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];

  if (data.five_hour?.utilization !== undefined) {
    windows.push({
      label: "5h",
      usedPercent: clampPercent(data.five_hour.utilization),
      resetAt: data.five_hour.resets_at ? new Date(data.five_hour.resets_at).getTime() : undefined,
    });
  }

  if (data.seven_day?.utilization !== undefined) {
    windows.push({
      label: "Week",
      usedPercent: clampPercent(data.seven_day.utilization),
      resetAt: data.seven_day.resets_at ? new Date(data.seven_day.resets_at).getTime() : undefined,
    });
  }

  const modelWindow = data.seven_day_sonnet || data.seven_day_opus;
  if (modelWindow?.utilization !== undefined) {
    windows.push({
      label: data.seven_day_sonnet ? "Sonnet" : "Opus",
      usedPercent: clampPercent(modelWindow.utilization),
    });
  }

  return windows;
}

function extractSessionKey(value?: string): { key?: string; parsedFromCookie: boolean } {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { key: undefined, parsedFromCookie: false };
  }
  if (trimmed.startsWith("sk-ant-")) {
    return { key: trimmed, parsedFromCookie: false };
  }
  const stripped = trimmed.replace(/^cookie:\s*/i, "");
  const match = stripped.match(/(?:^|;\s*)sessionKey=([^;\s]+)/i);
  const parsed = match?.[1]?.trim();
  return {
    key: parsed?.startsWith("sk-ant-") ? parsed : undefined,
    parsedFromCookie: Boolean(parsed?.startsWith("sk-ant-")),
  };
}

function extractCookieHeader(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("sk-ant-")) {
    return `sessionKey=${trimmed}`;
  }
  const stripped = trimmed.replace(/^cookie:\s*/i, "").trim();
  if (/(^|;\s*)sessionKey=/.test(stripped)) {
    return stripped;
  }
  return undefined;
}

function getCookieValue(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1]?.trim();
}

function resolveClaudeWebSessionKey(override?: string): SessionKeyResolution {
  const candidates: Array<[SessionKeyCandidateSource, string | undefined]> = [
    ["override", override],
    ["CLAUDE_AI_SESSION_KEY", process.env.CLAUDE_AI_SESSION_KEY],
    ["CLAUDE_WEB_SESSION_KEY", process.env.CLAUDE_WEB_SESSION_KEY],
    ["CLAUDE_WEB_COOKIE", process.env.CLAUDE_WEB_COOKIE],
  ];

  for (const [source, raw] of candidates) {
    if (!raw?.trim()) {
      continue;
    }
    const extracted = extractSessionKey(raw);
    const cookieHeader = extractCookieHeader(raw);
    if (extracted.key || cookieHeader) {
      return {
        sessionKey: extracted.key,
        cookieHeader: cookieHeader ?? (extracted.key ? `sessionKey=${extracted.key}` : undefined),
        source,
        hadCandidate: true,
        parsedFromCookie: extracted.parsedFromCookie,
      };
    }
    return {
      sessionKey: undefined,
      cookieHeader: undefined,
      source,
      hadCandidate: true,
      parsedFromCookie: false,
    };
  }

  return {
    sessionKey: undefined,
    source: "none",
    hadCandidate: false,
    parsedFromCookie: false,
  };
}

async function fetchClaudeWebUsage(
  cookieHeader: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  orgIdOverride?: string,
): Promise<ClaudeWebUsageAttempt> {
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Accept: "*/*",
    "Content-Type": "application/json",
    Origin: "https://claude.ai",
    Referer: "https://claude.ai/settings/usage",
    "User-Agent":
      process.env.CLAUDE_WEB_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    "Anthropic-Client-Platform": "web_claude_ai",
  };

  const cookieDeviceId = getCookieValue(cookieHeader, "anthropic-device-id");
  const cookieAnonId = getCookieValue(cookieHeader, "ajs_anonymous_id");
  if (cookieDeviceId) {
    headers["Anthropic-Device-Id"] = cookieDeviceId;
  }
  if (cookieAnonId) {
    headers["Anthropic-Anonymous-Id"] = cookieAnonId;
  }

  let orgResStatus: number | undefined;
  let orgCount: number | undefined;
  let orgId = orgIdOverride?.trim();

  if (!orgId) {
    const orgRes = await fetchJson(
      "https://claude.ai/api/organizations",
      { headers },
      timeoutMs,
      fetchFn,
    );
    orgResStatus = orgRes.status;
    if (!orgRes.ok) {
      const orgBody = (await orgRes.text()).slice(0, 400).toLowerCase();
      const orgHint =
        orgBody.includes("just a moment") || orgBody.includes("cf-challenge")
          ? "cloudflare_challenge"
          : orgRes.status === 401 || orgRes.status === 403
            ? "unauthorized"
            : "other";
      return {
        snapshot: null,
        debug: { orgStatus: orgRes.status, orgHint },
      };
    }

    const orgs = (await orgRes.json()) as ClaudeWebOrganizationsResponse;
    orgCount = orgs?.length ?? 0;
    orgId = orgs?.[0]?.uuid?.trim();
    if (!orgId) {
      return {
        snapshot: null,
        debug: { orgStatus: orgRes.status, orgCount: orgs?.length ?? 0, hasOrgId: false },
      };
    }
  }

  const usageRes = await fetchJson(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { headers },
    timeoutMs,
    fetchFn,
  );
  if (!usageRes.ok) {
    const usageBody = (await usageRes.text()).slice(0, 400).toLowerCase();
    const usageHint =
      usageBody.includes("just a moment") || usageBody.includes("cf-challenge")
        ? "cloudflare_challenge"
        : usageRes.status === 401 || usageRes.status === 403
          ? "unauthorized"
          : "other";
    return {
      snapshot: null,
      debug: {
        orgStatus: orgResStatus,
        orgCount,
        hasOrgId: true,
        usageStatus: usageRes.status,
        usageHint,
      },
    };
  }

  const data = (await usageRes.json()) as ClaudeWebUsageResponse;
  const windows = buildClaudeUsageWindows(data);

  if (windows.length === 0) {
    return {
      snapshot: null,
      debug: {
        orgStatus: orgResStatus,
        orgCount,
        hasOrgId: true,
        usageStatus: usageRes.status,
        usageWindows: 0,
      },
    };
  }
  return {
    snapshot: {
      provider: "anthropic",
      displayName: PROVIDER_LABELS.anthropic,
      windows,
    },
    debug: {
      orgStatus: orgResStatus,
      orgCount,
      hasOrgId: true,
      usageStatus: usageRes.status,
      usageWindows: windows.length,
    },
  };
}

export async function fetchClaudeUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  claudeWebSessionKey?: string,
): Promise<ProviderUsageSnapshot> {
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
      const data = (await res.json()) as {
        error?: { message?: unknown } | null;
      };
      const raw = data?.error?.message;
      if (typeof raw === "string" && raw.trim()) {
        message = raw.trim();
      }
    } catch {
      // ignore parse errors
    }

    // Claude Code CLI setup-token yields tokens that can be used for inference, but may not
    // include user:profile scope required by the OAuth usage endpoint. When a claude.ai
    // browser sessionKey is available, fall back to the web API.
    if (res.status === 403 && message?.includes("scope requirement user:profile")) {
      const keyResolution = resolveClaudeWebSessionKey(claudeWebSessionKey);
      if (keyResolution.cookieHeader) {
        if (Date.now() < claudeCloudflareBackoffUntilMs) {
          const retryIn = formatBackoffRemaining(claudeCloudflareBackoffUntilMs);
          return {
            provider: "anthropic",
            displayName: PROVIDER_LABELS.anthropic,
            windows: [],
            error:
              "Usage unavailable: Claude usage is temporarily blocked by Cloudflare from this host/network. " +
              `Skipping retry for ${retryIn} to reduce noise. ` +
              "(Inference is unaffected.)",
          };
        }

        const webAttempt = await fetchClaudeWebUsage(
          keyResolution.cookieHeader,
          timeoutMs,
          fetchFn,
          process.env.CLAUDE_ORGANIZATION_ID,
        );
        if (webAttempt.snapshot) {
          claudeCloudflareBackoffUntilMs = 0;
          return webAttempt.snapshot;
        }
        // Web API call failed even with valid session key
        const cloudflareBlocked =
          webAttempt.debug.orgHint === "cloudflare_challenge" ||
          webAttempt.debug.usageHint === "cloudflare_challenge";
        if (cloudflareBlocked) {
          claudeCloudflareBackoffUntilMs = Date.now() + CLOUDFLARE_BACKOFF_MS;
          const retryIn = formatBackoffRemaining(claudeCloudflareBackoffUntilMs);
          return {
            provider: "anthropic",
            displayName: PROVIDER_LABELS.anthropic,
            windows: [],
            error:
              "Usage unavailable: Claude usage is blocked by Cloudflare from this host/network (your session key is likely fine). " +
              `Will retry automatically in ~${retryIn}. ` +
              "(Inference is unaffected.)",
          };
        }

        const statusHint =
          webAttempt.debug.orgStatus === 401 || webAttempt.debug.orgStatus === 403
            ? " claude.ai rejected this session key (401/403). Make sure CLAUDE_AI_SESSION_KEY is the current `sessionKey` cookie value from an active claude.ai browser session."
            : "";
        return {
          provider: "anthropic",
          displayName: PROVIDER_LABELS.anthropic,
          windows: [],
          error:
            "Usage unavailable: claude.ai web API failed. " +
            "Try refreshing your session key from claude.ai cookies, " +
            "or use an Anthropic API key (inference is unaffected)." +
            statusHint,
        };
      }
      // setup-token lacks user:profile scope and no session key available
      return {
        provider: "anthropic",
        displayName: PROVIDER_LABELS.anthropic,
        windows: [],
        error:
          "Usage unavailable: setup-token lacks user:profile scope. " +
          "To enable usage tracking, set CLAUDE_AI_SESSION_KEY in your OpenClaw config " +
          '(e.g. env: { CLAUDE_AI_SESSION_KEY: "<sessionKey cookie from claude.ai>" } or ' +
          'env: { vars: { CLAUDE_AI_SESSION_KEY: "<sessionKey>" } }), ' +
          "or in ~/.openclaw/.env (or use an Anthropic API key — inference is unaffected).",
      };
    }

    return buildUsageHttpErrorSnapshot({
      provider: "anthropic",
      status: res.status,
      message,
    });
  }

  const data = (await res.json()) as ClaudeUsageResponse;
  const windows = buildClaudeUsageWindows(data);

  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
  };
}
