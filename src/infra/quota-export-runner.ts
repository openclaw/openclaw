/**
 * Quota Export Runner
 *
 * Automatically exports provider quota info to ~/.openclaw/quota.json
 * after each agent run completes. This runs asynchronously (fire-and-forget)
 * so it doesn't impact response latency.
 */

import { exportQuotaToFile, appendQuotaToHistory } from "./provider-usage.export.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";

export type QuotaExportRunnerOptions = {
  agentDir?: string;
  appendHistory?: boolean;
  timeoutMs?: number;
};

/**
 * Runs quota export asynchronously after an agent run.
 * This is fire-and-forget - errors are logged but not thrown.
 *
 * @param opts Options for the quota export
 */
export async function runQuotaExport(opts: QuotaExportRunnerOptions = {}): Promise<void> {
  try {
    const summary = await loadProviderUsageSummary({
      timeoutMs: opts.timeoutMs ?? 3000,
      agentDir: opts.agentDir,
    });

    if (summary.providers.length === 0) {
      return; // No quota data to export
    }

    await exportQuotaToFile(summary);

    if (opts.appendHistory !== false) {
      await appendQuotaToHistory(summary);
    }
  } catch {
    // Silently ignore errors - quota export is non-critical
    // The file will be updated on the next successful run
  }
}
