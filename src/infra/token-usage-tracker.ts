/**
 * Token usage tracker - aggregates API token consumption over time windows.
 * Provides session and daily usage stats for display in the UI.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const TRACKER_FILE = "token-usage-tracker.json";

export type TokenUsageEntry = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  timestamp: number;
};

export type ManusTaskEntry = {
  taskId: string;
  credits: number;
  timestamp: number;
};

export type TokenUsageStore = {
  entries: TokenUsageEntry[];
  manusTasks: ManusTaskEntry[];
  sessionStartedAt: number;
};

export type ManusUsageSummary = {
  tasksToday: number;
  creditsToday: number;
  tasksTotal: number;
  creditsTotal: number;
  lastTaskAt?: number;
};

export type TokenUsageSummary = {
  provider: string;
  displayName: string;
  session: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestCount: number;
    estimatedCostUSD: number;
  };
  today: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestCount: number;
    estimatedCostUSD: number;
  };
  thisMonth: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestCount: number;
    estimatedCostUSD: number;
    budgetPercent: number;
    budgetUSD: number;
  };
  fiveHour: {
    outputTokens: number;
    requestCount: number;
    estimatedPercent?: number;
    estimatedLimit?: number;
  };
  rollingMinute: {
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
  };
  estimated: {
    tier: SubscriptionTier;
    fiveHourLimit: number;
    dailyLimit: number;
    fiveHourPercent: number;
    dailyPercent: number;
    // Optional labels for non-Claude providers (e.g., "RPM" for Google)
    fiveHourLabel?: string;
    dailyLabel?: string;
  };
};

let store: TokenUsageStore | null = null;
let sessionId: string | null = null;

function getTrackerPath(): string {
  const stateDir = resolveStateDir();
  return path.join(stateDir, TRACKER_FILE);
}

function loadStore(): TokenUsageStore {
  if (store) return store;

  try {
    const trackerPath = getTrackerPath();
    if (fs.existsSync(trackerPath)) {
      const raw = fs.readFileSync(trackerPath, "utf-8");
      store = JSON.parse(raw) as TokenUsageStore;
      // Prune entries older than 7 days
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      store.entries = store.entries.filter((e) => e.timestamp > cutoff);
      store.manusTasks = (store.manusTasks ?? []).filter((e) => e.timestamp > cutoff);
      return store;
    }
  } catch {
    // Ignore errors
  }

  store = {
    entries: [],
    manusTasks: [],
    sessionStartedAt: Date.now(),
  };
  return store;
}

function saveStore(): void {
  try {
    const trackerPath = getTrackerPath();
    fs.writeFileSync(trackerPath, JSON.stringify(store, null, 2));
  } catch {
    // Ignore errors
  }
}

/**
 * Record token usage from an API response.
 */
export function recordTokenUsage(entry: Omit<TokenUsageEntry, "timestamp">): void {
  const s = loadStore();
  s.entries.push({
    ...entry,
    timestamp: Date.now(),
  });
  // Keep only last 1000 entries to prevent unbounded growth
  if (s.entries.length > 1000) {
    s.entries = s.entries.slice(-1000);
  }
  saveStore();
}

/**
 * Record a Manus task completion.
 */
export function recordManusTask(taskId: string, credits: number): void {
  const s = loadStore();
  s.manusTasks.push({
    taskId,
    credits,
    timestamp: Date.now(),
  });
  // Keep only last 500 Manus tasks
  if (s.manusTasks.length > 500) {
    s.manusTasks = s.manusTasks.slice(-500);
  }
  saveStore();
}

/**
 * Get Manus usage summary (tasks and credits).
 */
export function getManusUsageSummary(): ManusUsageSummary {
  const s = loadStore();
  const todayStart = new Date().setHours(0, 0, 0, 0);

  const todayTasks = s.manusTasks.filter((t) => t.timestamp >= todayStart);
  const lastTask = s.manusTasks.length > 0 ? s.manusTasks[s.manusTasks.length - 1] : undefined;

  return {
    tasksToday: todayTasks.length,
    creditsToday: todayTasks.reduce((sum, t) => sum + t.credits, 0),
    tasksTotal: s.manusTasks.length,
    creditsTotal: s.manusTasks.reduce((sum, t) => sum + t.credits, 0),
    lastTaskAt: lastTask?.timestamp,
  };
}

/**
 * Start a new session (resets session counters).
 */
