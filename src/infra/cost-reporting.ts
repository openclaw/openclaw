/**
 * Cost Reporting & Alerts
 *
 * Real-time cost reporting and budget alert system
 */

import type { CostUsageSummary, SessionCostSummary } from "./session-cost-usage.js";
import { formatCostValue } from "./cost-metrics.js";

/**
 * Budget configuration for a session or user
 */
export type BudgetConfig = {
  dailyBudget?: number;
  monthlyBudget: number;
  warningThreshold?: number; // Percentage, default 80%
  criticalThreshold?: number; // Percentage, default 100%
};

/**
 * Cost alert notification
 */
export type CostAlert = {
  level: "info" | "warning" | "critical";
  message: string;
  dailySpend: number;
  monthlySpend: number;
  budgetRemaining: number;
  percentageUsed: number;
};

/**
 * Session cost report
 */
export type SessionCostReport = {
  sessionId: string;
  totalCost: number;
  tokenCount: number;
  costPerToken: number;
  estimatedCostPerHour?: number;
  lastActivity?: Date;
};

/**
 * Generate a cost alert for budget monitoring
 *
 * @param dailySpend - Current daily spending
 * @param budget - Budget configuration
 * @returns Alert if spending exceeds threshold, undefined otherwise
 */
export function generateBudgetAlert(
  dailySpend: number,
  budget: BudgetConfig,
): CostAlert | undefined {
  const warningThreshold = budget.warningThreshold ?? 0.8;
  const criticalThreshold = budget.criticalThreshold ?? 1.0;

  // Check monthly budget
  const monthlySpend = dailySpend * 30; // Projected
  const monthlyPercentage = monthlySpend / budget.monthlyBudget;
  const budgetRemaining = Math.max(0, budget.monthlyBudget - monthlySpend);

  // Critical: over budget
  if (monthlyPercentage >= criticalThreshold) {
    return {
      level: "critical",
      message: `⛔ Critical: Monthly spending ($${monthlySpend.toFixed(2)}) exceeds budget ($${budget.monthlyBudget.toFixed(2)})`,
      dailySpend,
      monthlySpend,
      budgetRemaining,
      percentageUsed: monthlyPercentage * 100,
    };
  }

  // Warning: approaching budget
  if (monthlyPercentage >= warningThreshold) {
    return {
      level: "warning",
      message: `⚠️ Warning: Monthly spending ($${monthlySpend.toFixed(2)}) at ${(monthlyPercentage * 100).toFixed(0)}% of budget ($${budget.monthlyBudget.toFixed(2)})`,
      dailySpend,
      monthlySpend,
      budgetRemaining,
      percentageUsed: monthlyPercentage * 100,
    };
  }

  // Info: normal spending
  if (monthlySpend > 0) {
    return {
      level: "info",
      message: `📊 Monthly spending ($${monthlySpend.toFixed(2)}) is ${(monthlyPercentage * 100).toFixed(0)}% of budget ($${budget.monthlyBudget.toFixed(2)})`,
      dailySpend,
      monthlySpend,
      budgetRemaining,
      percentageUsed: monthlyPercentage * 100,
    };
  }

  return undefined;
}

/**
 * Format a cost alert for display
 */
export function formatCostAlert(alert: CostAlert): string {
  const budgetBar = formatBudgetBar(alert.percentageUsed);
  const remaining = formatCostValue(alert.budgetRemaining);

  return [
    alert.message,
    `${budgetBar} ${alert.percentageUsed.toFixed(1)}% (${remaining} remaining)`,
    `Daily: ${formatCostValue(alert.dailySpend)} | Monthly: ${formatCostValue(alert.monthlySpend)}`,
  ].join("\n");
}

/**
 * Format a visual budget usage bar
 *
 * @param percentageUsed - Percentage of budget used (0-100+)
 * @returns Visual bar string
 */
export function formatBudgetBar(percentageUsed: number): string {
  const barLength = 20;
  const filled = Math.min(barLength, Math.floor((percentageUsed / 100) * barLength));
  const empty = barLength - filled;

  let emoji = "🟢"; // Green for healthy
  if (percentageUsed >= 80) {
    emoji = "🟡"; // Yellow for warning
  }
  if (percentageUsed >= 100) {
    emoji = "🔴"; // Red for critical
  }

  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `${emoji} [${bar}]`;
}

/**
 * Generate a session cost report
 */
export function generateSessionCostReport(
  sessionId: string,
  costSummary: SessionCostSummary,
): SessionCostReport {
  const totalCost = costSummary.totalCost ?? 0;
  const tokenCount = costSummary.totalTokens ?? 0;
  const costPerToken = tokenCount > 0 ? totalCost / tokenCount : 0;

  // Estimate hourly cost if we have timestamp data
  let estimatedCostPerHour: number | undefined;
  if (costSummary.lastActivity) {
    const ageMs = Date.now() - costSummary.lastActivity;
    const hours = ageMs / (1000 * 60 * 60);
    if (hours > 0 && hours <= 24) {
      estimatedCostPerHour = totalCost / hours;
    }
  }

  return {
    sessionId,
    totalCost,
    tokenCount,
    costPerToken,
    estimatedCostPerHour,
    lastActivity: costSummary.lastActivity ? new Date(costSummary.lastActivity) : undefined,
  };
}

