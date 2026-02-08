import type { OpenClawConfig } from "../../config/config.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import { getMemorySearchManager } from "../../memory/index.js";

export type MemoryRecallChatType = "direct" | "group" | "channel";

export type MemoryRecallSettings = {
  enabled: boolean;
  /**
   * - heuristic: only run when the message looks like it references prior context
   * - always: always run before the turn
   */
  mode: "heuristic" | "always";
  /** Require the sender to be an owner/authorized sender (recommended). */
  requireOwner: boolean;
  /** Which chat types are allowed to inject memory into the prompt. */
  chatTypes: MemoryRecallChatType[];
  /** Timeout for the pre-turn memory search call (ms). */
  timeoutMs: number;
  /** Max results to request from the memory index. */
  maxResults: number;
  /** Minimum similarity score to include a result. */
  minScore: number;
  /** Max characters injected into the system prompt. */
  maxInjectedChars: number;
  /** Minimum message length (chars) before any recall triggers. */
  minMessageChars: number;
};

const DEFAULT_SETTINGS: MemoryRecallSettings = {
  enabled: false,
  mode: "heuristic",
  requireOwner: true,
  chatTypes: ["direct"],
  timeoutMs: 6000,
  maxResults: 6,
  minScore: 0.35,
  maxInjectedChars: 2000,
  minMessageChars: 12,
};

function normalizeChatType(raw?: string | null): MemoryRecallChatType {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "group") {
    return "group";
  }
  if (value === "channel") {
    return "channel";
  }
  return "direct";
}

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

function normalizeNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
}

function normalizeScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0 || value > 1) {
    return null;
  }
  return value;
}

function normalizeMode(value: unknown): MemoryRecallSettings["mode"] | null {
  if (value === "heuristic" || value === "always") {
    return value;
  }
  return null;
}

