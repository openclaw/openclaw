/**
 * ClarityBurst Autonomy Regression Validation Harness
 *
 * Purpose:
 * Validates that autonomous agent behavior has not regressed by running a fixed suite
 * of representative workflows under conditions where ClarityBurst returns PROCEED for
 * all required actions. Records baseline metrics, detects regressions, and reports
 * outcome quality without changing runtime behavior or policy logic.
 *
 * Workflow Categories:
 * 1. FILE_SYSTEM_OPS: Sequential file writes, reads, and transformations
 * 2. MEMORY_MODIFY: Session memory updates and hook handler execution
 * 3. SHELL_EXEC: Shell command execution with confirmation token bypass
 * 4. NETWORK_IO: Safe network operations (mocked to avoid external deps)
 * 5. SUBAGENT_SPAWN: Subagent lifecycle and communication patterns
 *
 * Metrics Tracked Per Workflow:
 * - Task completion: Did the workflow finish end-to-end?
 * - Tool-path continuity: Were all expected tool invocations in order?
 * - Retry behavior: Did retries occur and resolve correctly?
 * - Abstain count: How many operations were blocked (should be 0 in baseline)?
 * - Latency: Total ms and per-step breakdown for performance regression
 * - Final outcome quality: Semantic validation of end results
 *
 * Baseline Recording:
 * - First run creates baseline metrics file
 * - Subsequent runs compare against baseline
 * - Regressions reported with severity levels (CRITICAL, WARNING, INFO)
 *
 * Usage:
 * pnpm test src/clarityburst/__tests__/autonomy.regression.harness.test.ts
 *
 * Output:
 * Regression report (stdout or file) with:
 * - Per-workflow metrics delta
 * - Overall autonomy health score
 * - Actionable recommendations for failures
 */

import { randomUUID } from "node:crypto";

/**
 * Unique identifier for a workflow instance
 */
export type WorkflowId = string;

/**
 * Severity levels for regression findings
 */
export enum RegressionSeverity {
  CRITICAL = "CRITICAL",
  WARNING = "WARNING",
  INFO = "INFO",
}

/**
 * Single data point recorded during workflow execution
 */
export interface WorkflowMetric {
  /** Name of the metric (e.g., "tool_invocations", "latency_ms") */
  name: string;
  /** Value of the metric at this point */
  value: number | string | boolean;
  /** Optional context for the metric */
  context?: Record<string, unknown>;
  /** Timestamp when metric was recorded */
  recordedAtMs: number;
}

/**
 * Captured state at a specific tool invocation point
 */
export interface ToolPathPoint {
  /** Stage ID (e.g., FILE_SYSTEM_OPS) */
  stageId: string;
  /** Tool name or operation (e.g., "writeFile", "shell_exec") */
  toolName: string;
  /** Contract ID matched by router (null if abstained) */
  contractId: string | null;
  /** Router decision outcome */
  outcome: "PROCEED" | "ABSTAIN_CLARIFY" | "ABSTAIN_CONFIRM" | "MODIFY";
  /** Latency for this specific tool call in ms */
  latencyMs: number;
  /** Timestamp when tool was invoked */
  invokedAtMs: number;
  /** Any error that occurred */
  error?: string;
}

/**
 * Aggregated metrics for a single workflow run
 */
export interface WorkflowRunMetrics {
  /** Unique run ID */
  runId: string;
  /** Workflow identifier */
  workflowId: WorkflowId;
  /** Human-readable workflow name */
  workflowName: string;
  /** Timestamp when run started */
  startedAtMs: number;
  /** Timestamp when run ended (undefined if incomplete) */
  endedAtMs?: number;
  /** Did the workflow complete successfully? */
  completed: boolean;
  /** Latency of entire workflow in ms */
  totalLatencyMs: number;
  /** Count of tool invocations */
  toolInvocations: number;
  /** Count of PROCEED outcomes */
  proceedCount: number;
  /** Count of ABSTAIN_CLARIFY outcomes (should be 0 in baseline) */
  abstainClarifyCount: number;
  /** Count of ABSTAIN_CONFIRM outcomes (should be 0 in baseline) */
  abstainConfirmCount: number;
  /** Count of MODIFY outcomes */
  modifyCount: number;
  /** Count of retries executed */
  retries: number;
  /** Tool path continuity: ordered sequence of tool invocations */
  toolPath: ToolPathPoint[];
  /** Semantic validation result (e.g., file contents match expected) */
  semanticValidation: {
    passed: boolean;
    details: string;
  };
  /** Per-metric readings */
  metrics: WorkflowMetric[];
}