/**
 * Format a session cost report
 */
export function formatSessionCostReport(report: SessionCostReport): string {
  const parts: string[] = [];

  parts.push(`📋 Session: ${report.sessionId}`);

  if (report.totalCost > 0) {
    parts.push(`💵 Total Cost: ${formatCostValue(report.totalCost)}`);
  }

  if (report.tokenCount > 0) {
    parts.push(`🧮 Tokens: ${report.tokenCount.toLocaleString()}`);
  }

  if (report.costPerToken > 0) {
    parts.push(`🪙 Cost/Token: ${formatCostValue(report.costPerToken / 1_000_000)}`);
  }

  if (report.estimatedCostPerHour && report.estimatedCostPerHour > 0) {
    parts.push(`⏰ Est. Cost/Hour: ${formatCostValue(report.estimatedCostPerHour)}`);
  }

  if (report.lastActivity) {
    const ago = formatTimeDiff(Date.now() - report.lastActivity.getTime());
    parts.push(`🕒 Last Activity: ${ago}`);
  }

  return parts.join("\n");
}

/**
 * Format time difference in human-readable format
 */
function formatTimeDiff(ms: number): string {
  if (ms < 60_000) {
    return "just now";
  }
  if (ms < 3_600_000) {
    const minutes = Math.round(ms / 60_000);
    return `${minutes}m ago`;
  }
  if (ms < 86_400_000) {
    const hours = Math.round(ms / 3_600_000);
    return `${hours}h ago`;
  }
  const days = Math.round(ms / 86_400_000);
  return `${days}d ago`;
}

/**
 * Analyze cost trends over time
 */
export function analyzeCostTrend(summaries: CostUsageSummary[]): {
  avgDaily: number;
  trend: "increasing" | "decreasing" | "stable";
  projectedMonthly: number;
} {
  if (summaries.length === 0) {
    return { avgDaily: 0, trend: "stable", projectedMonthly: 0 };
  }

  const costs = summaries.map((s) => s.totals.totalCost ?? 0);
  const avgDaily = costs.reduce((a, b) => a + b, 0) / costs.length;

  // Determine trend
  let trend: "increasing" | "decreasing" | "stable" = "stable";
  if (costs.length >= 2) {
    const firstHalf = costs.slice(0, Math.floor(costs.length / 2)).reduce((a, b) => a + b, 0);
    const secondHalf = costs.slice(Math.floor(costs.length / 2)).reduce((a, b) => a + b, 0);
    const firstAvg = firstHalf / Math.floor(costs.length / 2);
    const secondAvg = secondHalf / Math.ceil(costs.length / 2);

    if (secondAvg > firstAvg * 1.1) {
      trend = "increasing";
    } else if (secondAvg < firstAvg * 0.9) {
      trend = "decreasing";
    }
  }

  const projectedMonthly = avgDaily * 30;

  return { avgDaily, trend, projectedMonthly };
}

/**
 * Format cost trend analysis
 */
export function formatCostTrend(analysis: ReturnType<typeof analyzeCostTrend>): string {
  const trendEmoji = {
    increasing: "📈",
    decreasing: "📉",
    stable: "➡️",
  }[analysis.trend];

  return [
    `${trendEmoji} Trend: ${analysis.trend}`,
    `Daily Average: ${formatCostValue(analysis.avgDaily)}`,
    `Projected Monthly: ${formatCostValue(analysis.projectedMonthly)}`,
  ].join("\n");
}

/**
 * Compare two cost summaries
 */
export function compareCostPeriods(
  before: CostUsageSummary,
  after: CostUsageSummary,
): {
  costChange: number;
  costChangePercent: number;
  tokenChange: number;
  efficiency: string;
} {
  const beforeCost = before.totals.totalCost ?? 0;
  const afterCost = after.totals.totalCost ?? 0;
  const costChange = afterCost - beforeCost;
  const costChangePercent = beforeCost > 0 ? (costChange / beforeCost) * 100 : 0;

  const beforeTokens = before.totals.totalTokens ?? 0;
  const afterTokens = after.totals.totalTokens ?? 0;
  const tokenChange = afterTokens - beforeTokens;

  let efficiency = "→"; // Arrow right for no change
  if (costChangePercent < -10) {
    efficiency = "📊 Better efficiency";
  } else if (costChangePercent > 10) {
    efficiency = "⚠️ Worse efficiency";
  }

  return {
    costChange,
    costChangePercent,
    tokenChange,
    efficiency,
  };
}

/**
 * Format cost comparison
 */
export function formatCostComparison(comparison: ReturnType<typeof compareCostPeriods>): string {
  const direction = comparison.costChange > 0 ? "📈" : "📉";
  const change = formatCostValue(Math.abs(comparison.costChange));

  return [
    `${direction} Cost Change: ${comparison.costChange > 0 ? "+" : ""}${change} (${comparison.costChangePercent.toFixed(1)}%)`,
    `🧮 Token Change: ${comparison.tokenChange > 0 ? "+" : ""}${comparison.tokenChange.toLocaleString()}`,
    comparison.efficiency,
  ].join("\n");
}
