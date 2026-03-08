import { buildUsageHttpErrorSnapshot, fetchJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "./provider-usage.types.js";

/**
 * Ollama usage fetcher.
 *
 * Ollama doesn't have a public API for usage data. We scrape the settings page
 * using browser session cookies to get usage limits.
 *
 * The cookie string should contain the session cookie(s) from ollama.com,
 * typically: __Secure-session, session, or next-auth.session-token
 */
export async function fetchOllamaUsage(
  cookieString: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  provider: UsageProviderId,
): Promise<ProviderUsageSnapshot> {
  // Fetch the settings page with the session cookie
  const res = await fetchJson(
    "https://ollama.com/settings",
    {
      method: "GET",
      headers: {
        Cookie: cookieString,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return buildUsageHttpErrorSnapshot({
      provider,
      status: res.status,
    });
  }

  const html = await res.text();

  // Check if we're logged in (page should have usage data, not sign-in form)
  if (html.includes("Sign in") || html.includes("sign-in")) {
    return {
      provider,
      displayName: PROVIDER_LABELS[provider],
      windows: [],
      error: "Not logged in",
    };
  }

  // Parse usage data from the HTML
  const windows = parseOllamaUsageFromHtml(html);

  return {
    provider,
    displayName: PROVIDER_LABELS[provider],
    windows,
    plan: detectOllamaPlan(html),
  };
}

/**
 * Parse usage windows from Ollama settings page HTML.
 *
 * The settings page contains usage information in the form:
 * - Session usage (per conversation)
 * - Weekly usage (rolling 7-day window)
 */
function parseOllamaUsageFromHtml(html: string): UsageWindow[] {
  const windows: UsageWindow[] = [];

  // Look for usage percentages in the HTML
  // Ollama settings page format (E2E tested & verified): "Session usage" -> "X% used", "Weekly usage" -> "X% used"
  const sessionMatch = html.match(/Session usage[\s\S]*?(\d+(?:\.\d+)?)%\s*used/i);
  const weeklyMatch = html.match(/Weekly usage[\s\S]*?(\d+(?:\.\d+)?)%\s*used/i);

  // Extract session percentage
  if (sessionMatch) {
    const value = parsePercentage(sessionMatch[1]);
    if (value !== null) {
      windows.push({
        label: "Session",
        usedPercent: clampPercent(value),
      });
    }
  }

  // Extract weekly percentage
  if (weeklyMatch) {
    const value = parsePercentage(weeklyMatch[1]);
    if (value !== null) {
      windows.push({
        label: "Weekly",
        usedPercent: clampPercent(value),
      });
    }
  }

  // Try to parse reset time (weekly resets are common)
  const resetMatch = html.match(/resets?\s*(?:in|at)?[^<>]*?(\d+)\s*(day|hour|minute)/i);
  if (resetMatch) {
    const amount = parseInt(resetMatch[1], 10);
    const unit = resetMatch[2].toLowerCase();
    let resetAt = Date.now();

    if (unit.startsWith("day")) {
      resetAt += amount * 24 * 60 * 60 * 1000;
    } else if (unit.startsWith("hour")) {
      resetAt += amount * 60 * 60 * 1000;
    } else if (unit.startsWith("minute")) {
      resetAt += amount * 60 * 1000;
    }

    // Add resetAt to the last window
    if (windows.length > 0) {
      windows[windows.length - 1].resetAt = resetAt;
    }
  }

  return windows;
}

/**
 * Parse a percentage value from a string.
 * The regex already captures the percentage number (e.g., "17.6" from "17.6%"),
 * so we just return it directly - no conversion needed.
 */
function parsePercentage(value: string): number | null {
  const cleaned = value.replace("%", "").trim();
  const num = parseFloat(cleaned);

  if (isNaN(num)) {
    return null;
  }

  // The captured value is already a percentage, return as-is
  return num;
}

/**
 * Detect the Ollama plan from the settings page HTML.
 */
function detectOllamaPlan(html: string): string | undefined {
  const lowerHtml = html.toLowerCase();

  if (lowerHtml.includes("pro") || lowerHtml.includes("paid")) {
    // Check for Ollama Pro
    if (lowerHtml.includes("ollama pro") || lowerHtml.includes("pro plan")) {
      return "Ollama Pro";
    }
  }

  if (lowerHtml.includes("free") || lowerHtml.includes("starter")) {
    return "Free";
  }

  return undefined;
}