function normalizeChatTypes(value: unknown): MemoryRecallChatType[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value
    .map((entry) =>
      String(entry ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
    .map((entry) => (entry === "group" ? "group" : entry === "channel" ? "channel" : "direct"));
  const set = new Set<MemoryRecallChatType>(normalized);
  if (set.size === 0) {
    return null;
  }
  return Array.from(set);
}

export function resolveMemoryRecallSettings(
  cfg: OpenClawConfig,
  agentId: string,
): MemoryRecallSettings | null {
  const defaults = cfg.agents?.defaults?.memoryRecall;
  const overrides = resolveAgentConfig(cfg, agentId)?.memoryRecall;

  const enabled = overrides?.enabled ?? defaults?.enabled ?? DEFAULT_SETTINGS.enabled;
  if (!enabled) {
    return null;
  }

  const mode =
    normalizeMode(overrides?.mode) ?? normalizeMode(defaults?.mode) ?? DEFAULT_SETTINGS.mode;

  const requireOwner =
    overrides?.requireOwner ?? defaults?.requireOwner ?? DEFAULT_SETTINGS.requireOwner;

  const chatTypes =
    normalizeChatTypes(overrides?.chatTypes) ??
    normalizeChatTypes(defaults?.chatTypes) ??
    DEFAULT_SETTINGS.chatTypes;

  const timeoutMs =
    normalizePositiveInt(overrides?.timeoutMs) ??
    normalizePositiveInt(defaults?.timeoutMs) ??
    DEFAULT_SETTINGS.timeoutMs;

  const maxResults =
    normalizePositiveInt(overrides?.maxResults) ??
    normalizePositiveInt(defaults?.maxResults) ??
    DEFAULT_SETTINGS.maxResults;

  const minScore =
    normalizeScore(overrides?.minScore) ??
    normalizeScore(defaults?.minScore) ??
    DEFAULT_SETTINGS.minScore;

  const maxInjectedChars =
    normalizePositiveInt(overrides?.maxInjectedChars) ??
    normalizePositiveInt(defaults?.maxInjectedChars) ??
    DEFAULT_SETTINGS.maxInjectedChars;

  const minMessageChars =
    normalizeNonNegativeInt(overrides?.minMessageChars) ??
    normalizeNonNegativeInt(defaults?.minMessageChars) ??
    DEFAULT_SETTINGS.minMessageChars;

  return {
    enabled,
    mode,
    requireOwner,
    chatTypes,
    timeoutMs,
    maxResults,
    minScore,
    maxInjectedChars,
    minMessageChars,
  };
}

const DEFAULT_TRIGGER_PATTERNS: RegExp[] = [
  /\bdid we\b/i,
  /\bdid i\b/i,
  /\bwhat did we\b/i,
  /\bwhat was\b.*\b(decided|decision|status|plan|context)\b/i,
  /\bremind me\b/i,
  /\blast time\b/i,
  /\bearlier\b/i,
  /\bprevious(ly)?\b/i,
  /\bwe (talked|discussed|decided|agreed)\b/i,
  /\bdid we finish\b/i,
  /<-\s*did we\b/i,
  /\[[a-z]{3}\s+\d{4}-\d{2}-\d{2}\b/i,
];

export function shouldTriggerMemoryRecall(params: {
  message: string;
  mode: MemoryRecallSettings["mode"];
  minMessageChars: number;
}): boolean {
  const text = params.message.trim();
  if (!text) {
    return false;
  }
  if (text.length < Math.max(0, params.minMessageChars)) {
    return false;
  }
  if (params.mode === "always") {
    return true;
  }

  // Skip obvious low-signal / control messages.
  if (text.startsWith("/")) {
    return false;
  }

  return DEFAULT_TRIGGER_PATTERNS.some((re) => re.test(text));
}

function formatCitation(entry: Pick<MemorySearchResult, "path" | "startLine" | "endLine">): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

export function formatMemoryRecallBlock(params: {
  results: MemorySearchResult[];
  includeCitations: boolean;
  maxChars: number;
}): string {
  const budget = Math.max(0, Math.floor(params.maxChars));
  if (budget <= 0) {
    return "";
  }
  if (!params.results?.length) {
    return "";
  }

  const header = [
    "## Auto-recall (pre-turn)",
    "The user message likely references prior context. These snippets were retrieved automatically via memory search.",
    "Use them if relevant; do not fabricate details beyond this recall.",
  ].join("\n");

  let remaining = budget;
  const out: string[] = [];

  const pushIfFits = (text: string): boolean => {
    if (!text) {
      return true;
    }
    if (remaining <= 0) {
      return false;
    }
    if (text.length > remaining) {
      return false;
    }
    out.push(text);
    remaining -= text.length;
    return true;
  };

  const truncateToRemaining = (text: string): string => {
    if (!text || remaining <= 0) {
      return "";
    }
    if (text.length <= remaining) {
      return text;
    }

    // Prefer whole lines where possible (avoids truncating mid-markdown / mid-citation line).
    const sliced = text.slice(0, remaining);
    const lastNl = sliced.lastIndexOf("\n");
    const base = lastNl > 0 ? sliced.slice(0, lastNl) : sliced;
    const trimmed = base.trimEnd();

    const ellipsis = trimmed.length + 1 <= remaining ? "…" : "";
    return `${trimmed}${ellipsis}`;
  };

  // Header can be safely truncated (no citations).
  if (!pushIfFits(header)) {
    return header.slice(0, budget).trim();
  }
  pushIfFits("\n\n");

  let pushedAnyRecall = false;

  for (let index = 0; index < params.results.length; index++) {
    if (remaining <= 0) {
      break;
    }
    const entry = params.results[index];
    const label = `### Recall ${index + 1}`;

    const chunkNoCitations = `${label}\n\n${entry.snippet.trim()}`;
    const footer = params.includeCitations ? `\n\nSource: ${formatCitation(entry)}` : "";
    const chunk = `${chunkNoCitations}${footer}`;

    // Separator between chunks.
    if (index > 0 && !pushIfFits("\n\n")) {
      break;
    }

    // Avoid slicing arbitrary chunks (can truncate citations / markdown). Prefer whole entries.
    if (pushIfFits(chunk)) {
      pushedAnyRecall = true;
      continue;
    }

    // If even the first entry doesn't fit, include a truncated snippet without citations.
    if (!pushedAnyRecall) {
      const truncated = truncateToRemaining(chunkNoCitations);
      if (truncated) {
        out.push(truncated);
        remaining -= truncated.length;
      }
    }

    break;
  }

  return out.join("").trim();
}

function resolveMemoryCitationsMode(cfg: OpenClawConfig): "auto" | "on" | "off" {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function shouldIncludeCitations(params: {
  cfg: OpenClawConfig;
  chatType: MemoryRecallChatType;
}): boolean {
  const mode = resolveMemoryCitationsMode(params.cfg);
  if (mode === "on") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  // auto
  return params.chatType === "direct";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const ms = Math.max(1, Math.floor(timeoutMs));
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`memory recall timeout after ${ms}ms`)), ms);
    }),
  ]);
}

export async function maybeBuildMemoryRecallSystemPrompt(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  chatType?: string | null;
  senderIsOwner: boolean;
  isHeartbeat: boolean;
  isBareSessionReset: boolean;
  message: string;
}): Promise<string> {
  if (params.isHeartbeat || params.isBareSessionReset) {
    return "";
  }

  const chatType = normalizeChatType(params.chatType);
  const settings = resolveMemoryRecallSettings(params.cfg, params.agentId);
  if (!settings) {
    return "";
  }

  if (settings.requireOwner && !params.senderIsOwner) {
    return "";
  }

  if (!settings.chatTypes.includes(chatType)) {
    return "";
  }

  if (
    !shouldTriggerMemoryRecall({
      message: params.message,
      mode: settings.mode,
      minMessageChars: settings.minMessageChars,
    })
  ) {
    return "";
  }

  // If memory search itself is disabled, don't attempt recall injection.
  if (!resolveMemorySearchConfig(params.cfg, params.agentId)) {
    return "";
  }

  const { manager } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!manager) {
    return "";
  }

  let results: MemorySearchResult[];
  try {
    results = await withTimeout(
      manager.search(params.message, {
        maxResults: settings.maxResults,
        minScore: settings.minScore,
        sessionKey: params.sessionKey,
      }),
      settings.timeoutMs,
    );
  } catch {
    return "";
  }

  if (!Array.isArray(results) || results.length === 0) {
    return "";
  }

  return formatMemoryRecallBlock({
    results,
    includeCitations: shouldIncludeCitations({ cfg: params.cfg, chatType }),
    maxChars: settings.maxInjectedChars,
  });
}
