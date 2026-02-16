/**
 * Cost Metrics & Reporting
 *
 * Provides aggregated cost metrics, summaries, and reporting utilities
 * for monitoring spending across sessions and models.
 */

import type { NormalizedUsage } from "../agents/usage.js";
import type { CostUsageSummary } from "./session-cost-usage.js";

/**
 * Cost metrics summary for a specific time period
 */
export type CostMetrics = {
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  averageCostPerSession?: number;
  averageCostPerToken?: number;
  sessions?: number;
};

/**
 * Cost breakdown by model
 */
export type ModelCostBreakdown = {
  model: string;
  provider: string;
  totalCost: number;
  totalTokens: number;
  sessionCount: number;
};

/**
 * Format cost metrics for display
 *
 * @param metrics - Cost metrics to format
 * @returns Formatted string with metrics
 */
export function formatCostMetrics(metrics: CostMetrics): string {
  const parts: string[] = [];

  if (metrics.totalCost > 0) {
    parts.push(`💵 Total Cost: $${metrics.totalCost.toFixed(4)}`);
  }

  if (metrics.totalTokens > 0) {
    parts.push(`🧮 Total Tokens: ${formatTokenCount(metrics.totalTokens)}`);
  }

  if (metrics.inputTokens > 0 || metrics.outputTokens > 0) {
    parts.push(
      `📊 Input: ${formatTokenCount(metrics.inputTokens)}, Output: ${formatTokenCount(metrics.outputTokens)}`,
    );
  }

  if (metrics.averageCostPerSession && metrics.averageCostPerSession > 0) {
    parts.push(`💰 Avg/Session: $${metrics.averageCostPerSession.toFixed(4)}`);
  }

  if (metrics.averageCostPerToken && metrics.averageCostPerToken > 0) {
    parts.push(`🪙 Cost/Token: $${metrics.averageCostPerToken.toFixed(6)}`);
  }

  if (metrics.sessions && metrics.sessions > 0) {
    parts.push(`🔢 Sessions: ${metrics.sessions}`);
  }

  return parts.join(" · ");
}

/**
 * Extract cost metrics from a usage summary
 *
 * @param summary - Cost usage summary
 * @param sessionCount - Number of sessions included
 * @returns Computed cost metrics
 */
export function extractCostMetrics(summary: CostUsageSummary, sessionCount?: number): CostMetrics {
  const totals = summary.totals;
  const totalTokens = totals.totalTokens ?? 0;
  const totalCost = totals.totalCost ?? 0;
  const inputTokens = totals.input ?? 0;
  const outputTokens = totals.output ?? 0;

  const averageCostPerToken = totalTokens > 0 ? totalCost / totalTokens : 0;
  const averageCostPerSession =
    sessionCount && sessionCount > 0 ? totalCost / sessionCount : undefined;

  return {
    totalCost,
    totalTokens,
    inputTokens,
    outputTokens,
    averageCostPerSession,
    averageCostPerToken,
    sessions: sessionCount,
  };
}

/**
 * Calculate cost efficiency metrics
 *
 * @param cost - Total cost in dollars
 * @param tokens - Total tokens used
 * @param sessions - Number of sessions
 * @returns Efficiency metrics
 */
export function calculateEfficiencyMetrics(cost: number, tokens: number, sessions: number) {
  return {
    costPerToken: tokens > 0 ? (cost / tokens) * 1_000_000 : 0, // USD per 1M tokens (normalized)
    costPerSession: sessions > 0 ? cost / sessions : 0,
    tokensPerDollar: cost > 0 ? tokens / cost : 0,
    sessionsPerDollar: cost > 0 ? sessions / cost : 0,
  };
}

/**
 * Format token count with human-readable units
 *
 * @param value - Token count
 * @returns Formatted string (e.g., "1.2k", "5.3M")
 */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

/**
 * Compare cost between two usage patterns
 */
