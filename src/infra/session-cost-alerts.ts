/**
 * Session cost alerting system
 * Monitors cumulative costs against configured thresholds
 */

import type { OpenClawConfig } from "../config/config.js";

export type CostAlertThresholds = {
  sessionThreshold?: number; // USD
  dailyThreshold?: number; // USD
};

export type CostAlertResult = {
  triggered: boolean;
  level: "none" | "warning" | "critical";
  message?: string;
  thresholdExceeded?: string;
  currentCost?: number;
  threshold?: number;
};

/**
 * Check if cumulative session cost exceeds thresholds
 */
export function checkSessionCostAlert(
  currentCost: number,
  thresholds: CostAlertThresholds,
): CostAlertResult {
  if (!thresholds.sessionThreshold || currentCost < thresholds.sessionThreshold) {
    return { triggered: false, level: "none" };
  }

  const percentage = (currentCost / thresholds.sessionThreshold) * 100;
  const level = percentage >= 100 ? "critical" : percentage >= 80 ? "warning" : "none";

  if (level === "none") {
    return { triggered: false, level: "none" };
  }

  return {
    triggered: true,
    level,
    message: `Session cost alert (${level}): $${currentCost.toFixed(2)} / $${thresholds.sessionThreshold.toFixed(2)}`,
    thresholdExceeded: "session",
    currentCost,
    threshold: thresholds.sessionThreshold,
  };
}

/**
 * Check if daily cost exceeds threshold
 */
export function checkDailyCostAlert(
  currentDailyCost: number,
  thresholds: CostAlertThresholds,
): CostAlertResult {
  if (!thresholds.dailyThreshold || currentDailyCost < thresholds.dailyThreshold) {
    return { triggered: false, level: "none" };
  }

  const percentage = (currentDailyCost / thresholds.dailyThreshold) * 100;
  const level = percentage >= 100 ? "critical" : percentage >= 80 ? "warning" : "none";

  if (level === "none") {
    return { triggered: false, level: "none" };
  }

  return {
    triggered: true,
    level,
    message: `Daily cost alert (${level}): $${currentDailyCost.toFixed(2)} / $${thresholds.dailyThreshold.toFixed(2)}`,
    thresholdExceeded: "daily",
    currentCost: currentDailyCost,
    threshold: thresholds.dailyThreshold,
  };
}

/**
 * Get all applicable cost alerts for a session
 */
export function getApplicableCostAlerts(
  sessionCost: number,
  dailyCost: number,
  cfg: OpenClawConfig,
): CostAlertResult[] {
  const thresholds = cfg.costAlerts ?? {};
  const alerts: CostAlertResult[] = [];

  const sessionAlert = checkSessionCostAlert(sessionCost, thresholds);
  if (sessionAlert.triggered) {
    alerts.push(sessionAlert);
  }

  const dailyAlert = checkDailyCostAlert(dailyCost, thresholds);
  if (dailyAlert.triggered) {
    alerts.push(dailyAlert);
  }

  return alerts;
}

/**
 * Format cost alerts for display/messaging
 */
export function formatCostAlerts(alerts: CostAlertResult[]): string {
  if (alerts.length === 0) {
    return "";
  }

  const criticals = alerts.filter((a) => a.level === "critical");
  const warnings = alerts.filter((a) => a.level === "warning");

  const lines: string[] = [];

  if (criticals.length > 0) {
    lines.push("🚨 **CRITICAL COST ALERTS:**");
    criticals.forEach((a) => lines.push(`  • ${a.message}`));
  }

  if (warnings.length > 0) {
    lines.push("⚠️ **COST WARNINGS:**");
    warnings.forEach((a) => lines.push(`  • ${a.message}`));
  }

  return lines.join("\n");
}
