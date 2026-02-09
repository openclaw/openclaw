/**
 * Model switching workflow automation
 * Detects complexity thresholds and initiates approval workflows for model upgrades
 */

export type ComplexityIndicators = {
  contextUsagePercent?: number;
  failedAttempts?: number;
  tokenBudgetExceeded?: boolean;
  operationDuration?: number; // milliseconds
  inputTokens?: number;
  outputTokens?: number;
};

export type ModelSwitchRequest = {
  fromModel: string;
  toModel: string;
  justification: string;
  indicators: ComplexityIndicators;
  timestamp: number;
};

/**
 * Detect if complexity threshold is exceeded
 */
export function detectComplexityThreshold(indicators: ComplexityIndicators): boolean {
  // Context usage > 50%
  if ((indicators.contextUsagePercent ?? 0) > 50) {
    return true;
  }

  // Multiple failed attempts (3+)
  if ((indicators.failedAttempts ?? 0) >= 3) {
    return true;
  }

  // Token budget exceeded
  if (indicators.tokenBudgetExceeded) {
    return true;
  }

  // Long-running operation (30+ seconds)
  if ((indicators.operationDuration ?? 0) > 30000) {
    return true;
  }

  return false;
}

/**
 * Generate justification message for model switch
 */
export function generateSwitchJustification(
  fromModel: string,
  toModel: string,
  indicators: ComplexityIndicators,
): string {
  const reasons: string[] = [];

  if ((indicators.contextUsagePercent ?? 0) > 50) {
    reasons.push(`High context usage: ${indicators.contextUsagePercent}%`);
  }

  if ((indicators.failedAttempts ?? 0) >= 3) {
    reasons.push(`Multiple failed attempts: ${indicators.failedAttempts}`);
  }

  if (indicators.tokenBudgetExceeded) {
    reasons.push("Token budget exceeded");
  }

  if ((indicators.operationDuration ?? 0) > 30000) {
    const seconds = Math.round((indicators.operationDuration ?? 0) / 1000);
    reasons.push(`Long-running operation: ${seconds}s`);
  }

  const reasonText = reasons.join(" • ");
  return `Auto-requesting model upgrade: ${fromModel} → ${toModel}\n\nReasons:\n${reasonText}`;
}

/**
 * Create a model switch request for approval workflow
 */
export function createModelSwitchRequest(
  fromModel: string,
  toModel: string,
  indicators: ComplexityIndicators,
): ModelSwitchRequest {
  return {
    fromModel,
    toModel,
    justification: generateSwitchJustification(fromModel, toModel, indicators),
    indicators,
    timestamp: Date.now(),
  };
}

/**
 * Format model switch request for Slack posting
 */
export function formatModelSwitchRequestForSlack(request: ModelSwitchRequest): string {
  const lines: string[] = [
    "🤖 **Model Upgrade Request**",
    `*From:* \`${request.fromModel}\``,
    `*To:* \`${request.toModel}\``,
    "",
    "**Justification:**",
    request.justification,
  ];

  if (request.indicators.inputTokens || request.indicators.outputTokens) {
    lines.push(
      "\n**Token Usage:**",
      `• Input: ${request.indicators.inputTokens?.toLocaleString() ?? "N/A"}`,
      `• Output: ${request.indicators.outputTokens?.toLocaleString() ?? "N/A"}`,
    );
  }

  lines.push("\n✅ = Approve upgrade");
  lines.push("⛔ = Deny upgrade");

  return lines.join("\n");
}

/**
 * Determine if model switch should be auto-applied
 * (for simpler cases that don't need approval)
 */
export function shouldAutoApplyModelSwitch(indicators: ComplexityIndicators): boolean {
  // Only auto-apply for extreme cases
  return indicators.tokenBudgetExceeded === true && (indicators.contextUsagePercent ?? 0) > 75;
}