/**
 * Baseline metrics recorded from a previous run
 */
export interface WorkflowBaseline {
  /** Workflow ID */
  workflowId: WorkflowId;
  /** Workflow name */
  workflowName: string;
  /** Average total latency across baseline runs (ms) */
  avgTotalLatencyMs: number;
  /** Average tool invocations per run */
  avgToolInvocations: number;
  /** Average retries per run */
  avgRetries: number;
  /** Target tool path sequence (in order) */
  expectedToolPath: Array<{ stageId: string; toolName: string }>;
  /** Baseline semantic validation should pass */
  semanticValidationRequired: boolean;
  /** Timestamp when baseline was recorded */
  recordedAtMs: number;
  /** Number of runs used to establish baseline */
  sampleSize: number;
}

/**
 * Single regression finding
 */
export interface RegressionFinding {
  /** Workflow that regressed */
  workflowId: WorkflowId;
  workflowName: string;
  /** Metric that showed regression */
  metricName: string;
  /** Severity of regression */
  severity: RegressionSeverity;
  /** Baseline value */
  baselineValue: number;
  /** Current value */
  currentValue: number;
  /** Absolute delta (current - baseline) */
  delta: number;
  /** Percentage change ((current - baseline) / baseline * 100) */
  percentChange: number;
  /** Actionable recommendation */
  recommendation: string;
  /** Optional detailed explanation */
  details?: string;
}

/**
 * Complete regression report for a test run
 */
export interface RegressionReport {
  /** Timestamp when report was generated */
  generatedAtMs: number;
  /** All findings, sorted by severity */
  findings: RegressionFinding[];
  /** Overall autonomy health score (0-100) */
  healthScore: number;
  /** True if all workflows passed without regression */
  passed: boolean;
  /** Summary message */
  summary: string;
  /** Detailed metrics for all runs (for debugging) */
  allMetrics: WorkflowRunMetrics[];
}

/**
 * Configuration for regression analysis
 */
export interface RegressionHarnessConfig {
  /** Latency degradation threshold before WARNING (%) */
  latencyDegradationThresholdPct: number;
  /** Latency degradation threshold before CRITICAL (%) */
  latencyDegradationCriticalPct: number;
  /** Tool invocation count must match baseline exactly */
  strictToolPathMatching: boolean;
  /** Allow retry count variance (%) */
  retryVarianceThresholdPct: number;
  /** Semantic validation failures are CRITICAL */
  semanticValidationRequired: boolean;
  /** Expected tool path ordering must match baseline */
  toolPathContinuityRequired: boolean;
}

/**
 * Creates default configuration for regression analysis
 */
export function createDefaultHarnessConfig(): RegressionHarnessConfig {
  return {
    latencyDegradationThresholdPct: 10,
    latencyDegradationCriticalPct: 25,
    strictToolPathMatching: true,
    retryVarianceThresholdPct: 50,
    semanticValidationRequired: true,
    toolPathContinuityRequired: true,
  };
}

/**
 * Analyzes a workflow run against its baseline
 *
 * @param run Current workflow run metrics
 * @param baseline Expected baseline metrics
 * @param config Regression analysis configuration
 * @returns Array of findings, or empty array if no regressions
 */
