/**
 * Venice balance tracking module.
 *
 * Extracts and tracks Venice API balance from response headers:
 * - x-venice-balance-diem: DIEM token balance
 * - x-venice-balance-usd: USD credit balance
 *
 * This module provides:
 * - Balance extraction from response headers
 * - Global balance state management
 * - Warning/threshold evaluation
 * - Fetch interceptor for automatic balance capture
 */

export interface VeniceBalance {
  diem?: number;
  usd?: number;
  lastChecked: number;
  /** Provider identifier (for multi-key scenarios) */
  providerId?: string;
  /** Rate limit info (tracks API key spending cap usage) */
  rateLimit?: {
    /** Max requests allowed in current window */
    limitRequests?: number;
    /** Remaining requests in current window */
    remainingRequests?: number;
    /** Max tokens allowed in current window */
    limitTokens?: number;
    /** Remaining tokens in current window */
    remainingTokens?: number;
    /** Reset timestamp (unix ms) */
    resetAt?: number;
  };
}

export interface VeniceBalanceThresholds {
  enabled: boolean;
  /** Warn when DIEM balance falls below this value (default: 5) */
  lowDiemThreshold: number;
  /** Critical warning when DIEM balance falls below this value (default: 2) */
  criticalDiemThreshold: number;
  /** Warn when remaining requests falls below this percentage of limit (default: 10%) */
  lowRateLimitPercent: number;
  /** Critical warning when remaining requests falls below this percentage (default: 5%) */
  criticalRateLimitPercent: number;
  showInStatus: boolean;
}

export const DEFAULT_VENICE_BALANCE_THRESHOLDS: VeniceBalanceThresholds = {
  enabled: true,
  lowDiemThreshold: 5,
  criticalDiemThreshold: 2,
  lowRateLimitPercent: 10,
  criticalRateLimitPercent: 5,
  showInStatus: true,
};

// Singleton balance state (in-memory, cleared on restart)
let currentBalance: VeniceBalance | null = null;
let balanceUpdateCallbacks: Array<(balance: VeniceBalance) => void> = [];

/**
 * Extract Venice balance from response headers.
 * Returns null if no Venice balance headers are present.
 */
export function extractVeniceBalance(headers: Headers | Record<string, string>): VeniceBalance | null {
  const get = (key: string): string | null => {
    if (headers instanceof Headers) {
      return headers.get(key);
    }
    // Handle plain object headers
    const value = headers[key] ?? headers[key.toLowerCase()];
    return typeof value === "string" ? value : null;
  };

  const diemRaw = get("x-venice-balance-diem");
  if (!diemRaw) return null;

  const diem = parseFloat(diemRaw);
  if (isNaN(diem)) return null;

  const usdRaw = get("x-venice-balance-usd");

  // Extract rate limit headers (tracks API key spending cap)
  const limitRequestsRaw = get("x-ratelimit-limit-requests");
  const remainingRequestsRaw = get("x-ratelimit-remaining-requests");
  const limitTokensRaw = get("x-ratelimit-limit-tokens");
  const remainingTokensRaw = get("x-ratelimit-remaining-tokens");
  const resetRequestsRaw = get("x-ratelimit-reset-requests");

  const rateLimit = (limitRequestsRaw || remainingRequestsRaw || limitTokensRaw || remainingTokensRaw)
    ? {
        limitRequests: limitRequestsRaw ? parseInt(limitRequestsRaw, 10) : undefined,
        remainingRequests: remainingRequestsRaw ? parseInt(remainingRequestsRaw, 10) : undefined,
        limitTokens: limitTokensRaw ? parseInt(limitTokensRaw, 10) : undefined,
        remainingTokens: remainingTokensRaw ? parseInt(remainingTokensRaw, 10) : undefined,
        resetAt: resetRequestsRaw ? parseInt(resetRequestsRaw, 10) : undefined,
      }
    : undefined;

  return {
    diem,
    usd: usdRaw ? parseFloat(usdRaw) : undefined,
    rateLimit,
    lastChecked: Date.now(),
  };
}

/**
 * Update the current Venice balance state.
 * Called by the streaming/fetch layer when Venice headers are detected.
 */