export function startNewSession(newSessionId?: string): void {
  const s = loadStore();
  s.sessionStartedAt = Date.now();
  sessionId = newSessionId ?? `session-${Date.now()}`;
  saveStore();
}

/**
 * Get the current session start time.
 */
export function getSessionStartedAt(): number {
  return loadStore().sessionStartedAt;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Claude (API)",
  openai: "OpenAI",
  google: "Gemini",
  openrouter: "OpenRouter",
};

// Estimated token limits by subscription tier (output tokens)
// These are approximations based on community reports
export type SubscriptionTier = "free" | "pro" | "max_5x" | "max_20x" | "api";

const ESTIMATED_LIMITS: Record<SubscriptionTier, { fiveHour: number; daily: number }> = {
  free: { fiveHour: 8_000, daily: 25_000 },
  pro: { fiveHour: 45_000, daily: 300_000 },
  max_5x: { fiveHour: 225_000, daily: 1_500_000 },
  max_20x: { fiveHour: 900_000, daily: 6_000_000 },
  api: { fiveHour: Infinity, daily: Infinity }, // API has different limits
};

// Pricing per 1M tokens (USD) - updated for Claude 4 / 2025 pricing
// These are approximations; actual prices vary by model
const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheRead?: number; cacheWrite?: number }
> = {
  // Claude 4 Opus
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-5": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  // Claude 4 Sonnet
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Claude 3.5 (legacy)
  "claude-3-5-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // Gemini 2.0 / 3.0 models (as of 2025)
  "gemini-3-pro": { input: 1.25, output: 5 },
  "gemini-3-pro-preview": { input: 1.25, output: 5 },
  "gemini-2-flash": { input: 0.1, output: 0.4 },
  "gemini-2-flash-lite": { input: 0.02, output: 0.08 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  // Default fallback
  default: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

// Budget configuration
let monthlyBudgetUSD = 200; // Default €200 ≈ $215 USD

export function setMonthlyBudget(usd: number): void {
  monthlyBudgetUSD = usd;
}

export function getMonthlyBudget(): number {
  return monthlyBudgetUSD;
}

let configuredTier: SubscriptionTier = "max_5x"; // Default to Max 5x

export function setSubscriptionTier(tier: SubscriptionTier): void {
  configuredTier = tier;
}

export function getSubscriptionTier(): SubscriptionTier {
  return configuredTier;
}

/**
 * Get pricing for a model (looks up by partial match).
 */
function getPricing(model: string): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const normalized = model.toLowerCase();
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (key !== "default" && normalized.includes(key)) {
      return {
        input: pricing.input,
        output: pricing.output,
        cacheRead: pricing.cacheRead ?? pricing.input * 0.1,
        cacheWrite: pricing.cacheWrite ?? pricing.input * 1.25,
      };
    }
  }
  const def = MODEL_PRICING.default;
  return {
    input: def.input,
    output: def.output,
    cacheRead: def.cacheRead ?? def.input * 0.1,
    cacheWrite: def.cacheWrite ?? def.input * 1.25,
  };
}

/**
 * Calculate cost in USD for a single entry.
 */