export function analyzeWorkflowRegression(
  run: WorkflowRunMetrics,
  baseline: WorkflowBaseline,
  config: RegressionHarnessConfig
): RegressionFinding[] {
  const findings: RegressionFinding[] = [];

  // Check latency regression
  const latencyDelta = run.totalLatencyMs - baseline.avgTotalLatencyMs;
  const latencyPctChange =
    (latencyDelta / baseline.avgTotalLatencyMs) * 100;

  if (latencyPctChange > config.latencyDegradationCriticalPct) {
    findings.push({
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      metricName: "totalLatencyMs",
      severity: RegressionSeverity.CRITICAL,
      baselineValue: baseline.avgTotalLatencyMs,
      currentValue: run.totalLatencyMs,
      delta: latencyDelta,
      percentChange: latencyPctChange,
      recommendation: `Investigate ${run.workflowName} for performance bottleneck. Latency increased by ${latencyPctChange.toFixed(1)}%. Check for blocking I/O, network calls, or excessive retries.`,
    });
  } else if (latencyPctChange > config.latencyDegradationThresholdPct) {
    findings.push({
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      metricName: "totalLatencyMs",
      severity: RegressionSeverity.WARNING,
      baselineValue: baseline.avgTotalLatencyMs,
      currentValue: run.totalLatencyMs,
      delta: latencyDelta,
      percentChange: latencyPctChange,
      recommendation: `${run.workflowName} latency increased by ${latencyPctChange.toFixed(1)}%. Monitor for further degradation.`,
    });
  }

  // Check tool invocation count
  if (
    config.strictToolPathMatching &&
    run.toolInvocations !== baseline.avgToolInvocations
  ) {
    const toolDelta = run.toolInvocations - baseline.avgToolInvocations;
    findings.push({
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      metricName: "toolInvocations",
      severity: RegressionSeverity.WARNING,
      baselineValue: baseline.avgToolInvocations,
      currentValue: run.toolInvocations,
      delta: toolDelta,
      percentChange: (toolDelta / baseline.avgToolInvocations) * 100,
      recommendation: `Tool invocation count changed from ${baseline.avgToolInvocations} to ${run.toolInvocations}. Verify tool path continuity is preserved.`,
      details: `Expected path: ${baseline.expectedToolPath.map((p) => `${p.stageId}:${p.toolName}`).join(" -> ")}`,
    });
  }

  // Check tool path continuity
  if (config.toolPathContinuityRequired && run.toolPath.length > 0) {
    const expectedSequence = baseline.expectedToolPath;
    let pathValid = true;

    if (run.toolPath.length >= expectedSequence.length) {
      for (let i = 0; i < expectedSequence.length; i++) {
        const expected = expectedSequence[i];
        const actual = run.toolPath[i];

        if (
          actual.stageId !== expected.stageId ||
          actual.toolName !== expected.toolName
        ) {
          pathValid = false;
          break;
        }
      }
    } else {
      pathValid = false;
    }

    if (!pathValid) {
      findings.push({
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        metricName: "toolPathContinuity",
        severity: RegressionSeverity.CRITICAL,
        baselineValue: expectedSequence.length,
        currentValue: run.toolPath.length,
        delta: run.toolPath.length - expectedSequence.length,
        percentChange: 0,
        recommendation: `Tool path order changed in ${run.workflowName}. This indicates a fundamental workflow regression. Verify gating decisions and tool dispatch order.`,
        details: `Expected: ${expectedSequence.map((p) => `${p.stageId}:${p.toolName}`).join(" -> ")}\nActual: ${run.toolPath.map((p) => `${p.stageId}:${p.toolName}`).join(" -> ")}`,
      });
    }
  }

  // Check abstain counts (should be 0 in baseline with all PROCEED)
  const totalAbstains = run.abstainClarifyCount + run.abstainConfirmCount;
  if (totalAbstains > 0) {
    findings.push({
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      metricName: "abstainCount",
      severity: RegressionSeverity.WARNING,
      baselineValue: 0,
      currentValue: totalAbstains,
      delta: totalAbstains,
      percentChange: 0,
      recommendation: `${run.workflowName} had ${totalAbstains} ABSTAIN outcomes. In baseline (all PROCEED), expected 0. Verify contract policies and router decisions.`,
      details: `ABSTAIN_CLARIFY: ${run.abstainClarifyCount}, ABSTAIN_CONFIRM: ${run.abstainConfirmCount}`,
    });
  }

  // Check retry regression
  const retryDelta = run.retries - baseline.avgRetries;
  const retryPctChange =
    baseline.avgRetries === 0
      ? retryDelta > 0
        ? 100
        : 0
      : (retryDelta / baseline.avgRetries) * 100;

  if (
    retryDelta > 0 &&
    Math.abs(retryPctChange) > config.retryVarianceThresholdPct
  ) {
    findings.push({
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      metricName: "retries",
      severity: RegressionSeverity.WARNING,
      baselineValue: baseline.avgRetries,
      currentValue: run.retries,
      delta: retryDelta,
      percentChange: retryPctChange,
      recommendation: `Retry count increased from ${baseline.avgRetries} to ${run.retries}. Investigate retry conditions and circuit breaker logic.`,
    });
  }

  // Check semantic validation
  if (
    config.semanticValidationRequired &&
    baseline.semanticValidationRequired &&
    !run.semanticValidation.passed
  ) {
    findings.push({
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      metricName: "semanticValidation",
      severity: RegressionSeverity.CRITICAL,
      baselineValue: 1,
      currentValue: 0,
      delta: -1,
      percentChange: -100,
      recommendation: `Semantic validation failed for ${run.workflowName}. Output quality has degraded. Verify transform logic and data integrity.`,
      details: run.semanticValidation.details,
    });
  }

  return findings;
}

