import { loadConfig } from "../config/config.js";
import { collectConfigRuntimeEnvVars } from "../config/env-vars.js";
import { logVerbose } from "../globals.js";
import { buildUsageHttpErrorSnapshot, fetchJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type ClaudeUsageResponse = {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  seven_day_sonnet?: { utilization?: number };
  seven_day_opus?: { utilization?: number };
};

type ClaudeWebOrganizationsResponse = Array<{ uuid?: string }>;

function resolveClaudeRuntimeEnvVar(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) {
    return direct;
  }
  const fromConfig = collectConfigRuntimeEnvVars(loadConfig())[name]?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  return undefined;
}

function getClaudeWebCookieJar(): string | undefined {
  const cookieHeader = resolveClaudeRuntimeEnvVar("CLAUDE_WEB_COOKIE");
  if (!cookieHeader) {
    return undefined;
  }
  const cookieJar = cookieHeader.replace(/^cookie:\s*/i, "").trim();
  if (!cookieJar || !/^[\x20-\x7E]+$/.test(cookieJar)) {
    return undefined;
  }
  return cookieJar;
}

function readCookieValue(cookieJar: string | undefined, key: string): string | undefined {
  if (!cookieJar) {
    return undefined;
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookieJar.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;\\s]+)`, "i"));
  return match?.[1]?.trim();
}

function mergeSessionKeyIntoCookieJar(cookieJar: string | undefined, sessionKey: string): string {
  if (!cookieJar) {
    return `sessionKey=${sessionKey}`;
  }
  if (/(?:^|;\s*)sessionKey=/.test(cookieJar)) {
    return cookieJar.replace(/((?:^|;\s*)sessionKey=)[^;\s]*/i, `$1${sessionKey}`);
  }
  return `${cookieJar}; sessionKey=${sessionKey}`;
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

/**
 * Resolves the claude.ai session key from environment variables, cookie jar, or token.
 *
 * Priority:
 *   1. CLAUDE_AI_SESSION_KEY  — preferred, explicit session key
 *   2. CLAUDE_WEB_SESSION_KEY — alias for CLAUDE_AI_SESSION_KEY
 *   3. sessionKey in CLAUDE_WEB_COOKIE — extracted from full browser cookie string
 *   4. token — used directly if it starts with "sk-ant-"
 */
function resolveSessionKey(token: string): string | undefined {
  const direct =
    resolveClaudeRuntimeEnvVar("CLAUDE_AI_SESSION_KEY") ??
    resolveClaudeRuntimeEnvVar("CLAUDE_WEB_SESSION_KEY");
  if (direct?.startsWith("sk-ant-")) {
    return direct;
  }
  const fromCookie = readCookieValue(getClaudeWebCookieJar(), "sessionKey");
  if (fromCookie?.startsWith("sk-ant-")) {
    return fromCookie;
  }
  if (token.startsWith("sk-ant-")) {
    return token;
  }
  return undefined;
}

async function fetchClaudeWebUsage(
  sessionKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  orgIdOverride?: string,
): Promise<ProviderUsageSnapshot | null> {
  const cookieJar = getClaudeWebCookieJar();
  const cookie = mergeSessionKeyIntoCookieJar(cookieJar, sessionKey);
  const deviceId = readCookieValue(cookieJar, "anthropic-device-id");
  const anonymousId = readCookieValue(cookieJar, "ajs_anonymous_id");

  const headers: Record<string, string> = {
    Cookie: cookie,
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    Origin: "https://claude.ai",
    Referer: "https://claude.ai/settings/usage",
    "User-Agent":
      resolveClaudeRuntimeEnvVar("CLAUDE_WEB_USER_AGENT") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    "Anthropic-Client-Platform": "web_claude_ai",
    "Anthropic-Client-Version": "1.0.0",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
  if (deviceId) {
    headers["Anthropic-Device-Id"] = deviceId;
  }
  if (anonymousId) {
    headers["Anthropic-Anonymous-Id"] = anonymousId;
  }

  let orgId = orgIdOverride?.trim();
  if (!orgId) {
    logVerbose("[usage:claude] fetching claude.ai organizations");
    const orgRes = await fetchJson(
      "https://claude.ai/api/organizations",
      { headers },
      timeoutMs,
      fetchFn,
    );
    if (!orgRes.ok) {
      logVerbose(`[usage:claude] organizations request failed: HTTP ${orgRes.status}`);
      return null;
    }
    const orgs = (await orgRes.json()) as ClaudeWebOrganizationsResponse;
    orgId = orgs?.[0]?.uuid?.trim();
  }
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
    logVerbose(`[usage:claude] usage request failed: HTTP ${usageRes.status}`);
    return null;
  }

  const data = (await usageRes.json()) as ClaudeUsageResponse;
  const windows = buildClaudeUsageWindows(data);
  if (windows.length === 0) {
    return null;
  }

  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
    plan: "via claude.ai",
  };
}

/**
 * Fetches Claude quota usage via the Anthropic OAuth API, with a fallback to
 * the claude.ai web API when the token lacks the user:profile scope.
 *
 * Primary path — OAuth (no extra config needed):
 *   Uses the provider token directly. Works with Claude Code CLI tokens that
 *   include the user:profile OAuth scope.
 *
 * Fallback path — claude.ai web API (when OAuth returns 403 missing scope):
 *   Configure one of the following (env var or `env.vars` in openclaw.json):
 *     CLAUDE_AI_SESSION_KEY  — session key from claude.ai (starts with sk-ant-)
 *     CLAUDE_WEB_SESSION_KEY — alias for CLAUDE_AI_SESSION_KEY
 *     CLAUDE_WEB_COOKIE      — full browser cookie string; must contain sessionKey=sk-ant-...
 *
 *   How to get your session key:
 *     1. Log in to claude.ai in your browser.
 *     2. Open DevTools → Application → Cookies → claude.ai.
 *     3. Copy the value of the `sessionKey` cookie (starts with sk-ant-).
 *     4. Set CLAUDE_AI_SESSION_KEY=<value> in your environment or openclaw.json env.vars.
 *
 *   Optional:
 *     CLAUDE_ORGANIZATION_ID — your org UUID; skips the /api/organizations lookup (faster)
 *     CLAUDE_WEB_USER_AGENT  — override the browser User-Agent sent to claude.ai
 */
export async function fetchClaudeUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  logVerbose("[usage:claude] fetching via OAuth");
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
      const data = (await res.json()) as { error?: { message?: unknown } | null };
      const raw = data?.error?.message;
      if (typeof raw === "string" && raw.trim()) {
        message = raw.trim();
      }
    } catch {
      // ignore parse errors
    }

    // Tokens lacking the user:profile OAuth scope get a 403. Fall back to the
    // claude.ai web API when a browser session key is available.
    if (res.status === 403 && message?.includes("scope requirement user:profile")) {
      const sessionKey = resolveSessionKey(token);
      if (sessionKey) {
        logVerbose("[usage:claude] OAuth scope missing — trying claude.ai web fallback");
        const web = await fetchClaudeWebUsage(
          sessionKey,
          timeoutMs,
          fetchFn,
          resolveClaudeRuntimeEnvVar("CLAUDE_ORGANIZATION_ID"),
        );
        if (web) {
          return web;
        }
      }
    }

    return buildUsageHttpErrorSnapshot({ provider: "anthropic", status: res.status, message });
  }

  const data = (await res.json()) as ClaudeUsageResponse;
  const windows = buildClaudeUsageWindows(data);

  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
    plan: "OAuth",
  };
}