export function updateVeniceBalance(balance: VeniceBalance): void {
  currentBalance = balance;
  for (const callback of balanceUpdateCallbacks) {
    try {
      callback(balance);
    } catch {
      // Ignore callback errors
    }
  }
}

/**
 * Get the current Venice balance (if known).
 */
export function getVeniceBalance(): VeniceBalance | null {
  return currentBalance;
}

/**
 * Clear the current Venice balance state.
 * Useful for testing or when switching accounts.
 */
export function clearVeniceBalance(): void {
  currentBalance = null;
}

/**
 * Subscribe to balance updates.
 * Returns an unsubscribe function.
 */
export function onVeniceBalanceUpdate(
  callback: (balance: VeniceBalance) => void,
): () => void {
  balanceUpdateCallbacks.push(callback);
  return () => {
    balanceUpdateCallbacks = balanceUpdateCallbacks.filter((cb) => cb !== callback);
  };
}

/**
 * Evaluate balance status against thresholds.
 */
export type BalanceStatus = "ok" | "low" | "critical" | "depleted" | "unknown";

export interface BalanceEvaluation {
  status: BalanceStatus;
  /** Why this status was assigned */
  reason: "diem" | "rate_limit" | "unknown";
  /** Human-readable details */
  details?: string;
}

export function evaluateBalanceStatus(
  balance: VeniceBalance | null,
  thresholds: VeniceBalanceThresholds = DEFAULT_VENICE_BALANCE_THRESHOLDS,
): BalanceStatus {
  return evaluateBalanceDetailed(balance, thresholds).status;
}

/**
 * Evaluate balance with detailed reason.
 */
export function evaluateBalanceDetailed(
  balance: VeniceBalance | null,
  thresholds: VeniceBalanceThresholds = DEFAULT_VENICE_BALANCE_THRESHOLDS,
): BalanceEvaluation {
  if (!balance) return { status: "unknown", reason: "unknown" };

  // Check DIEM balance first (most common)
  if (balance.diem !== undefined) {
    if (balance.diem <= 0) {
      return { status: "depleted", reason: "diem", details: "DIEM balance is zero" };
    }
    if (balance.diem < thresholds.criticalDiemThreshold) {
      return { status: "critical", reason: "diem", details: `DIEM below ${thresholds.criticalDiemThreshold}` };
    }
    if (balance.diem < thresholds.lowDiemThreshold) {
      return { status: "low", reason: "diem", details: `DIEM below ${thresholds.lowDiemThreshold}` };
    }
  }

  // Check rate limits (API key spending cap)
  if (balance.rateLimit) {
    const { limitRequests, remainingRequests, limitTokens, remainingTokens } = balance.rateLimit;

    // Check request limit
    if (limitRequests !== undefined && remainingRequests !== undefined && limitRequests > 0) {
      const remainingPercent = (remainingRequests / limitRequests) * 100;
      if (remainingRequests <= 0) {
        return { status: "depleted", reason: "rate_limit", details: "Request limit exhausted" };
      }
      if (remainingPercent < thresholds.criticalRateLimitPercent) {
        return { status: "critical", reason: "rate_limit", details: `Only ${remainingRequests}/${limitRequests} requests remaining` };
      }
      if (remainingPercent < thresholds.lowRateLimitPercent) {
        return { status: "low", reason: "rate_limit", details: `${remainingRequests}/${limitRequests} requests remaining` };
      }
    }

    // Check token limit
    if (limitTokens !== undefined && remainingTokens !== undefined && limitTokens > 0) {
      const remainingPercent = (remainingTokens / limitTokens) * 100;
      if (remainingTokens <= 0) {
        return { status: "depleted", reason: "rate_limit", details: "Token limit exhausted" };
      }
      if (remainingPercent < thresholds.criticalRateLimitPercent) {
        return { status: "critical", reason: "rate_limit", details: `Only ${remainingTokens.toLocaleString()}/${limitTokens.toLocaleString()} tokens remaining` };
      }
      if (remainingPercent < thresholds.lowRateLimitPercent) {
        return { status: "low", reason: "rate_limit", details: `${remainingTokens.toLocaleString()}/${limitTokens.toLocaleString()} tokens remaining` };
      }
    }
  }

  // If we have DIEM info, we're OK
  if (balance.diem !== undefined) {
    return { status: "ok", reason: "diem" };
  }

  return { status: "unknown", reason: "unknown" };
}