/**
 * Calculates overall autonomy health score (0-100)
 * Score degrades based on finding severity and count
 */
export function calculateHealthScore(findings: RegressionFinding[]): number {
  let score = 100;

  for (const finding of findings) {
    switch (finding.severity) {
      case RegressionSeverity.CRITICAL:
        score -= 25;
        break;
      case RegressionSeverity.WARNING:
        score -= 10;
        break;
      case RegressionSeverity.INFO:
        score -= 2;
        break;
    }
  }

  return Math.max(0, score);
}

/**
 * Generates a regression report from all findings
 */
export function generateRegressionReport(
  findings: RegressionFinding[],
  allMetrics: WorkflowRunMetrics[]
): RegressionReport {
  const sortedFindings = [...findings].sort((a, b) => {
    const severityOrder = {
      [RegressionSeverity.CRITICAL]: 0,
      [RegressionSeverity.WARNING]: 1,
      [RegressionSeverity.INFO]: 2,
    };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });

  const healthScore = calculateHealthScore(sortedFindings);
  const passed = sortedFindings.length === 0 && healthScore === 100;

  const summary =
    passed
      ? "✓ All workflows passed regression testing. Autonomy behavior is healthy."
      : `✗ Autonomy regression detected. Health score: ${healthScore}/100. Found ${sortedFindings.length} regression(s).`;

  return {
    generatedAtMs: Date.now(),
    findings: sortedFindings,
    healthScore,
    passed,
    summary,
    allMetrics,
  };
}

/**
 * Formats regression report for human-readable output
 */
