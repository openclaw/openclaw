import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";

export const DEFAULT_MEMORY_DREAMING_CRON_EXPR = "0 3 * * *";
export const DEFAULT_MEMORY_DREAMING_LIMIT = 10;
export const DEFAULT_MEMORY_DREAMING_MIN_SCORE = 0.75;
export const DEFAULT_MEMORY_DREAMING_MIN_RECALL_COUNT = 3;
export const DEFAULT_MEMORY_DREAMING_MIN_UNIQUE_QUERIES = 2;
export const DEFAULT_MEMORY_DREAMING_RECENCY_HALF_LIFE_DAYS = 14;
export const DEFAULT_MEMORY_DREAMING_MODE = "off";
export const DEFAULT_MEMORY_DREAMING_PRESET = "core";

export type MemoryDreamingPreset = "core" | "deep" | "rem";
export type MemoryDreamingMode = MemoryDreamingPreset | "off";

export type MemoryDreamingConfig = {
  mode: MemoryDreamingMode;
  enabled: boolean;
  cron: string;
  timezone?: string;
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays: number;
  maxAgeDays?: number;
  verboseLogging: boolean;
};

export type MemoryDreamingWorkspace = {
  workspaceDir: string;
  agentIds: string[];
};

export const MEMORY_DREAMING_PRESET_DEFAULTS: Record<
  MemoryDreamingPreset,
  {
    cron: string;
    limit: number;
    minScore: number;
    minRecallCount: number;
    minUniqueQueries: number;
    recencyHalfLifeDays: number;
  }
> = {
  core: {
    cron: DEFAULT_MEMORY_DREAMING_CRON_EXPR,
    limit: DEFAULT_MEMORY_DREAMING_LIMIT,
    minScore: DEFAULT_MEMORY_DREAMING_MIN_SCORE,
    minRecallCount: DEFAULT_MEMORY_DREAMING_MIN_RECALL_COUNT,
    minUniqueQueries: DEFAULT_MEMORY_DREAMING_MIN_UNIQUE_QUERIES,
    recencyHalfLifeDays: DEFAULT_MEMORY_DREAMING_RECENCY_HALF_LIFE_DAYS,
  },
  deep: {
    cron: "0 */12 * * *",
    limit: DEFAULT_MEMORY_DREAMING_LIMIT,
    minScore: 0.8,
    minRecallCount: 3,
    minUniqueQueries: 3,
    recencyHalfLifeDays: DEFAULT_MEMORY_DREAMING_RECENCY_HALF_LIFE_DAYS,
  },
  rem: {
    cron: "0 */6 * * *",
    limit: DEFAULT_MEMORY_DREAMING_LIMIT,
    minScore: 0.85,
    minRecallCount: 4,
    minUniqueQueries: 3,
    recencyHalfLifeDays: DEFAULT_MEMORY_DREAMING_RECENCY_HALF_LIFE_DAYS,
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === "string" && value.trim().length === 0) {
    return fallback;
  }
  const num = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const floored = Math.floor(num);
  if (floored < 0) {
    return fallback;
  }
  return floored;
}

function normalizeScore(value: unknown, fallback: number): number {
  if (typeof value === "string" && value.trim().length === 0) {
    return fallback;
  }
  const num = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 1) {
    return fallback;
  }
  return num;
}

function normalizeOptionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }
  const num = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(num)) {
    return undefined;
  }
  const floored = Math.floor(num);
  if (floored <= 0) {
    return undefined;
  }
  return floored;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return fallback;
}

