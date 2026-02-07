/**
 * CLI commands for hierarchical memory management.
 */

import type { RuntimeEnv } from "../runtime.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import {
  getMemoryStats,
  hasSummaries,
  isHierarchicalMemoryEnabled,
  loadSummaryIndex,
  readSummary,
  resolveSummariesDir,
  type SummaryEntry,
  type SummaryLevel,
} from "../memory/hierarchical/index.js";
import { isRich, theme } from "../terminal/theme.js";

type MemoryStatusOptions = {
  json?: boolean;
  agentId?: string;
};

type MemoryInspectOptions = {
  json?: boolean;
  agentId?: string;
  level?: string;
  limit?: number;
};

/**
 * Format a timestamp as a relative age string.
 */
function formatAge(ms: number): string {
  if (ms < 0) {
    return "future";
  }
  if (ms < 60_000) {
    return `${Math.floor(ms / 1000)}s ago`;
  }
  if (ms < 3600_000) {
    return `${Math.floor(ms / 60_000)}m ago`;
  }
  if (ms < 86400_000) {
    return `${Math.floor(ms / 3600_000)}h ago`;
  }
  return `${Math.floor(ms / 86400_000)}d ago`;
}

/**
 * Show memory status for an agent.
 */
export async function memoryStatusCommand(
  opts: MemoryStatusOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = loadConfig();
  const agentId = opts.agentId ?? resolveDefaultAgentId(cfg);
  const rich = isRich();
  const log = runtime.log;

  // Check if hierarchical memory is enabled
  const enabled = isHierarchicalMemoryEnabled(cfg);
  const hasData = await hasSummaries(agentId);

  if (opts.json) {
    const stats = hasData ? await getMemoryStats(agentId) : null;
    log(
      JSON.stringify(
        {
          agentId,
          enabled,
          hasData,
          stats,
          summariesDir: resolveSummariesDir(agentId),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Header
  log(rich ? theme.heading("Hierarchical Memory Status") : "Hierarchical Memory Status");
  log("");

  // Config status
  const enabledLabel = enabled
    ? rich
      ? theme.success("enabled")
      : "enabled"
    : rich
      ? theme.muted("disabled")
      : "disabled";
  log(`  Agent:    ${rich ? theme.accent(agentId) : agentId}`);
  log(`  Enabled:  ${enabledLabel}`);
  log(
    `  Storage:  ${rich ? theme.muted(resolveSummariesDir(agentId)) : resolveSummariesDir(agentId)}`,
  );
  log("");

  if (!hasData) {
    log(rich ? theme.muted("  No memory data yet.") : "  No memory data yet.");
    if (!enabled) {
      log("");
      log(
        rich
          ? theme.muted("  Enable with: agents.defaults.hierarchicalMemory.enabled: true")
          : "  Enable with: agents.defaults.hierarchicalMemory.enabled: true",
      );
    }
    return;
  }

  // Get stats
  const stats = await getMemoryStats(agentId);
  if (!stats) {
    log(rich ? theme.muted("  No summaries found.") : "  No summaries found.");
    return;
  }

  // Summary counts
  log(rich ? theme.heading("  Summaries:") : "  Summaries:");
  const l1Label = `L1 (recent):     ${stats.levels.L1}`;
  const l2Label = `L2 (earlier):    ${stats.levels.L2}`;
  const l3Label = `L3 (long-term):  ${stats.levels.L3}`;
  log(`    ${rich ? theme.info(l1Label) : l1Label}`);
  log(`    ${rich ? theme.info(l2Label) : l2Label}`);
  log(`    ${rich ? theme.info(l3Label) : l3Label}`);
  log(`    ${"─".repeat(20)}`);
  log(`    Total:           ${stats.totalSummaries}`);
  log("");

  // Timing info
  log(rich ? theme.heading("  Timing:") : "  Timing:");
  if (stats.lastSummarizedAt) {
    const age = formatAge(Date.now() - stats.lastSummarizedAt);
    log(`    Last summarized: ${age}`);
  }
  if (stats.lastWorkerRun) {
    const age = formatAge(Date.now() - stats.lastWorkerRun);
    log(`    Last worker run: ${age}`);
  }
}

/**
 * Inspect memory summaries for an agent.
 */
export async function memoryInspectCommand(
  opts: MemoryInspectOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = loadConfig();
  const agentId = opts.agentId ?? resolveDefaultAgentId(cfg);
  const rich = isRich();
  const limit = opts.limit ?? 5;
  const log = runtime.log;

  // Validate level if provided
  const validLevels = ["L1", "L2", "L3"];
  if (opts.level && !validLevels.includes(opts.level.toUpperCase())) {
    runtime.error(`Invalid level: ${opts.level}. Must be one of: ${validLevels.join(", ")}`);
    runtime.exit(1);
    return;
  }
  const filterLevel = opts.level?.toUpperCase() as SummaryLevel | undefined;

  // Load index
  const hasData = await hasSummaries(agentId);
  if (!hasData) {
    if (opts.json) {
      log(JSON.stringify({ agentId, summaries: [] }, null, 2));
    } else {
      log(rich ? theme.muted("No memory data yet.") : "No memory data yet.");
    }
    return;
  }

  const index = await loadSummaryIndex(agentId);

  // Collect summaries to show
  const summariesToShow: Array<{ entry: SummaryEntry; content: string }> = [];

  const levels: SummaryLevel[] = filterLevel ? [filterLevel] : ["L3", "L2", "L1"];

  for (const level of levels) {
    const entries = index.levels[level]
      .filter((e) => !e.mergedInto) // Only show unmerged (active) summaries
      .toSorted((a, b) => b.createdAt - a.createdAt); // Node 22+ baseline; linter requires toSorted over sort

    for (const entry of entries.slice(0, limit)) {
      const result = await readSummary(level, entry.id, agentId);
      if (result) {
        summariesToShow.push({ entry, content: result.content });
      }
    }
  }

  if (opts.json) {
    log(
      JSON.stringify(
        {
          agentId,
          summaries: summariesToShow.map(({ entry, content }) => ({
            id: entry.id,
            level: entry.level,
            createdAt: entry.createdAt,
            tokenEstimate: entry.tokenEstimate,
            content,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Display summaries
  log(rich ? theme.heading("Memory Summaries") : "Memory Summaries");
  log(`Agent: ${rich ? theme.accent(agentId) : agentId}`);
  if (filterLevel) {
    log(`Level: ${filterLevel}`);
  }
  log("");

  if (summariesToShow.length === 0) {
    log(rich ? theme.muted("No active summaries found.") : "No active summaries found.");
    return;
  }

  for (const { entry, content } of summariesToShow) {
    const levelColor =
      entry.level === "L3" ? theme.success : entry.level === "L2" ? theme.warn : theme.info;
    const header = `[${entry.level}] ${entry.id} - ${formatAge(Date.now() - entry.createdAt)} (~${entry.tokenEstimate} tokens)`;
    log(rich ? levelColor(header) : header);
    log("─".repeat(60));
    log(content);
    log("");
  }
}