export function formatRegressionReport(report: RegressionReport): string {
  let output = "";

  output += "═══════════════════════════════════════════════════════════════\n";
  output += "ClarityBurst Autonomy Regression Validation Report\n";
  output += "═══════════════════════════════════════════════════════════════\n\n";

  output += `Summary: ${report.summary}\n`;
  output += `Health Score: ${report.healthScore}/100\n`;
  output += `Generated: ${new Date(report.generatedAtMs).toISOString()}\n\n`;

  if (report.findings.length === 0) {
    output += "✓ No regressions detected.\n";
  } else {
    output += "REGRESSIONS DETECTED:\n";
    output += "───────────────────────────────────────────────────────────────\n\n";

    const critical = report.findings.filter(
      (f) => f.severity === RegressionSeverity.CRITICAL
    );
    const warnings = report.findings.filter(
      (f) => f.severity === RegressionSeverity.WARNING
    );
    const info = report.findings.filter(
      (f) => f.severity === RegressionSeverity.INFO
    );

    if (critical.length > 0) {
      output += `[CRITICAL] ${critical.length} critical issue(s):\n`;
      for (const finding of critical) {
        output += `  • ${finding.workflowName} / ${finding.metricName}\n`;
        output += `    Baseline: ${finding.baselineValue}, Current: ${finding.currentValue} (Δ ${finding.delta}, ${finding.percentChange.toFixed(1)}%)\n`;
        output += `    → ${finding.recommendation}\n`;
        if (finding.details) {
          output += `    Details: ${finding.details}\n`;
        }
        output += "\n";
      }
    }

    if (warnings.length > 0) {
      output += `[WARNING] ${warnings.length} warning(s):\n`;
      for (const finding of warnings) {
        output += `  • ${finding.workflowName} / ${finding.metricName}\n`;
        output += `    Baseline: ${finding.baselineValue}, Current: ${finding.currentValue} (Δ ${finding.delta}, ${finding.percentChange.toFixed(1)}%)\n`;
        output += `    → ${finding.recommendation}\n`;
        if (finding.details) {
          output += `    Details: ${finding.details}\n`;
        }
        output += "\n";
      }
    }

    if (info.length > 0) {
      output += `[INFO] ${info.length} informational note(s):\n`;
      for (const finding of info) {
        output += `  • ${finding.workflowName} / ${finding.metricName}\n`;
        output += `    ${finding.recommendation}\n`;
      }
      output += "\n";
    }
  }

  output += "───────────────────────────────────────────────────────────────\n";
  output += `Workflows tested: ${new Set(report.allMetrics.map((m) => m.workflowId)).size}\n`;
  output += `Total runs: ${report.allMetrics.length}\n`;
  output +=
    `Passed: ${report.allMetrics.filter((m) => m.completed).length} / ${report.allMetrics.length}\n`;

  output += "\n";

  return output;
}

/**
 * Creates a new workflow run with metrics tracking
 */
export function createWorkflowRun(
  workflowId: WorkflowId,
  workflowName: string
): WorkflowRunMetrics {
  return {
    runId: randomUUID(),
    workflowId,
    workflowName,
    startedAtMs: Date.now(),
    completed: false,
    totalLatencyMs: 0,
    toolInvocations: 0,
    proceedCount: 0,
    abstainClarifyCount: 0,
    abstainConfirmCount: 0,
    modifyCount: 0,
    retries: 0,
    toolPath: [],
    semanticValidation: {
      passed: false,
      details: "Not validated",
    },
    metrics: [],
  };
}

/**
 * Records a tool invocation in the workflow's tool path
 */
export function recordToolInvocation(
  run: WorkflowRunMetrics,
  point: ToolPathPoint
): void {
  run.toolInvocations++;
  run.toolPath.push(point);

  switch (point.outcome) {
    case "PROCEED":
      run.proceedCount++;
      break;
    case "ABSTAIN_CLARIFY":
      run.abstainClarifyCount++;
      break;
    case "ABSTAIN_CONFIRM":
      run.abstainConfirmCount++;
      break;
    case "MODIFY":
      run.modifyCount++;
      break;
  }
}

/**
 * Records a single metric reading during workflow execution
 */
export function recordMetric(
  run: WorkflowRunMetrics,
  metric: Omit<WorkflowMetric, "recordedAtMs">
): void {
  run.metrics.push({
    ...metric,
    recordedAtMs: Date.now(),
  });
}

/**
 * Finalizes a workflow run and calculates total latency
 */
export function finalizeWorkflowRun(
  run: WorkflowRunMetrics,
  semanticValidation: { passed: boolean; details: string }
): void {
  run.endedAtMs = Date.now();
  run.completed = true;
  run.totalLatencyMs = (run.endedAtMs || Date.now()) - run.startedAtMs;
  run.semanticValidation = semanticValidation;
}
