/**
 * IBEL Phase 1 — Tool risk metadata registry.
 *
 * Maps tool names to risk classifications and human-readable summary templates.
 * Ships with defaults for known OpenClaw tools; plugins can register additional
 * metadata at boot time.
 */

import type { OpenClawToolMetadata, RiskLevel } from "./types.js";

// ── Default Risk Classifications ─────────────────────────────────────────────

const DEFAULT_RISK_MAP: Record<string, RiskLevel> = {
  // Critical — remote code execution, control-plane actions
  exec: "critical",
  gateway: "critical",
  sessions_spawn: "critical",
  whatsapp_login: "critical",
  // High — file mutation, persistent automation, cross-session messaging
  fs_write: "high",
  fs_delete: "high",
  fs_move: "high",
  apply_patch: "high",
  write: "high",
  edit: "high",
  cron: "high",
  sessions_send: "high",
  // Medium — network access with side effects
  browser_navigate: "medium",
  web_fetch: "medium",
  // Low — read-only
  fs_read: "low",
  read: "low",
  list: "low",
  memory_search: "low",
};

// ── Default Human-Readable Summary Templates ─────────────────────────────────

type SummaryFn = (args: unknown) => string;

function arg(args: unknown, key: string): unknown {
  if (args && typeof args === "object") {
    return (args as Record<string, unknown>)[key];
  }
  return undefined;
}

function argKeys(args: unknown): string[] {
  if (args && typeof args === "object") {
    return Object.keys(args as Record<string, unknown>);
  }
  return [];
}

const DEFAULT_SUMMARIES: Record<string, SummaryFn> = {
  exec: (args) => `Execute command: ${String(arg(args, "command") ?? "unknown")}`,
  gateway: (args) => `Gateway operation: ${String(arg(args, "action") ?? "unknown")}`,
  sessions_spawn: (args) => `Spawn session: ${String(arg(args, "agentId") ?? "unknown")}`,
  whatsapp_login: () => "WhatsApp login operation",
  fs_write: (args) => `Write file: ${String(arg(args, "path") ?? arg(args, "file") ?? "unknown")}`,
  fs_delete: (args) => `Delete: ${String(arg(args, "path") ?? arg(args, "file") ?? "unknown")}`,
  fs_move: (args) =>
    `Move ${String(arg(args, "source") ?? "unknown")} → ${String(arg(args, "destination") ?? "unknown")}`,
  apply_patch: (args) =>
    `Apply patch to: ${String(arg(args, "path") ?? arg(args, "file") ?? "unknown")}`,
  write: (args) =>
    `Write file: ${String(arg(args, "file_path") ?? arg(args, "path") ?? "unknown")}`,
  edit: (args) => `Edit file: ${String(arg(args, "file_path") ?? arg(args, "path") ?? "unknown")}`,
  cron: (args) => `Cron operation: ${String(arg(args, "action") ?? "unknown")}`,
  sessions_send: (args) => `Send to session: ${String(arg(args, "sessionId") ?? "unknown")}`,
  browser_navigate: (args) => `Navigate to: ${String(arg(args, "url") ?? "unknown")}`,
  web_fetch: (args) => `Fetch URL: ${String(arg(args, "url") ?? "unknown")}`,
};

function defaultSummary(name: string): SummaryFn {
  return (args) => `${name}(${argKeys(args).join(", ")})`;
}

// ── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<string, OpenClawToolMetadata>();

/**
 * Register or update risk metadata for a tool.
 */
export function registerToolMetadata(meta: OpenClawToolMetadata): void {
  registry.set(meta.name, meta);
}

/**
 * Get full metadata for a tool. Falls back to defaults for known tools.
 */
export function getToolMetadata(toolName: string): OpenClawToolMetadata | undefined {
  const explicit = registry.get(toolName);
  if (explicit) {
    return explicit;
  }

  const riskLevel = DEFAULT_RISK_MAP[toolName];
  if (riskLevel) {
    return {
      name: toolName,
      description: toolName,
      riskLevel,
      humanReadableSummary: DEFAULT_SUMMARIES[toolName] ?? defaultSummary(toolName),
    };
  }

  return undefined;
}

/**
 * Get the risk level for a tool. Returns undefined for unknown tools.
 */
export function getToolRiskLevel(toolName: string): RiskLevel | undefined {
  const meta = registry.get(toolName);
  if (meta) {
    return meta.riskLevel;
  }
  return DEFAULT_RISK_MAP[toolName];
}

/**
 * Reset the registry to defaults only. Primarily for testing.
 */
export function resetToolRiskRegistry(): void {
  registry.clear();
}
