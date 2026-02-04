import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR } from "../../agents/pi-settings.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;

export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "** COMPACTION IMMINENT ** - Save your work NOW.",
  "",
  "Write to memory/YYYY-MM-DD.md (create memory/ if needed):",
  "1. ACTIVE TASKS: What are you currently working on? Status of each.",
  "2. RECENT REQUESTS: Last 2-3 things the user asked for.",
  "3. IN-PROGRESS WORK: Any batch operations, their progress (e.g., '5/17 complete').",
  "4. BLOCKERS: Anything stuck or waiting.",
  "5. PENDING COMMITMENTS: Promises made that need follow-up.",
  "",
  "This context will be LOST after compaction. The summary alone won't preserve task state.",
  `After writing, start with ${SILENT_REPLY_TOKEN}.`,
].join("\n");

export const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "[CRITICAL] PRE-COMPACTION MEMORY FLUSH",
  "",
  "Your context is about to be compacted. The summarizer will NOT preserve:",
  "- Active task state and progress",
  "- Batch operation status",
  "- What you were in the middle of doing",
  "",
  "You MUST write this to memory files NOW or it will be lost.",
  "This is not optional - active work that isn't saved will be forgotten.",
  `After saving, start with ${SILENT_REPLY_TOKEN}.`,
].join("\n");

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
