import * as fs from "node:fs";
import * as path from "node:path";
import type { UsageSummary, UsageWindow } from "./provider-usage.types.js";

export type QuotaExportOptions = {
  /** Directory to write the quota file to. Defaults to ~/.openclaw */
  dir?: string;
  /** Filename for the quota JSON file. Defaults to quota.json */
  filename?: string;
};

export type ExportedQuota = {
  updatedAt: number;
  models: Record<string, { percent: number; resetIn?: string }>;
};

/**
 * Formats milliseconds remaining into a human-readable string like "2h 30m"
 */
function formatResetIn(resetAt: number, now: number): string | undefined {
  if (!resetAt) return undefined;
  const msLeft = resetAt - now;
  if (msLeft <= 0) return "now";

  const minutes = Math.floor(msLeft / 60000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

/**
 * Converts a UsageSummary to a simplified format for external consumption.
 */
export function toExportedQuota(summary: UsageSummary): ExportedQuota {
  const models: ExportedQuota["models"] = {};
  const now = summary.updatedAt;

  for (const provider of summary.providers) {
    for (const window of provider.windows) {
      // Use the label as the model name
      const modelName = window.label;
      const percent = Math.round(100 - window.usedPercent);
      const resetIn = window.resetAt ? formatResetIn(window.resetAt, now) : undefined;

      models[modelName] = { percent, resetIn };
    }
  }

  return {
    updatedAt: now,
    models,
  };
}

/**
 * Writes the usage summary to a JSON file for external monitoring.
 *
 * This enables external tools (dashboards, monitors) to read quota info
 * without needing to call the model.
 *
 * @param summary The usage summary from loadProviderUsageSummary
 * @param opts Export options (dir, filename)
 */
export async function exportQuotaToFile(
  summary: UsageSummary,
  opts: QuotaExportOptions = {},
): Promise<string> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const dir = opts.dir ?? path.join(homeDir, ".openclaw");
  const filename = opts.filename ?? "quota.json";
  const filePath = path.join(dir, filename);

  // Ensure directory exists
  await fs.promises.mkdir(dir, { recursive: true });

  const exported = toExportedQuota(summary);
  const content = JSON.stringify(exported, null, 2);

  await fs.promises.writeFile(filePath, content, "utf-8");

  return filePath;
}

/**
 * Appends a quota snapshot to a JSONL history file for time-series tracking.
 *
 * @param summary The usage summary
 * @param opts Export options (dir, uses quota-history.jsonl)
 */
export async function appendQuotaToHistory(
  summary: UsageSummary,
  opts: QuotaExportOptions = {},
): Promise<string> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const dir = opts.dir ?? path.join(homeDir, ".openclaw");
  const filePath = path.join(dir, "quota-history.jsonl");

  await fs.promises.mkdir(dir, { recursive: true });

  const exported = toExportedQuota(summary);
  const line = JSON.stringify({ ts: exported.updatedAt, models: exported.models });

  await fs.promises.appendFile(filePath, line + "\n", "utf-8");

  return filePath;
}
