import { lookupContextTokens } from "../../agents/context.js";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR } from "../../agents/pi-settings.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";
import type { AgentPeriodicFactExtractionConfig } from "../../config/types.agent-defaults.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;
export const DEFAULT_PERIODIC_EXTRACTION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  "Store durable memories now (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  "IMPORTANT: If the file already exists, APPEND new content only and do not overwrite existing entries.",
  `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

export const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture durable memories to disk.",
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

function formatDateStampInTimezone(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function resolveMemoryFlushPromptForRun(params: {
  prompt: string;
  cfg?: OpenClawConfig;
  nowMs?: number;
}): string {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const { userTimezone, timeLine } = resolveCronStyleNow(params.cfg ?? {}, nowMs);
  const dateStamp = formatDateStampInTimezone(nowMs, userTimezone);
  const withDate = params.prompt.replaceAll("YYYY-MM-DD", dateStamp).trimEnd();
  if (!withDate) {
    return timeLine;
  }
  if (withDate.includes("Current time:")) {
    return withDate;
  }
  return `${withDate}\n${timeLine}`;
}

export type MemoryFlushSettings = {
  enabled: boolean;
  softThresholdTokens: number;
  prompt: string;
  systemPrompt: string;
  reserveTokensFloor: number;
};

const normalizeNonNegativeInt = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
};

export function resolveMemoryFlushSettings(cfg?: OpenClawConfig): MemoryFlushSettings | null {
  const defaults = cfg?.agents?.defaults?.compaction?.memoryFlush;
  const enabled = defaults?.enabled ?? true;
  if (!enabled) {
    return null;
  }
  const softThresholdTokens =
    normalizeNonNegativeInt(defaults?.softThresholdTokens) ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS;
  const prompt = defaults?.prompt?.trim() || DEFAULT_MEMORY_FLUSH_PROMPT;
  const systemPrompt = defaults?.systemPrompt?.trim() || DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT;
  const reserveTokensFloor =
    normalizeNonNegativeInt(cfg?.agents?.defaults?.compaction?.reserveTokensFloor) ??
    DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;

  return {
    enabled,
    softThresholdTokens,
    prompt: ensureNoReplyHint(prompt),
    systemPrompt: ensureNoReplyHint(systemPrompt),
    reserveTokensFloor,
  };
}

function ensureNoReplyHint(text: string): string {
  if (text.includes(SILENT_REPLY_TOKEN)) {
    return text;
  }
  return `${text}\n\nIf no user-visible reply is needed, start with ${SILENT_REPLY_TOKEN}.`;
}

export function resolveMemoryFlushContextWindowTokens(params: {
  modelId?: string;
  agentCfgContextTokens?: number;
}): number {
  return (
    lookupContextTokens(params.modelId) ?? params.agentCfgContextTokens ?? DEFAULT_CONTEXT_TOKENS
  );
}

export function shouldRunMemoryFlush(params: {
  entry?: Pick<
    SessionEntry,
    "totalTokens" | "totalTokensFresh" | "compactionCount" | "memoryFlushCompactionCount"
  >;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
}): boolean {
  const totalTokens = resolveFreshSessionTotalTokens(params.entry);
  if (!totalTokens || totalTokens <= 0) {
    return false;
  }
  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
  const softThreshold = Math.max(0, Math.floor(params.softThresholdTokens));
  const threshold = Math.max(0, contextWindow - reserveTokens - softThreshold);
  if (threshold <= 0) {
    return false;
  }
  if (totalTokens < threshold) {
    return false;
  }

  const compactionCount = params.entry?.compactionCount ?? 0;
  const lastFlushAt = params.entry?.memoryFlushCompactionCount;
  if (typeof lastFlushAt === "number" && lastFlushAt === compactionCount) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Periodic fact extraction
// ---------------------------------------------------------------------------

export const DEFAULT_PERIODIC_EXTRACTION_PROMPT = [
  "Periodic fact extraction.",
  "Review the recent conversation and extract key facts worth remembering long-term.",
  "Focus on: user preferences, decisions made, project names, people mentioned, technical choices, action items, and important context.",
  "Save extracted facts to memory/YYYY-MM-DD.md under a '## Extracted Facts' section.",
  "IMPORTANT: If the file already exists, APPEND new content only and do not overwrite existing entries.",
  "Skip facts that are already recorded in the file.",
  `If no new facts to extract, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

export const DEFAULT_PERIODIC_EXTRACTION_SYSTEM_PROMPT = [
  "Periodic fact extraction turn.",
  "Analyze the conversation for durable facts, preferences, and decisions.",
  "Write structured facts to the workspace memory files.",
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

export type PeriodicExtractionSettings = {
  enabled: boolean;
  intervalMs: number;
  prompt: string;
  systemPrompt: string;
};

export function resolvePeriodicExtractionSettings(
  cfg?: OpenClawConfig,
): PeriodicExtractionSettings | null {
  const extractionCfg: AgentPeriodicFactExtractionConfig | undefined =
    cfg?.agents?.defaults?.compaction?.memoryFlush?.periodicExtraction;
  if (!extractionCfg?.enabled) {
    return null;
  }
  let intervalMs = DEFAULT_PERIODIC_EXTRACTION_INTERVAL_MS;
  if (extractionCfg.every) {
    try {
      const parsed = parseDurationMs(extractionCfg.every, { defaultUnit: "m" });
      if (parsed > 0) {
        intervalMs = parsed;
      }
    } catch {
      // Use default on parse failure
    }
  }
  return {
    enabled: true,
    intervalMs,
    prompt: ensureNoReplyHint(extractionCfg.prompt?.trim() || DEFAULT_PERIODIC_EXTRACTION_PROMPT),
    systemPrompt: ensureNoReplyHint(
      extractionCfg.systemPrompt?.trim() || DEFAULT_PERIODIC_EXTRACTION_SYSTEM_PROMPT,
    ),
  };
}

export function shouldRunPeriodicExtraction(params: {
  entry?: Pick<SessionEntry, "lastPeriodicExtractionAt"> & { totalTokens?: number };
  settings: PeriodicExtractionSettings;
  nowMs?: number;
}): boolean {
  const now = params.nowMs ?? Date.now();
  const lastRun = params.entry?.lastPeriodicExtractionAt;
  if (typeof lastRun !== "number") {
    // Never run before — only run if the session has accumulated enough context
    // to make extraction worthwhile (at least 1000 tokens of conversation).
    const tokens = params.entry?.totalTokens;
    return typeof tokens === "number" && tokens >= 1000;
  }
  return now - lastRun >= params.settings.intervalMs;
}
