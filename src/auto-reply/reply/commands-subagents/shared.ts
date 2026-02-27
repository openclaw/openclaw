import type { SubagentRunRecord } from "../../../agents/subagent-registry.js";
import {
  extractAssistantText,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  sanitizeTextContent,
  stripToolMessages,
} from "../../../agents/tools/sessions-helpers.js";
import type {
  SessionEntry,
  loadSessionStore as loadSessionStoreFn,
  resolveStorePath as resolveStorePathFn,
} from "../../../config/sessions.js";
import { parseDiscordTarget } from "../../../discord/targets.js";
import { callGateway } from "../../../gateway/call.js";
import { formatTimeAgo } from "../../../infra/format-time/format-relative.ts";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { extractTextFromChatContent } from "../../../shared/chat-content.js";
import {
  formatDurationCompact,
  formatTokenUsageDisplay,
  truncateLine,
} from "../../../shared/subagents-format.js";
import type { CommandHandler, CommandHandlerResult } from "../commands-types.js";
import {
  formatRunLabel,
  formatRunStatus,
  resolveSubagentTargetFromRuns,
  type SubagentTargetResolution,
} from "../subagents-utils.js";

export { extractAssistantText, stripToolMessages };

export const COMMAND = "/subagents";
export const COMMAND_KILL = "/kill";
export const COMMAND_STEER = "/steer";
export const COMMAND_TELL = "/tell";
export const COMMAND_FOCUS = "/focus";
export const COMMAND_UNFOCUS = "/unfocus";
export const COMMAND_AGENTS = "/agents";
export const ACTIONS = new Set([
  "list",
  "kill",
  "log",
  "send",
  "steer",
  "info",
  "spawn",
  "focus",
  "unfocus",
  "agents",
  "help",
]);

export const RECENT_WINDOW_MINUTES = 30;
const SUBAGENT_TASK_PREVIEW_MAX = 110;
export const STEER_ABORT_SETTLE_TIMEOUT_MS = 5_000;

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function compactLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function formatTaskPreview(value: string) {
  return truncateLine(compactLine(value), SUBAGENT_TASK_PREVIEW_MAX);
}

function resolveModelDisplay(
  entry?: {
    model?: unknown;
    modelProvider?: unknown;
    modelOverride?: unknown;
    providerOverride?: unknown;
  },
  fallbackModel?: string,
) {
  const model = typeof entry?.model === "string" ? entry.model.trim() : "";
  const provider = typeof entry?.modelProvider === "string" ? entry.modelProvider.trim() : "";
  let combined = model.includes("/") ? model : model && provider ? `${provider}/${model}` : model;
  if (!combined) {
    const overrideModel =
      typeof entry?.modelOverride === "string" ? entry.modelOverride.trim() : "";
    const overrideProvider =
      typeof entry?.providerOverride === "string" ? entry.providerOverride.trim() : "";
    combined = overrideModel.includes("/")
      ? overrideModel
      : overrideModel && overrideProvider
        ? `${overrideProvider}/${overrideModel}`
        : overrideModel;
  }
  if (!combined) {
    combined = fallbackModel?.trim() || "";
  }
  if (!combined) {
    return "model n/a";
  }
  const slash = combined.lastIndexOf("/");
  if (slash >= 0 && slash < combined.length - 1) {
    return combined.slice(slash + 1);
  }
  return combined;
}

export function resolveDisplayStatus(entry: SubagentRunRecord) {
  const status = formatRunStatus(entry);
  return status === "error" ? "failed" : status;
}

export function formatSubagentListLine(params: {
  entry: SubagentRunRecord;
  index: number;
  runtimeMs: number;
  sessionEntry?: SessionEntry;
}) {
  const usageText = formatTokenUsageDisplay(params.sessionEntry);
  const label = truncateLine(formatRunLabel(params.entry, { maxLength: 48 }), 48);
  const task = formatTaskPreview(params.entry.task);
  const runtime = formatDurationCompact(params.runtimeMs);
  const status = resolveDisplayStatus(params.entry);
  return `${params.index}. ${label} (${resolveModelDisplay(params.sessionEntry, params.entry.model)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${task.toLowerCase() !== label.toLowerCase() ? ` - ${task}` : ""}`;
}

function formatTimestamp(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  return new Date(valueMs).toISOString();
}

export function formatTimestampWithAge(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  return `${formatTimestamp(valueMs)} (${formatTimeAgo(Date.now() - valueMs, { fallback: "n/a" })})`;
}