function normalizePathForComparison(input: string): string {
  const normalized = path.resolve(input);
  if (process.platform === "win32") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function formatLocalIsoDay(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizeMemoryDreamingMode(value: unknown): MemoryDreamingMode {
  const normalized = normalizeTrimmedString(value)?.toLowerCase();
  if (
    normalized === "off" ||
    normalized === "core" ||
    normalized === "deep" ||
    normalized === "rem"
  ) {
    return normalized;
  }
  return DEFAULT_MEMORY_DREAMING_MODE;
}

export function resolveMemoryCorePluginConfig(
  cfg: OpenClawConfig | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const root = asRecord(cfg);
  const plugins = asRecord(root?.plugins);
  const entries = asRecord(plugins?.entries);
  const memoryCore = asRecord(entries?.["memory-core"]);
  return asRecord(memoryCore?.config) ?? undefined;
}

export function resolveMemoryDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): MemoryDreamingConfig {
  const dreaming = asRecord(params.pluginConfig?.dreaming);
  const mode = normalizeMemoryDreamingMode(dreaming?.mode);
  const enabled = mode !== "off";
  const preset: MemoryDreamingPreset = mode === "off" ? DEFAULT_MEMORY_DREAMING_PRESET : mode;
  const defaults = MEMORY_DREAMING_PRESET_DEFAULTS[preset];
  const timezone =
    normalizeTrimmedString(dreaming?.timezone) ??
    normalizeTrimmedString(params.cfg?.agents?.defaults?.userTimezone);
  const maxAgeDays = normalizeOptionalPositiveInt(dreaming?.maxAgeDays);
  return {
    mode,
    enabled,
    cron:
      normalizeTrimmedString(dreaming?.cron) ??
      normalizeTrimmedString(dreaming?.frequency) ??
      defaults.cron,
    ...(timezone ? { timezone } : {}),
    limit: normalizeNonNegativeInt(dreaming?.limit, defaults.limit),
    minScore: normalizeScore(dreaming?.minScore, defaults.minScore),
    minRecallCount: normalizeNonNegativeInt(dreaming?.minRecallCount, defaults.minRecallCount),
    minUniqueQueries: normalizeNonNegativeInt(
      dreaming?.minUniqueQueries,
      defaults.minUniqueQueries,
    ),
    recencyHalfLifeDays: normalizeNonNegativeInt(
      dreaming?.recencyHalfLifeDays,
      defaults.recencyHalfLifeDays,
    ),
    ...(typeof maxAgeDays === "number" ? { maxAgeDays } : {}),
    verboseLogging: normalizeBoolean(dreaming?.verboseLogging, false),
  };
}

export function formatMemoryDreamingDay(epochMs: number, timezone?: string): string {
  if (!timezone) {
    return formatLocalIsoDay(epochMs);
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(epochMs));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // Fall back to host-local day for invalid or unsupported timezones.
  }
  return formatLocalIsoDay(epochMs);
}

export function isSameMemoryDreamingDay(
  firstEpochMs: number,
  secondEpochMs: number,
  timezone?: string,
): boolean {
  return (
    formatMemoryDreamingDay(firstEpochMs, timezone) ===
    formatMemoryDreamingDay(secondEpochMs, timezone)
  );
}

export function resolveMemoryDreamingWorkspaces(cfg: OpenClawConfig): MemoryDreamingWorkspace[] {
  const configured = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const agentIds: string[] = [];
  const seenAgents = new Set<string>();
  for (const entry of configured) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    const id = entry.id.trim().toLowerCase();
    if (!id || seenAgents.has(id)) {
      continue;
    }
    seenAgents.add(id);
    agentIds.push(id);
  }
  if (agentIds.length === 0) {
    agentIds.push(resolveDefaultAgentId(cfg));
  }

  const byWorkspace = new Map<string, MemoryDreamingWorkspace>();
  for (const agentId of agentIds) {
    if (!resolveMemorySearchConfig(cfg, agentId)) {
      continue;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId)?.trim();
    if (!workspaceDir) {
      continue;
    }
    const key = normalizePathForComparison(workspaceDir);
    const existing = byWorkspace.get(key);
    if (existing) {
      existing.agentIds.push(agentId);
      continue;
    }
    byWorkspace.set(key, {
      workspaceDir,
      agentIds: [agentId],
    });
  }
  return [...byWorkspace.values()];
}
