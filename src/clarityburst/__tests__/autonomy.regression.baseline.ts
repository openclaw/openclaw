/**
 * ClarityBurst Autonomy Regression Baseline Management
 *
 * Handles persistence and comparison of autonomy regression baseline metrics.
 * Baselines are stored as JSON files keyed by workflow ID, allowing:
 * - First-run baseline creation
 * - Baseline comparison for regression detection
 * - Baseline updates when improvements are verified
 * - Baseline export for CI/CD reporting
 *
 * Storage format: ~/.openclaw/autonomy-regression-baselines/
 * File naming: {workflowId}.baseline.json
 *
 * NOTE: This module does NOT change runtime behavior. It only records
 * and compares metrics for regression detection.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { WorkflowRunMetrics, WorkflowBaseline } from "./autonomy.regression.harness.js";

const BASELINES_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "autonomy-regression-baselines"
);

/**
 * Ensures baselines directory exists
 */
function ensureBaselinesDir(): void {
  if (!fs.existsSync(BASELINES_DIR)) {
    fs.mkdirSync(BASELINES_DIR, { recursive: true });
  }
}

/**
 * Gets the path to a baseline file for a workflow
 */
function getBaselineFilePath(workflowId: string): string {
  return path.join(BASELINES_DIR, `${workflowId}.baseline.json`);
}

/**
 * Loads an existing baseline from disk, or returns null if not found
 *
 * @param workflowId Workflow ID
 * @returns Baseline if found, null otherwise
 */
export function loadBaseline(workflowId: string): WorkflowBaseline | null {
  const filePath = getBaselineFilePath(workflowId);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const baseline = JSON.parse(content) as WorkflowBaseline;
    return baseline;
  } catch (err) {
    console.error(`Failed to load baseline for ${workflowId}:`, err);
    return null;
  }
}

/**
 * Creates a new baseline from a single run
 *
 * Used for first-time baseline creation or explicit baseline reset.
 *
 * @param run Workflow run metrics
 * @returns Created baseline
 */
export function createBaselineFromRun(run: WorkflowRunMetrics): WorkflowBaseline {
  return {
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    avgTotalLatencyMs: run.totalLatencyMs,
    avgToolInvocations: run.toolInvocations,
    avgRetries: run.retries,
    expectedToolPath: run.toolPath.map((p) => ({
      stageId: p.stageId,
      toolName: p.toolName,
    })),
    semanticValidationRequired: run.semanticValidation.passed,
    recordedAtMs: Date.now(),
    sampleSize: 1,
  };
}

/**
 * Updates an existing baseline by averaging with a new run
 *
 * Useful for refining baselines as more runs are collected.
 * Maintains running average of latency, tool invocations, and retries.
 *
 * @param existing Current baseline
 * @param newRun New workflow run
 * @returns Updated baseline with new averages
 */
export function updateBaselineWithRun(
  existing: WorkflowBaseline,
  newRun: WorkflowRunMetrics
): WorkflowBaseline {
  const newSampleSize = existing.sampleSize + 1;

  return {
    ...existing,
    avgTotalLatencyMs:
      (existing.avgTotalLatencyMs * existing.sampleSize +
        newRun.totalLatencyMs) /
      newSampleSize,
    avgToolInvocations:
      (existing.avgToolInvocations * existing.sampleSize +
        newRun.toolInvocations) /
      newSampleSize,
    avgRetries:
      (existing.avgRetries * existing.sampleSize + newRun.retries) /
      newSampleSize,
    recordedAtMs: Date.now(),
    sampleSize: newSampleSize,
  };
}

/**
 * Saves a baseline to disk
 *
 * @param baseline Baseline to save
 */
export function saveBaseline(baseline: WorkflowBaseline): void {
  ensureBaselinesDir();

  const filePath = getBaselineFilePath(baseline.workflowId);
  const content = JSON.stringify(baseline, null, 2);

  fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * Gets or creates a baseline for a workflow
 *
 * If baseline exists on disk, loads it.
 * If not, creates one from the provided run and saves it.
 *
 * @param run Workflow run metrics
 * @returns Baseline (existing or newly created)
 */
export function getOrCreateBaseline(run: WorkflowRunMetrics): WorkflowBaseline {
  let baseline = loadBaseline(run.workflowId);

  if (!baseline) {
    baseline = createBaselineFromRun(run);
    saveBaseline(baseline);
  }

  return baseline;
}

/**
 * Lists all baselines currently stored
 *
 * @returns Array of baseline file paths
 */
export function listBaselines(): string[] {
  ensureBaselinesDir();

  if (!fs.existsSync(BASELINES_DIR)) {
    return [];
  }

  return fs
    .readdirSync(BASELINES_DIR)
    .filter((file) => file.endsWith(".baseline.json"))
    .map((file) => path.join(BASELINES_DIR, file));
}

/**
 * Deletes a baseline (for testing or reset)
 *
 * @param workflowId Workflow ID
 */
export function deleteBaseline(workflowId: string): void {
  const filePath = getBaselineFilePath(workflowId);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Resets all baselines (for testing)
 */
export function resetAllBaselines(): void {
  const baselines = listBaselines();

  for (const baseline of baselines) {
    fs.unlinkSync(baseline);
  }
}

/**
 * Exports all baselines as a single JSON object
 *
 * Useful for reporting, archiving, or comparison across runs.
 *
 * @returns Object keyed by workflow ID with baseline values
 */
export function exportAllBaselines(): Record<string, WorkflowBaseline> {
  ensureBaselinesDir();

  const result: Record<string, WorkflowBaseline> = {};
  const baselines = listBaselines();

  for (const filePath of baselines) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const baseline = JSON.parse(content) as WorkflowBaseline;
      result[baseline.workflowId] = baseline;
    } catch (err) {
      console.error(`Failed to export baseline ${filePath}:`, err);
    }
  }

  return result;
}

/**
 * Gets the timestamp of the last baseline update for a workflow
 *
 * @param workflowId Workflow ID
 * @returns Timestamp in ms, or null if baseline not found
 */
export function getLastBaselineUpdate(workflowId: string): number | null {
  const baseline = loadBaseline(workflowId);
  return baseline ? baseline.recordedAtMs : null;
}

/**
 * Gets baseline age in seconds
 *
 * @param workflowId Workflow ID
 * @returns Age in seconds, or null if baseline not found
 */
export function getBaselineAge(workflowId: string): number | null {
  const lastUpdate = getLastBaselineUpdate(workflowId);
  return lastUpdate ? Math.floor((Date.now() - lastUpdate) / 1000) : null;
}