function calculateEntryCost(entry: TokenUsageEntry): number {
  const pricing = getPricing(entry.model);
  const inputCost = (entry.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (entry.outputTokens / 1_000_000) * pricing.output;
  const cacheReadCost = ((entry.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheRead;
  const cacheWriteCost = ((entry.cacheWriteTokens ?? 0) / 1_000_000) * pricing.cacheWrite;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Get aggregated usage summaries by provider.
 */
export function getTokenUsageSummaries(): TokenUsageSummary[] {
  const s = loadStore();
  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
  const oneMinuteAgo = now - 60 * 1000;
  const sessionStart = s.sessionStartedAt;

  // Group by provider
  const byProvider = new Map<string, TokenUsageEntry[]>();
  for (const entry of s.entries) {
    const existing = byProvider.get(entry.provider) ?? [];
    existing.push(entry);
    byProvider.set(entry.provider, existing);
  }

  const summaries: TokenUsageSummary[] = [];
  const limits = ESTIMATED_LIMITS[configuredTier];

  for (const [provider, entries] of byProvider) {
    const sessionEntries = entries.filter((e) => e.timestamp >= sessionStart);
    const todayEntries = entries.filter((e) => e.timestamp >= todayStart);
    const monthEntries = entries.filter((e) => e.timestamp >= monthStart);
    const fiveHourEntries = entries.filter((e) => e.timestamp >= fiveHoursAgo);
    const minuteEntries = entries.filter((e) => e.timestamp >= oneMinuteAgo);

    const sumEntries = (list: TokenUsageEntry[]) => ({
      inputTokens: list.reduce((sum, e) => sum + e.inputTokens, 0),
      outputTokens: list.reduce((sum, e) => sum + e.outputTokens, 0),
      totalTokens: list.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0),
      requestCount: list.length,
    });

    const sumCost = (list: TokenUsageEntry[]) =>
      list.reduce((sum, e) => sum + calculateEntryCost(e), 0);

    const fiveHourOutput = fiveHourEntries.reduce((sum, e) => sum + e.outputTokens, 0);
    const todayOutput = todayEntries.reduce((sum, e) => sum + e.outputTokens, 0);
    const todayRequests = todayEntries.length;
    const minuteRequests = minuteEntries.length;

    // Calculate estimated percentages based on provider
    const isClaudeProvider = provider === "anthropic" || provider.includes("claude");
    const isGoogleProvider = provider === "google" || provider.includes("gemini");

    // Google/Gemini limits (free tier API key)
    // Free tier: 15 RPM, 1500 RPD, 1M TPM
    const googleLimits = { rpm: 15, rpd: 1500, tpm: 1_000_000 };

    let fiveHourPercent = 0;
    let dailyPercent = 0;

    if (isClaudeProvider && limits.fiveHour !== Infinity) {
      fiveHourPercent = Math.min(100, (fiveHourOutput / limits.fiveHour) * 100);
      dailyPercent = Math.min(100, (todayOutput / limits.daily) * 100);
    } else if (isGoogleProvider) {
      // For Google, show daily request % (RPD limit)
      dailyPercent = Math.min(100, (todayRequests / googleLimits.rpd) * 100);
      // For 5h, show minute requests as % of RPM (most relevant limit)
      fiveHourPercent = Math.min(100, (minuteRequests / googleLimits.rpm) * 100);
    }

    // Calculate costs
    const sessionCost = sumCost(sessionEntries);
    const todayCost = sumCost(todayEntries);
    const monthCost = sumCost(monthEntries);
    const budgetPercent =
      monthlyBudgetUSD > 0 ? Math.min(100, (monthCost / monthlyBudgetUSD) * 100) : 0;

    // Rolling minute stats
    const minuteStats = sumEntries(minuteEntries);

    // Month stats
    const monthStats = sumEntries(monthEntries);

    summaries.push({
      provider,
      displayName: PROVIDER_DISPLAY_NAMES[provider] ?? provider,
      session: { ...sumEntries(sessionEntries), estimatedCostUSD: sessionCost },
      today: { ...sumEntries(todayEntries), estimatedCostUSD: todayCost },
      thisMonth: {
        ...monthStats,
        estimatedCostUSD: monthCost,
        budgetPercent,
        budgetUSD: monthlyBudgetUSD,
      },
      fiveHour: {
        outputTokens: fiveHourOutput,
        requestCount: fiveHourEntries.length,
        estimatedPercent: isClaudeProvider || isGoogleProvider ? fiveHourPercent : undefined,
        estimatedLimit: isClaudeProvider
          ? limits.fiveHour
          : isGoogleProvider
            ? googleLimits.rpm
            : undefined,
      },
      rollingMinute: {
        inputTokens: minuteStats.inputTokens,
        outputTokens: minuteStats.outputTokens,
        requestCount: minuteStats.requestCount,
      },
      estimated: {
        tier: isGoogleProvider ? "api" : configuredTier,
        fiveHourLimit: isGoogleProvider ? googleLimits.rpm : limits.fiveHour,
        dailyLimit: isGoogleProvider ? googleLimits.rpd : limits.daily,
        fiveHourPercent,
        dailyPercent,
        // Google-specific labels
        fiveHourLabel: isGoogleProvider ? "RPM" : undefined,
        dailyLabel: isGoogleProvider ? "RPD" : undefined,
      },
    });
  }

  return summaries;
}

/**
 * Clear all tracked usage (for testing or reset).
 */
export function clearTokenUsage(): void {
  store = {
    entries: [],
    manusTasks: [],
    sessionStartedAt: Date.now(),
  };
  saveStore();
}
