/**
 * Benchmarking: compare attack test results over time.
 */

import type { AttackTest } from "./index.js";
import fs from "node:fs/promises";
import path from "node:path";

export type BenchmarkResult = {
  timestamp: number;
  totalTests: number;
  successfulAttacks: number;
  averageRiskScore: number;
  familyBreakdown: Record<string, { count: number; successRate: number }>;
};

export type RegressionDetection = {
  detected: boolean;
  regressionRate: number;
  threshold: number;
  details: string[];
};

/**
 * Load previous benchmark results.
 */
export async function loadBenchmarkResults(
  workspaceDir: string,
): Promise<BenchmarkResult[]> {
  const benchmarkFile = path.join(workspaceDir, "benchmark-results.json");
  
  try {
    const content = await fs.readFile(benchmarkFile, "utf-8");
    const results = JSON.parse(content) as BenchmarkResult[];
    return Array.isArray(results) ? results : [];
  } catch {
    return [];
  }
}

/**
 * Save benchmark results.
 */
export async function saveBenchmarkResult(
  workspaceDir: string,
  result: BenchmarkResult,
): Promise<void> {
  const benchmarkFile = path.join(workspaceDir, "benchmark-results.json");
  const existing = await loadBenchmarkResults(workspaceDir);
  const updated = [...existing, result].slice(-100); // Keep last 100 results
  
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(benchmarkFile, JSON.stringify(updated, null, 2));
}

/**
 * Calculate benchmark metrics from test results.
 */
export function calculateBenchmark(testResults: AttackTest[]): BenchmarkResult {
  const successfulAttacks = testResults.filter((t) => t.success).length;
  const averageRiskScore =
    testResults.reduce((sum, t) => sum + t.riskScore, 0) / testResults.length || 0;

  // Family breakdown
  const familyBreakdown: Record<string, { count: number; successRate: number }> = {};
  const families = new Set(testResults.map((t) => t.family));

  for (const family of families) {
    const familyTests = testResults.filter((t) => t.family === family);
    const familySuccess = familyTests.filter((t) => t.success).length;
    const successRate = familyTests.length > 0 ? familySuccess / familyTests.length : 0;

    familyBreakdown[family] = {
      count: familyTests.length,
      successRate,
    };
  }

  return {
    timestamp: Date.now(),
    totalTests: testResults.length,
    successfulAttacks,
    averageRiskScore,
    familyBreakdown,
  };
}

/**
 * Detect regressions compared to previous benchmarks.
 */
export function detectRegression(
  current: BenchmarkResult,
  previous: BenchmarkResult,
  threshold: number = 0.2,
): RegressionDetection {
  const details: string[] = [];
  let regressionRate = 0;

  // Compare success rates
  const currentSuccessRate = current.totalTests > 0
    ? current.successfulAttacks / current.totalTests
    : 0;
  const previousSuccessRate = previous.totalTests > 0
    ? previous.successfulAttacks / previous.totalTests
    : 0;

  const successRateChange = currentSuccessRate - previousSuccessRate;
  if (successRateChange > threshold) {
    regressionRate = successRateChange;
    details.push(
      `Success rate increased from ${(previousSuccessRate * 100).toFixed(1)}% to ${(currentSuccessRate * 100).toFixed(1)}%`,
    );
  }

  // Compare average risk scores
  const riskScoreChange = current.averageRiskScore - previous.averageRiskScore;
  if (riskScoreChange > 10) {
    details.push(
      `Average risk score increased from ${previous.averageRiskScore.toFixed(1)} to ${current.averageRiskScore.toFixed(1)}`,
    );
  }

  // Compare family breakdowns
  for (const [family, currentStats] of Object.entries(current.familyBreakdown)) {
    const previousStats = previous.familyBreakdown[family];
    if (previousStats) {
      const familyRegression = currentStats.successRate - previousStats.successRate;
      if (familyRegression > threshold) {
        details.push(
          `${family}: success rate increased from ${(previousStats.successRate * 100).toFixed(1)}% to ${(currentStats.successRate * 100).toFixed(1)}%`,
        );
      }
    }
  }

  const detected = regressionRate > threshold || details.length > 0;

  return {
    detected,
    regressionRate,
    threshold,
    details,
  };
}