export type SubagentsAction =
  | "list"
  | "kill"
  | "log"
  | "send"
  | "steer"
  | "info"
  | "spawn"
  | "focus"
  | "unfocus"
  | "agents"
  | "help";

export type SubagentsCommandParams = Parameters<CommandHandler>[0];

export type SubagentsCommandContext = {
  params: SubagentsCommandParams;
  handledPrefix: string;
  requesterKey: string;
  runs: SubagentRunRecord[];
  restTokens: string[];
};

export function stopWithText(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

export function stopWithUnknownTargetError(error?: string): CommandHandlerResult {
  return stopWithText(`⚠️ ${error ?? "Unknown subagent."}`);
}

export function resolveSubagentTarget(
  runs: SubagentRunRecord[],
  token: string | undefined,
): SubagentTargetResolution {
  return resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: RECENT_WINDOW_MINUTES,
    label: (entry) => formatRunLabel(entry),
    errors: {
      missingTarget: "Missing subagent id.",
      invalidIndex: (value) => `Invalid subagent index: ${value}`,
      unknownSession: (value) => `Unknown subagent session: ${value}`,
      ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
      ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}`,
      ambiguousRunIdPrefix: (value) => `Ambiguous run id prefix: ${value}`,
      unknownTarget: (value) => `Unknown subagent id: ${value}`,
    },
  });
}

export function resolveSubagentEntryForToken(
  runs: SubagentRunRecord[],
  token: string | undefined,
): { entry: SubagentRunRecord } | { reply: CommandHandlerResult } {
  const resolved = resolveSubagentTarget(runs, token);
  if (!resolved.entry) {
    return { reply: stopWithUnknownTargetError(resolved.error) };
  }
  return { entry: resolved.entry };
}

export function resolveRequesterSessionKey(
  params: SubagentsCommandParams,
  opts?: { preferCommandTarget?: boolean },
): string | undefined {
  const commandTarget = params.ctx.CommandTargetSessionKey?.trim();
  const commandSession = params.sessionKey?.trim();
  const raw = opts?.preferCommandTarget
    ? commandTarget || commandSession
    : commandSession || commandTarget;
  if (!raw) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  return resolveInternalSessionKey({ key: raw, alias, mainKey });
}

export function resolveHandledPrefix(normalized: string): string | null {
  return normalized.startsWith(COMMAND)
    ? COMMAND
    : normalized.startsWith(COMMAND_KILL)
      ? COMMAND_KILL
      : normalized.startsWith(COMMAND_STEER)
        ? COMMAND_STEER
        : normalized.startsWith(COMMAND_TELL)
          ? COMMAND_TELL
          : normalized.startsWith(COMMAND_FOCUS)
            ? COMMAND_FOCUS
            : normalized.startsWith(COMMAND_UNFOCUS)
              ? COMMAND_UNFOCUS
              : normalized.startsWith(COMMAND_AGENTS)
                ? COMMAND_AGENTS
                : null;
}

export function resolveSubagentsAction(params: {
  handledPrefix: string;
  restTokens: string[];
}): SubagentsAction | null {
  if (params.handledPrefix === COMMAND) {
    const [actionRaw] = params.restTokens;
    const action = (actionRaw?.toLowerCase() || "list") as SubagentsAction;
    if (!ACTIONS.has(action)) {
      return null;
    }
    params.restTokens.splice(0, 1);
    return action;
  }
  if (params.handledPrefix === COMMAND_KILL) {
    return "kill";
  }
  if (params.handledPrefix === COMMAND_FOCUS) {
    return "focus";
  }
  if (params.handledPrefix === COMMAND_UNFOCUS) {
    return "unfocus";
  }
  if (params.handledPrefix === COMMAND_AGENTS) {
    return "agents";
  }
  return "steer";
}

export type FocusTargetResolution = {
  targetKind: "subagent" | "acp";
  targetSessionKey: string;
  agentId: string;
  label?: string;
};

export function isDiscordSurface(params: SubagentsCommandParams): boolean {
  const channel =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return (
    String(channel ?? "")
      .trim()
      .toLowerCase() === "discord"
  );
}

export function resolveDiscordAccountId(params: SubagentsCommandParams): string {
  const accountId = typeof params.ctx.AccountId === "string" ? params.ctx.AccountId.trim() : "";
  return accountId || "default";
}

export function resolveDiscordChannelIdForFocus(
  params: SubagentsCommandParams,
): string | undefined {
  const toCandidates = [
    typeof params.ctx.OriginatingTo === "string" ? params.ctx.OriginatingTo.trim() : "",
    typeof params.command.to === "string" ? params.command.to.trim() : "",
    typeof params.ctx.To === "string" ? params.ctx.To.trim() : "",
  ].filter(Boolean);
  for (const candidate of toCandidates) {
    try {
      const target = parseDiscordTarget(candidate, { defaultKind: "channel" });
      if (target?.kind === "channel" && target.id) {
        return target.id;
      }
    } catch {
      // Ignore parse failures and try the next candidate.
    }
  }
  return undefined;
}

export async function resolveFocusTargetSession(params: {
  runs: SubagentRunRecord[];
  token: string;
}): Promise<FocusTargetResolution | null> {
  const subagentMatch = resolveSubagentTarget(params.runs, params.token);
  if (subagentMatch.entry) {
    const key = subagentMatch.entry.childSessionKey;
    const parsed = parseAgentSessionKey(key);
    return {
      targetKind: "subagent",
      targetSessionKey: key,
      agentId: parsed?.agentId ?? "main",
      label: formatRunLabel(subagentMatch.entry),
    };
  }

  const token = params.token.trim();
  if (!token) {
    return null;
  }

  const attempts: Array<Record<string, string>> = [];
  attempts.push({ key: token });
  if (SESSION_ID_RE.test(token)) {
    attempts.push({ sessionId: token });
  }
  attempts.push({ label: token });

  for (const attempt of attempts) {
    try {
      const resolved = await callGateway<{ key?: string }>({
        method: "sessions.resolve",
        params: attempt,
      });
      const key = typeof resolved?.key === "string" ? resolved.key.trim() : "";
      if (!key) {
        continue;
      }
      const parsed = parseAgentSessionKey(key);
      return {
        targetKind: key.includes(":subagent:") ? "subagent" : "acp",
        targetSessionKey: key,
        agentId: parsed?.agentId ?? "main",
        label: token,
      };
    } catch {
      // Try the next resolution strategy.
    }
  }
  return null;
}

export function buildSubagentsHelp() {
  return [
    "Subagents",
    "Usage:",
    "- /subagents list",
    "- /subagents kill <id|#|all>",
    "- /subagents log <id|#> [limit] [tools]",
    "- /subagents info <id|#>",
    "- /subagents send <id|#> <message>",
    "- /subagents steer <id|#> <message>",
    "- /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
    "- /focus <subagent-label|session-key|session-id|session-label>",
    "- /unfocus",
    "- /agents",
    "- /session idle <duration|off>",
    "- /session max-age <duration|off>",
    "- /kill <id|#|all>",
    "- /steer <id|#> <message>",
    "- /tell <id|#> <message>",
    "",
    "Ids: use the list index (#), runId/session prefix, label, or full session key.",
  ].join("\n");
}

export type ChatMessage = {
  role?: unknown;
  content?: unknown;
};

export function extractMessageText(message: ChatMessage): { role: string; text: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  const shouldSanitize = role === "assistant";
  const text = extractTextFromChatContent(message.content, {
    sanitizeText: shouldSanitize ? sanitizeTextContent : undefined,
  });
  return text ? { role, text } : null;
}

export function formatLogLines(messages: ChatMessage[]) {
  const lines: string[] = [];
  for (const msg of messages) {
    const extracted = extractMessageText(msg);
    if (!extracted) {
      continue;
    }
    const label = extracted.role === "assistant" ? "Assistant" : "User";
    lines.push(`${label}: ${extracted.text}`);
  }
  return lines;
}

export type SessionStoreCache = Map<string, Record<string, SessionEntry>>;

export function loadSubagentSessionEntry(
  params: SubagentsCommandParams,
  childKey: string,
  loaders: {
    loadSessionStore: typeof loadSessionStoreFn;
    resolveStorePath: typeof resolveStorePathFn;
  },
  storeCache?: SessionStoreCache,
) {
  const parsed = parseAgentSessionKey(childKey);
  const storePath = loaders.resolveStorePath(params.cfg.session?.store, {
    agentId: parsed?.agentId,
  });
  let store = storeCache?.get(storePath);
  if (!store) {
    store = loaders.loadSessionStore(storePath);
    storeCache?.set(storePath, store);
  }
  return { storePath, store, entry: store[childKey] };
}
