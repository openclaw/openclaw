import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR } from "../../agents/pi-settings.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;

export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  "Store durable memories now (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

export const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture durable memories to disk.",
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

export const DEFAULT_BEFORE_CLEAR_PROMPT = [
  "Session context is about to be cleared.",
  "Store ALL important session context to durable memory NOW.",
  "This is your last chance to preserve: decisions, facts, action items, preferences, and conversation context.",
].join(" ");

export const DEFAULT_BEFORE_CLEAR_SYSTEM_PROMPT = [
  "URGENT: Session is being destroyed.",
  "Capture all durable memories before context is lost.",
  "This is a silent maintenance turn.",
].join(" ");

export const DEFAULT_MIN_TOKENS_FOR_FLUSH = 1000;

export type MemoryFlushCheckpoint = {
  percent: number;
  prompt?: string;
  systemPrompt?: string;
};

export type MemoryFlushSettings = {
  enabled: boolean;
  softThresholdTokens: number;
  prompt: string;
  systemPrompt: string;
  reserveTokensFloor: number;
  checkpoints?: MemoryFlushCheckpoint[];
  beforeClear: boolean;
  minTokensForFlush: number;
  beforeClearPrompt: string;
  beforeClearSystemPrompt: string;
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

  // Parse and sort checkpoints by percent ascending
  const rawCheckpoints: unknown = defaults?.checkpoints;
  let checkpoints: MemoryFlushCheckpoint[] | undefined;
  if (Array.isArray(rawCheckpoints) && rawCheckpoints.length > 0) {
    checkpoints = rawCheckpoints
      .filter(
        (cp: unknown): cp is { percent: number; prompt?: unknown; systemPrompt?: unknown } => {
          if (!cp || typeof cp !== "object") {
            return false;
          }
          return typeof (cp as { percent?: unknown }).percent === "number";
        },
      )
      .map((cp) => ({
        percent: cp.percent,
        prompt: typeof cp.prompt === "string" ? cp.prompt.trim() : undefined,
        systemPrompt: typeof cp.systemPrompt === "string" ? cp.systemPrompt.trim() : undefined,
      }))
      .toSorted((a, b) => a.percent - b.percent);

    if (checkpoints.length === 0) {
      checkpoints = undefined;
    }
  }

  const beforeClear = defaults?.beforeClear ?? true;
  const minTokensForFlush =
    normalizeNonNegativeInt(defaults?.minTokensForFlush) ?? DEFAULT_MIN_TOKENS_FOR_FLUSH;
  const beforeClearPrompt = defaults?.beforeClearPrompt?.trim() || DEFAULT_BEFORE_CLEAR_PROMPT;
  const beforeClearSystemPrompt =
    defaults?.beforeClearSystemPrompt?.trim() || DEFAULT_BEFORE_CLEAR_SYSTEM_PROMPT;

  return {
    enabled,
    softThresholdTokens,
    prompt: ensureNoReplyHint(prompt),
    systemPrompt: ensureNoReplyHint(systemPrompt),
    reserveTokensFloor,
    checkpoints,
    beforeClear,
    minTokensForFlush,
    beforeClearPrompt: ensureNoReplyHint(beforeClearPrompt),
    beforeClearSystemPrompt: ensureNoReplyHint(beforeClearSystemPrompt),
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
  entry?: Pick<SessionEntry, "totalTokens" | "compactionCount" | "memoryFlushCompactionCount">;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
}): boolean {
  const totalTokens = params.entry?.totalTokens;
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

export const DEFAULT_CHECKPOINT_PROMPT_TEMPLATE = [
  "Context window is at approximately {percent}% capacity.",
  "Store important session context to durable memory now.",
  "Focus on: decisions made, key facts discussed, action items,",
  "and any context that would be lost if the session were compacted.",
].join(" ");

export function shouldRunMemoryFlushCheckpoint(params: {
  entry?: Pick<SessionEntry, "totalTokens" | "compactionCount" | "memoryFlushCheckpointsFired">;
  contextWindowTokens: number;
  checkpoints?: MemoryFlushCheckpoint[];
}): { shouldRun: boolean; checkpoint?: MemoryFlushCheckpoint; percent?: number } {
  const totalTokens = params.entry?.totalTokens;
  if (!totalTokens || totalTokens <= 0 || !params.checkpoints || params.checkpoints.length === 0) {
    return { shouldRun: false };
  }

  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const currentPercent = (totalTokens / contextWindow) * 100;

  const firedCheckpoints = params.entry?.memoryFlushCheckpointsFired ?? [];

  // Find the highest checkpoint percent that currentPercent exceeds
  let applicableCheckpoint: MemoryFlushCheckpoint | undefined;
  for (let i = params.checkpoints.length - 1; i >= 0; i--) {
    const checkpoint = params.checkpoints[i];
    if (currentPercent >= checkpoint.percent && !firedCheckpoints.includes(checkpoint.percent)) {
      applicableCheckpoint = checkpoint;
      break;
    }
  }

  if (!applicableCheckpoint) {
    return { shouldRun: false };
  }

  return {
    shouldRun: true,
    checkpoint: applicableCheckpoint,
    percent: Math.round(currentPercent * 10) / 10, // Round to 1 decimal place
  };
}

export function shouldRunBeforeClearFlush(params: {
  entry?: Pick<SessionEntry, "totalTokens">;
  minTokensForFlush: number;
}): boolean {
  const totalTokens = params.entry?.totalTokens;
  if (!totalTokens || totalTokens <= 0) {
    return false;
  }
  const minTokens = Math.max(0, Math.floor(params.minTokensForFlush));
  return totalTokens >= minTokens;
}
