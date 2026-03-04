/**
 * Format utilities for OpenClaw UI.
 * Migrated from ui/src/ui/format.ts
 */

import type { GatewaySessionRow } from "./types";

/**
 * Format a timestamp as relative time (e.g., "5 minutes ago").
 */
export function formatRelativeTimestamp(ms: number): string {
  const now = Date.now();
  const diff = now - ms;

  if (diff < 0) {
    // Future time
    const absDiff = Math.abs(diff);
    if (absDiff < 60_000) {
      return "in a few seconds";
    }
    if (absDiff < 3600_000) {
      return `in ${Math.round(absDiff / 60_000)} minutes`;
    }
    if (absDiff < 86400_000) {
      return `in ${Math.round(absDiff / 3600_000)} hours`;
    }
    return `in ${Math.round(absDiff / 86400_000)} days`;
  }

  if (diff < 10_000) {
    return "just now";
  }
  if (diff < 60_000) {
    return `${Math.round(diff / 1000)} seconds ago`;
  }
  if (diff < 3600_000) {
    const mins = Math.round(diff / 60_000);
    return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  }
  if (diff < 86400_000) {
    const hrs = Math.round(diff / 3600_000);
    return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(diff / 86400_000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Format a duration in milliseconds to human-readable form.
 */
export function formatDurationHuman(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 3600_000) {
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return `${mins}m ${secs}s`;
  }
  const hrs = Math.floor(ms / 3600_000);
  const mins = Math.round((ms % 3600_000) / 60_000);
  return `${hrs}h ${mins}m`;
}

/**
 * Format timestamp to locale string.
 */
export function formatMs(ms?: number | null): string {
  if (!ms && ms !== 0) {
    return "n/a";
  }
  return new Date(ms).toLocaleString();
}

/**
 * Format an array of values as comma-separated list.
 */
export function formatList(values?: Array<string | null | undefined>): string {
  if (!values || values.length === 0) {
    return "none";
  }
  return values.filter((v): v is string => Boolean(v && v.trim())).join(", ");
}

/**
 * Clamp text to max length with ellipsis.
 */
export function clampText(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Truncate text and return info about truncation.
 */
export function truncateText(
  value: string,
  max: number,
): { text: string; truncated: boolean; total: number } {
  if (value.length <= max) {
    return { text: value, truncated: false, total: value.length };
  }
  return {
    text: value.slice(0, Math.max(0, max)),
    truncated: true,
    total: value.length,
  };
}

/**
 * Parse string to number with fallback.
 */
export function toNumber(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse comma/newline separated list.
 */
export function parseList(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Format session tokens display.
 */
export function formatSessionTokens(row: GatewaySessionRow): string {
  if (row.totalTokens == null) {
    return "n/a";
  }
  const total = row.totalTokens ?? 0;
  const ctx = row.contextTokens ?? 0;
  return ctx ? `${total} / ${ctx}` : String(total);
}

/**
 * Format next run time for cron jobs.
 */
export function formatNextRun(ms?: number | null): string {
  if (!ms) {
    return "n/a";
  }
  const weekday = new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
  });
  return `${weekday}, ${formatMs(ms)} (${formatRelativeTimestamp(ms)})`;
}