/**
 * Format balance for display in status output.
 */
export function formatVeniceBalanceStatus(
  balance: VeniceBalance | null,
  thresholds: VeniceBalanceThresholds = DEFAULT_VENICE_BALANCE_THRESHOLDS,
): string | null {
  if (!thresholds.showInStatus) return null;
  if (!balance) return null;

  const evaluation = evaluateBalanceDetailed(balance, thresholds);
  const diemLabel = balance.diem !== undefined ? balance.diem.toFixed(2) : "?";
  const ageMs = Date.now() - balance.lastChecked;
  const ageLabel = formatAge(ageMs);

  const statusEmoji: Record<BalanceStatus, string> = {
    ok: "✅",
    low: "⚠️",
    critical: "🚨",
    depleted: "❌",
    unknown: "❓",
  };

  const parts = [
    `DIEM: ${diemLabel}`,
  ];

  if (balance.usd !== undefined) {
    parts.push(`USD: $${balance.usd.toFixed(2)}`);
  }

  // Add rate limit info if available
  if (balance.rateLimit?.remainingRequests !== undefined && balance.rateLimit?.limitRequests !== undefined) {
    parts.push(`Requests: ${balance.rateLimit.remainingRequests}/${balance.rateLimit.limitRequests}`);
  }

  parts.push(`Status: ${statusEmoji[evaluation.status]} ${evaluation.status.toUpperCase()}`);
  
  // Add reason if not OK
  if (evaluation.status !== "ok" && evaluation.details) {
    parts.push(`(${evaluation.details})`);
  }

  parts.push(`(${ageLabel})`);

  return parts.join(" · ");
}

/**
 * Generate a user-facing balance warning message.
 * Returns null if balance is OK or warnings are disabled.
 */
export function generateBalanceWarning(
  balance: VeniceBalance | null,
  thresholds: VeniceBalanceThresholds = DEFAULT_VENICE_BALANCE_THRESHOLDS,
): string | null {
  if (!thresholds.enabled) return null;
  if (!balance) return null;

  const evaluation = evaluateBalanceDetailed(balance, thresholds);
  const diemLabel = balance.diem !== undefined ? balance.diem.toFixed(2) : "?";

  // DIEM-based warnings
  if (evaluation.reason === "diem") {
    switch (evaluation.status) {
      case "critical":
        return `🚨 Venice balance critical: ${diemLabel} DIEM remaining. Consider topping up at https://venice.ai/settings/billing`;
      case "low":
        return `⚠️ Venice balance low: ${diemLabel} DIEM remaining`;
      case "depleted":
        return `❌ Venice balance depleted (0.00 DIEM). Top up at https://venice.ai/settings/billing`;
    }
  }

  // Rate limit / spending cap warnings
  if (evaluation.reason === "rate_limit") {
    const rl = balance.rateLimit;
    const resetInfo = rl?.resetAt ? ` (resets ${formatAge(rl.resetAt - Date.now()).replace(" ago", "")})` : "";
    
    switch (evaluation.status) {
      case "critical":
        return `🚨 Venice API key limit critical: ${evaluation.details}${resetInfo}. Consider increasing your spending cap.`;
      case "low":
        return `⚠️ Venice API key limit low: ${evaluation.details}${resetInfo}`;
      case "depleted":
        return `❌ Venice API key limit reached: ${evaluation.details}. Increase your spending cap at https://venice.ai/settings/api`;
    }
  }

  return null;
}

/**
 * Check if an error message indicates Venice balance/billing issues.
 */
export function isVeniceBalanceError(error: string | Error): boolean {
  const message = typeof error === "string" ? error : error.message;
  const lower = message.toLowerCase();
  return (
    lower.includes("insufficient balance") ||
    lower.includes("insufficient_balance") ||
    lower.includes("spending_cap_exceeded") ||
    lower.includes("spending cap") ||
    lower.includes("credit limit") ||
    lower.includes("out of credits") ||
    lower.includes("balance depleted")
  );
}

/**
 * Format a Venice-specific error with helpful guidance.
 */
