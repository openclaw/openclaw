/**
 * Powernap analytics: tracks every powernap event for trend analysis.
 *
 * Events are appended to ~/.openclaw/state/powernap/history.jsonl.
 * /powernap stats reads and summarizes the history.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { logVerbose } from "../../globals.js";

export type PowernapEvent = {
  ts: number;
  intent: string;
  sessionsReset: number;
  subagentsInterrupted: number;
  durationMs: number;
  trigger: "manual" | "auto";
  mode?: string;
  drainedMessages?: number;
};

export function recordPowernapEvent(event: PowernapEvent): void {
  try {
    const stateDir = resolveStateDir();
    const analyticsDir = path.join(stateDir, "powernap");
    mkdirSync(analyticsDir, { recursive: true });
    const historyPath = path.join(analyticsDir, "history.jsonl");
    appendFileSync(historyPath, `${JSON.stringify(event)}\n`, "utf-8");
  } catch (err) {
    logVerbose(`powernap analytics: failed to record event: ${String(err)}`);
  }
}

export function getPowernapStats(days: number = 7): string {
  try {
    const stateDir = resolveStateDir();
    const historyPath = path.join(stateDir, "powernap", "history.jsonl");
    const content = readFileSync(historyPath, "utf-8");
    const events: PowernapEvent[] = [];
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as PowernapEvent;
        if (event.ts >= cutoff) {
          events.push(event);
        }
      } catch {
        // skip malformed
      }
    }

    if (events.length === 0) {
      return `No powernaps in the last ${days} days.`;
    }

    const totalSessions = events.reduce((sum, e) => sum + e.sessionsReset, 0);
    const avgDuration = Math.round(
      events.reduce((sum, e) => sum + e.durationMs, 0) / events.length,
    );
    const intentCounts: Record<string, number> = {};
    for (const e of events) {
      intentCounts[e.intent] = (intentCounts[e.intent] ?? 0) + 1;
    }
    const topIntent = Object.entries(intentCounts).toSorted((a, b) => b[1] - a[1])[0];

    const modeCounts: Record<string, number> = {};
    for (const e of events) {
      const mode = e.mode ?? "all";
      modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;
    }

    const lines: string[] = [];
    lines.push(`Powernap stats (last ${days} days):`);
    lines.push(`  Total: ${events.length} powernap${events.length === 1 ? "" : "s"}`);
    lines.push(`  Sessions reset: ${totalSessions}`);
    lines.push(`  Avg duration: ${avgDuration}ms`);
    if (topIntent) {
      lines.push(`  Top intent: ${topIntent[0]} (${topIntent[1]}/${events.length})`);
    }
    const modeBreakdown = Object.entries(modeCounts)
      .map(([m, c]) => `${m}:${c}`)
      .join(", ");
    lines.push(`  Modes: ${modeBreakdown}`);

    // Trend: compare first half to second half
    const midpoint = events[Math.floor(events.length / 2)]?.ts ?? 0;
    const firstHalf = events.filter((e) => e.ts < midpoint).length;
    const secondHalf = events.filter((e) => e.ts >= midpoint).length;
    if (events.length >= 4) {
      const trend =
        secondHalf > firstHalf ? "increasing" : secondHalf < firstHalf ? "decreasing" : "stable";
      lines.push(`  Trend: ${trend}`);
    }

    return lines.join("\n");
  } catch {
    return "No powernap history found.";
  }
}
