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
  status?: "completed" | "error" | "running";
  description?: string;
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
  creditsThisMonth: number;
  lastTaskAt?: number;
  // Budget awareness
  monthlyBudget: number;
  monthlyBudgetPercent: number;
  status: "healthy" | "caution" | "warning" | "critical";
  alerts: string[];
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

// Manus budget configuration
let manusMonthlyCreditBudget = 500; // Default 500 credits/month (conservative estimate)

export function setManusMonthlyCreditBudget(credits: number): void {
  manusMonthlyCreditBudget = credits;
}

export function getManusMonthlyCreditBudget(): number {
  return manusMonthlyCreditBudget;
}

/**
 * Record a Manus task completion.
 */
export function recordManusTask(
  taskId: string,
  credits: number,
  status?: "completed" | "error" | "running",
  description?: string,
): void {
  const s = loadStore();
  s.manusTasks.push({
    taskId,
    credits,
    timestamp: Date.now(),
    status,
    description,
  });
  // Keep only last 500 Manus tasks
  if (s.manusTasks.length > 500) {
    s.manusTasks = s.manusTasks.slice(-500);
  }
  saveStore();
}

/**
 * Get Manus usage summary (tasks and credits) with budget awareness.
 */
export function getManusUsageSummary(): ManusUsageSummary {
  const s = loadStore();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

  const todayTasks = s.manusTasks.filter((t) => t.timestamp >= todayStart);
  const monthTasks = s.manusTasks.filter((t) => t.timestamp >= monthStart);
  const lastTask = s.manusTasks.length > 0 ? s.manusTasks[s.manusTasks.length - 1] : undefined;

  const creditsThisMonth = monthTasks.reduce((sum, t) => sum + t.credits, 0);
  const monthlyBudgetPercent =
    manusMonthlyCreditBudget > 0 ? (creditsThisMonth / manusMonthlyCreditBudget) * 100 : 0;

  // Determine status based on budget usage
  let status: "healthy" | "caution" | "warning" | "critical" = "healthy";
  if (monthlyBudgetPercent >= 95) status = "critical";
  else if (monthlyBudgetPercent >= 85) status = "warning";
  else if (monthlyBudgetPercent >= 70) status = "caution";

  // Generate alerts
  const alerts: string[] = [];
  if (status === "critical") {
    alerts.push(
      `🔴 CRITICAL: Manus credits at ${monthlyBudgetPercent.toFixed(0)}% of monthly budget`,
    );
  } else if (status === "warning") {
    alerts.push(`🟠 Manus credits at ${monthlyBudgetPercent.toFixed(0)}% of monthly budget`);
  } else if (status === "caution") {
    alerts.push(`🟡 Manus credits at ${monthlyBudgetPercent.toFixed(0)}% of monthly budget`);
  }

  // Check for high daily usage (more than 10% of monthly in one day)
  const creditsToday = todayTasks.reduce((sum, t) => sum + t.credits, 0);
  const dailyPercent =
    manusMonthlyCreditBudget > 0 ? (creditsToday / manusMonthlyCreditBudget) * 100 : 0;
  if (dailyPercent > 10) {
    alerts.push(
      `⚡ High Manus usage today: ${creditsToday} credits (${dailyPercent.toFixed(0)}% of monthly)`,
    );
  }

  return {
    tasksToday: todayTasks.length,
    creditsToday,
    tasksTotal: s.manusTasks.length,
    creditsTotal: s.manusTasks.reduce((sum, t) => sum + t.credits, 0),
    creditsThisMonth,
    lastTaskAt: lastTask?.timestamp,
    monthlyBudget: manusMonthlyCreditBudget,
    monthlyBudgetPercent,
    status,
    alerts,
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

// ============================================================================
// BUDGET AWARENESS - AI self-awareness of costs and limits
// ============================================================================

export type BudgetStatus = "healthy" | "caution" | "warning" | "critical";
export type ThinkingRecommendation = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type BudgetAwarenessContext = {
  status: BudgetStatus;
  monthlyBudgetPercent: number;
  dailyLimitPercent: number;
  fiveHourLimitPercent: number;
  estimatedCostToday: number;
  estimatedCostMonth: number;
  recommendedThinking: ThinkingRecommendation;
  alerts: string[];
  shouldPreferCheaperModel: boolean;
  budgetRemaining: number;
  // For system prompt injection
  contextLine: string;
};

const BUDGET_THRESHOLDS = {
  caution: 70, // 70% - start being mindful
  warning: 85, // 85% - actively conserve
  critical: 95, // 95% - emergency mode
};

const THINKING_BY_BUDGET: Record<BudgetStatus, ThinkingRecommendation> = {
  healthy: "low", // Normal operation
  caution: "low", // Still allow thinking
  warning: "minimal", // Reduce thinking
  critical: "off", // No thinking to conserve
};

/**
 * Determine budget status based on highest usage percentage.
 */
function determineBudgetStatus(percentages: number[]): BudgetStatus {
  const maxPercent = Math.max(...percentages.filter((p) => !isNaN(p)));
  if (maxPercent >= BUDGET_THRESHOLDS.critical) return "critical";
  if (maxPercent >= BUDGET_THRESHOLDS.warning) return "warning";
  if (maxPercent >= BUDGET_THRESHOLDS.caution) return "caution";
  return "healthy";
}

/**
 * Get comprehensive budget awareness context for AI decision-making.
 * This provides the AI with self-awareness of resource constraints.
 */
export function getBudgetAwarenessContext(): BudgetAwarenessContext {
  const summaries = getTokenUsageSummaries();
  const alerts: string[] = [];

  // Aggregate across providers (primarily Claude for cost)
  let monthlyBudgetPercent = 0;
  let dailyLimitPercent = 0;
  let fiveHourLimitPercent = 0;
  let estimatedCostToday = 0;
  let estimatedCostMonth = 0;

  for (const summary of summaries) {
    // Use the highest percentages across providers
    if (summary.thisMonth.budgetPercent > monthlyBudgetPercent) {
      monthlyBudgetPercent = summary.thisMonth.budgetPercent;
    }
    if (summary.estimated.dailyPercent > dailyLimitPercent) {
      dailyLimitPercent = summary.estimated.dailyPercent;
    }
    if (summary.estimated.fiveHourPercent > fiveHourLimitPercent) {
      fiveHourLimitPercent = summary.estimated.fiveHourPercent;
    }
    estimatedCostToday += summary.today.estimatedCostUSD;
    estimatedCostMonth += summary.thisMonth.estimatedCostUSD;
  }

  // Determine overall status (including Manus)
  const manusForStatus = getManusUsageSummary();
  const tokenStatus = determineBudgetStatus([
    monthlyBudgetPercent,
    dailyLimitPercent,
    fiveHourLimitPercent,
  ]);

  // Take the worse status between tokens and Manus
  const statusPriorityForDetermination: Record<BudgetStatus, number> = {
    healthy: 0,
    caution: 1,
    warning: 2,
    critical: 3,
  };
  const status =
    statusPriorityForDetermination[manusForStatus.status] >
    statusPriorityForDetermination[tokenStatus]
      ? manusForStatus.status
      : tokenStatus;

  // Generate alerts
  if (monthlyBudgetPercent >= BUDGET_THRESHOLDS.critical) {
    alerts.push(`⚠️ CRITICAL: Monthly budget at ${monthlyBudgetPercent.toFixed(0)}%`);
  } else if (monthlyBudgetPercent >= BUDGET_THRESHOLDS.warning) {
    alerts.push(`⚠️ Monthly budget at ${monthlyBudgetPercent.toFixed(0)}%`);
  }

  if (fiveHourLimitPercent >= BUDGET_THRESHOLDS.warning) {
    alerts.push(`⏱️ 5h rate limit at ${fiveHourLimitPercent.toFixed(0)}%`);
  }

  if (dailyLimitPercent >= BUDGET_THRESHOLDS.warning) {
    alerts.push(`📅 Daily limit at ${dailyLimitPercent.toFixed(0)}%`);
  }

  // Include Manus budget in alerts
  const manusUsage = getManusUsageSummary();
  if (manusUsage.alerts.length > 0) {
    alerts.push(...manusUsage.alerts);
  }

  // Factor Manus into overall status if it's worse than token status
  const manusStatus = manusUsage.status;
  const statusPriority: Record<BudgetStatus, number> = {
    healthy: 0,
    caution: 1,
    warning: 2,
    critical: 3,
  };

  // Calculate remaining budget
  const budgetRemaining = Math.max(0, monthlyBudgetUSD - estimatedCostMonth);

  // Recommend thinking level
  const recommendedThinking = THINKING_BY_BUDGET[status];

  // Should prefer cheaper model?
  const shouldPreferCheaperModel = status === "warning" || status === "critical";

  // Build context line for system prompt
  const contextLine = buildBudgetContextLine({
    status,
    monthlyBudgetPercent,
    fiveHourLimitPercent,
    budgetRemaining,
    alerts,
  });

  return {
    status,
    monthlyBudgetPercent,
    dailyLimitPercent,
    fiveHourLimitPercent,
    estimatedCostToday,
    estimatedCostMonth,
    recommendedThinking,
    alerts,
    shouldPreferCheaperModel,
    budgetRemaining,
    contextLine,
  };
}

function buildBudgetContextLine(params: {
  status: BudgetStatus;
  monthlyBudgetPercent: number;
  fiveHourLimitPercent: number;
  budgetRemaining: number;
  alerts: string[];
}): string {
  const statusEmoji: Record<BudgetStatus, string> = {
    healthy: "🟢",
    caution: "🟡",
    warning: "🟠",
    critical: "🔴",
  };

  const parts: string[] = [
    `budget=${statusEmoji[params.status]}${params.status}`,
    `month=${params.monthlyBudgetPercent.toFixed(0)}%`,
    `5h=${params.fiveHourLimitPercent.toFixed(0)}%`,
    `remaining=$${params.budgetRemaining.toFixed(2)}`,
  ];

  if (params.alerts.length > 0) {
    parts.push(`alerts=${params.alerts.length}`);
  }

  return parts.join(" | ");
}

/**
 * Check if we should auto-downgrade thinking level based on budget.
 * Returns the adjusted thinking level, or the original if no adjustment needed.
 */
export function adjustThinkingForBudget(
  requestedLevel: ThinkingRecommendation,
  budgetContext?: BudgetAwarenessContext,
): ThinkingRecommendation {
  const ctx = budgetContext ?? getBudgetAwarenessContext();
  const recommended = ctx.recommendedThinking;

  // Thinking levels in order of cost
  const levels: ThinkingRecommendation[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const requestedIdx = levels.indexOf(requestedLevel);
  const recommendedIdx = levels.indexOf(recommended);

  // If requested is more expensive than recommended, downgrade
  if (requestedIdx > recommendedIdx) {
    return recommended;
  }

  return requestedLevel;
}

/**
 * Get a human-readable budget status summary for logging or display.
 */
export function getBudgetStatusSummary(): string {
  const ctx = getBudgetAwarenessContext();
  const lines: string[] = [
    `Budget Status: ${ctx.status.toUpperCase()}`,
    `Monthly: ${ctx.monthlyBudgetPercent.toFixed(1)}% ($${ctx.estimatedCostMonth.toFixed(2)} of $${monthlyBudgetUSD})`,
    `Daily Limit: ${ctx.dailyLimitPercent.toFixed(1)}%`,
    `5h Limit: ${ctx.fiveHourLimitPercent.toFixed(1)}%`,
    `Recommended Thinking: ${ctx.recommendedThinking}`,
  ];

  if (ctx.alerts.length > 0) {
    lines.push("Alerts:", ...ctx.alerts.map((a) => `  ${a}`));
  }

  return lines.join("\n");
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