export function formatVeniceError(error: string | Error): string {
  const message = typeof error === "string" ? error : error.message;
  const lower = message.toLowerCase();

  if (lower.includes("insufficient balance") || lower.includes("insufficient_balance")) {
    const balance = getVeniceBalance();
    const balanceNote = balance?.diem !== undefined ? ` (current: ${balance.diem.toFixed(2)} DIEM)` : "";
    return `❌ Venice API error: Insufficient balance${balanceNote}.\nTop up at: https://venice.ai/settings/billing`;
  }

  if (lower.includes("spending_cap_exceeded") || lower.includes("spending cap")) {
    return `❌ Venice API error: API key spending cap reached.\nIncrease cap in API key settings or use a different key.`;
  }

  if (lower.includes("rate_limit") || lower.includes("rate limit")) {
    return `⏳ Venice API error: Rate limit exceeded.\nWait for reset or upgrade your plan.`;
  }

  // Return original error if not a known Venice error
  return message;
}

// Helper to format age in human-readable form
function formatAge(ms: number): string {
  if (ms < 0) return "unknown";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Create a fetch wrapper that extracts Venice balance headers.
 * Use this to wrap the global fetch when making Venice API calls.
 */
export function createVeniceFetchWrapper(
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async function veniceFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await baseFetch(input, init);

    // Try to extract Venice balance headers from response
    const balance = extractVeniceBalance(response.headers);
    if (balance) {
      updateVeniceBalance(balance);
    }

    return response;
  };
}

/**
 * Check if a provider string represents Venice.
 */
export function isVeniceProvider(provider: string): boolean {
  const normalized = provider.toLowerCase().trim();
  return normalized === "venice" || normalized.startsWith("venice/");
}

/**
 * Check if a URL is a Venice API endpoint.
 */
export function isVeniceApiUrl(url: string | URL | Request): boolean {
  try {
    const urlStr = url instanceof Request ? url.url : url.toString();
    const parsed = new URL(urlStr);
    return (
      parsed.hostname === "api.venice.ai" ||
      parsed.hostname.endsWith(".venice.ai")
    );
  } catch {
    return false;
  }
}

// Track whether fetch interceptor is installed
let fetchInterceptorInstalled = false;
let originalFetch: typeof fetch | null = null;

/**
 * Install a global fetch interceptor to capture Venice balance headers.
 * Safe to call multiple times - will only install once.
 *
 * @returns Uninstall function
 */
export function installVeniceFetchInterceptor(): () => void {
  if (fetchInterceptorInstalled) {
    return () => {}; // Already installed
  }

  originalFetch = globalThis.fetch;
  fetchInterceptorInstalled = true;

  globalThis.fetch = async function interceptedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await originalFetch!(input, init);

    // Only process Venice API responses
    if (isVeniceApiUrl(input)) {
      const balance = extractVeniceBalance(response.headers);
      if (balance) {
        updateVeniceBalance(balance);
      }
    }

    return response;
  };

  return () => {
    if (originalFetch && fetchInterceptorInstalled) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
      fetchInterceptorInstalled = false;
    }
  };
}

/**
 * Resolve Venice balance thresholds from config.
 */
export function resolveVeniceBalanceThresholds(
  config?: { models?: { veniceBalanceWarning?: Partial<VeniceBalanceThresholds> } },
): VeniceBalanceThresholds {
  const override = config?.models?.veniceBalanceWarning;
  if (!override) return DEFAULT_VENICE_BALANCE_THRESHOLDS;

  return {
    enabled: override.enabled ?? DEFAULT_VENICE_BALANCE_THRESHOLDS.enabled,
    lowDiemThreshold: override.lowDiemThreshold ?? DEFAULT_VENICE_BALANCE_THRESHOLDS.lowDiemThreshold,
    criticalDiemThreshold: override.criticalDiemThreshold ?? DEFAULT_VENICE_BALANCE_THRESHOLDS.criticalDiemThreshold,
    lowRateLimitPercent: override.lowRateLimitPercent ?? DEFAULT_VENICE_BALANCE_THRESHOLDS.lowRateLimitPercent,
    criticalRateLimitPercent: override.criticalRateLimitPercent ?? DEFAULT_VENICE_BALANCE_THRESHOLDS.criticalRateLimitPercent,
    showInStatus: override.showInStatus ?? DEFAULT_VENICE_BALANCE_THRESHOLDS.showInStatus,
  };
}