export function compareCosts(
  before: NormalizedUsage,
  after: NormalizedUsage,
  costPerToken: number,
): {
  beforeCost: number;
  afterCost: number;
  savings: number;
  savingsPercent: number;
} {
  const beforeTotal = (before.total ?? (before.input ?? 0) + (before.output ?? 0)) * costPerToken;
  const afterTotal = (after.total ?? (after.input ?? 0) + (after.output ?? 0)) * costPerToken;
  const savings = beforeTotal - afterTotal;
  const savingsPercent = beforeTotal > 0 ? (savings / beforeTotal) * 100 : 0;

  return {
    beforeCost: beforeTotal,
    afterCost: afterTotal,
    savings: Math.max(0, savings),
    savingsPercent: Math.max(0, savingsPercent),
  };
}

/**
 * Estimate cost for a hypothetical conversation
 *
 * Used for pre-planning and cost forecasting
 */
export function estimateConversationCost(params: {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTurns: number;
  modelCostPerMillionInput: number;
  modelCostPerMillionOutput: number;
}): {
  estimatedTotalCost: number;
  estimatedCostPerTurn: number;
  costRange: { low: number; high: number };
} {
  const inputCost = (params.estimatedInputTokens / 1_000_000) * params.modelCostPerMillionInput;
  const outputCost = (params.estimatedOutputTokens / 1_000_000) * params.modelCostPerMillionOutput;
  const estimatedTotalCost = (inputCost + outputCost) * params.estimatedTurns;
  const estimatedCostPerTurn = estimatedTotalCost / params.estimatedTurns;

  // Cost range with ±20% variance
  const costRange = {
    low: estimatedTotalCost * 0.8,
    high: estimatedTotalCost * 1.2,
  };

  return {
    estimatedTotalCost,
    estimatedCostPerTurn,
    costRange,
  };
}

/**
 * Format cost range for display
 */
export function formatCostRange(low: number, high: number): string {
  const lowFormatted = formatCostValue(low);
  const highFormatted = formatCostValue(high);
  return `${lowFormatted}–${highFormatted}`;
}

/**
 * Format a single cost value
 */
export function formatCostValue(cost: number): string {
  if (cost >= 1) {
    return `$${cost.toFixed(2)}`;
  }
  if (cost >= 0.01) {
    return `$${cost.toFixed(2)}`;
  }
  if (cost >= 0.0001) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(6)}`;
}

/**
 * Calculate ROI on cost savings (e.g., switching models)
 */
export function calculateCostSavingsROI(params: {
  previousMonthlyCost: number;
  newMonthlyCost: number;
  implementationCost?: number;
  months?: number;
}): {
  monthlySavings: number;
  annualSavings: number;
  paybackMonths: number;
  roi: number;
} {
  const monthlySavings = Math.max(0, params.previousMonthlyCost - params.newMonthlyCost);
  const annualSavings = monthlySavings * 12;
  const months = params.months ?? 12;
  const totalSavings = monthlySavings * months;
  const implementationCost = params.implementationCost ?? 0;
  const netSavings = totalSavings - implementationCost;
  const roi = implementationCost > 0 ? (netSavings / implementationCost) * 100 : 0;
  const paybackMonths = monthlySavings > 0 ? implementationCost / monthlySavings : 0;

  return {
    monthlySavings,
    annualSavings,
    paybackMonths,
    roi,
  };
}

/**
 * Cost status level categorization
 *
 * Used for alerts and notifications
 */
export type CostStatus = "healthy" | "warning" | "critical";

export function assessCostStatus(params: {
  dailySpend: number;
  monthlyBudget: number;
  dailyBudget?: number;
}): CostStatus {
  // Check daily budget
  if (params.dailyBudget) {
    if (params.dailySpend > params.dailyBudget * 1.5) {
      return "critical";
    }
    if (params.dailySpend > params.dailyBudget * 1.1) {
      return "warning";
    }
  }

  // Estimate monthly spend
  const projectedMonthly = params.dailySpend * 30;
  if (projectedMonthly > params.monthlyBudget) {
    return "critical";
  }
  if (projectedMonthly > params.monthlyBudget * 1.1) {
    return "warning";
  }

  return "healthy";
}
