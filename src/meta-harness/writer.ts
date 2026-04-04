/**
 * Flow trace writer — writes top-level flow traces to data/meta-harness/traces/
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FlowTrace, TraceId } from "./types.js";

/**
 * Generate a stable trace ID (UUID v4).
 */
export function generateTraceId(): TraceId {
  return crypto.randomUUID();
}

/**
 * Write a flow trace to the traces directory.
 * File name: `{trace_id}.json`
 */
export async function writeFlowTrace(workspaceDir: string, trace: FlowTrace): Promise<string> {
  const tracesDir = path.join(workspaceDir, "data/meta-harness/traces");
  const filePath = path.join(tracesDir, `${trace.trace_id}.json`);
  await fs.writeFile(filePath, JSON.stringify(trace, null, 2) + "\n", "utf-8");
  return filePath;
}

/**
 * Write a child trace to the children directory.
 * File name: `{child_trace_id}.json`
 */
export async function writeChildTrace(
  workspaceDir: string,
  childTrace: import("./types.js").ChildTrace,
): Promise<string> {
  const childrenDir = path.join(workspaceDir, "data/meta-harness/children");
  const filePath = path.join(childrenDir, `${childTrace.child_trace_id}.json`);
  await fs.writeFile(filePath, JSON.stringify(childTrace, null, 2) + "\n", "utf-8");
  return filePath;
}

/**
 * Write a rich trace to the rich directory (only on escalation).
 * File name: `rich-{trace_id}-{timestamp}.json`
 */
export async function writeRichTrace(
  workspaceDir: string,
  richTrace: import("./types.js").RichTrace,
): Promise<string> {
  const richDir = path.join(workspaceDir, "data/meta-harness/rich");
  const ts = richTrace.timestamp.replace(/[:.]/g, "-").slice(0, 19);
  const filePath = path.join(richDir, `rich-${richTrace.trace_id}-${ts}.json`);
  await fs.writeFile(filePath, JSON.stringify(richTrace, null, 2) + "\n", "utf-8");
  return filePath;
}

/**
 * Write a daily summary to the daily directory.
 * File name: `daily-{date}.json`
 */
export async function writeDailySummary(
  workspaceDir: string,
  summary: import("./types.js").DailySummary,
): Promise<string> {
  const dailyDir = path.join(workspaceDir, "data/meta-harness/daily");
  const filePath = path.join(dailyDir, `daily-${summary.date}.json`);
  await fs.writeFile(filePath, JSON.stringify(summary, null, 2) + "\n", "utf-8");
  return filePath;
}

/**
 * Write a weekly summary to the weekly directory.
 * File name: `weekly-{week_start}-{week_end}.json`
 */
export async function writeWeeklySummary(
  workspaceDir: string,
  summary: import("./types.js").WeeklySummary,
): Promise<string> {
  const weeklyDir = path.join(workspaceDir, "data/meta-harness/weekly");
  const filePath = path.join(weeklyDir, `weekly-${summary.week_start}-${summary.week_end}.json`);
  await fs.writeFile(filePath, JSON.stringify(summary, null, 2) + "\n", "utf-8");
  return filePath;
}

/**
 * List all trace files in a directory, returning parsed content.
 */
export async function listTraces<T>(
  workspaceDir: string,
  subDir: string,
): Promise<{ filePath: string; data: T }[]> {
  const dir = path.join(workspaceDir, "data/meta-harness", subDir);
  try {
    const files = await fs.readdir(dir);
    const results: { filePath: string; data: T }[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const filePath = path.join(dir, file);
        const raw = await fs.readFile(filePath, "utf-8");
        results.push({ filePath, data: JSON.parse(raw) as T });
      } catch {
        // skip unreadable files
      }
    }
    return results;
  } catch {
    return [];
  }
}
