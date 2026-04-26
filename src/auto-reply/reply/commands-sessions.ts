import { normalizeChatType } from "../../channels/chat-type.js";
import {
  buildSessionHistoryMetadata,
  DEFAULT_SESSION_HISTORY_LIMIT,
  type SessionEntry,
  type SessionHistoryItem,
} from "../../config/sessions.js";
import { isThreadSessionKey } from "../../config/sessions/reset.js";
import {
  archiveSessionTranscripts,
  readSessionPreviewItemsFromTranscript,
} from "../../gateway/session-utils.fs.js";
import { logVerbose } from "../../globals.js";
import { formatRelativeTimestamp } from "../../infra/format-time/format-relative.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";

const SESSIONS_COMMAND = "/sessions";

type SessionSwitchListItem = {
  sessionId: string;
  sessionFile?: string;
  current: boolean;
  label?: string;
  createdAt?: number;
  metadata?: SessionHistoryItem["metadata"];
};

function resolveSessionHistoryLimit(params: Parameters<CommandHandler>[0]): number {
  const limit = params.cfg.session?.historyLimit;
  return typeof limit === "number" && Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : DEFAULT_SESSION_HISTORY_LIMIT;
}

function isOrdinaryDirectSessionCommandContext(params: Parameters<CommandHandler>[0]): boolean {
  const chatType = normalizeChatType(params.ctx.ChatType);
  const threadId =
    params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
  if (threadId || isThreadSessionKey(params.sessionKey)) {
    return false;
  }
  if (params.isGroup) {
    return false;
  }
  return !chatType || chatType === "direct";
}

function buildSessionHistoryItem(entry: SessionEntry): SessionHistoryItem {
  return {
    sessionId: entry.sessionId,
    sessionFile: entry.sessionFile,
    createdAt: entry.updatedAt ?? Date.now(),
    label: entry.label,
    metadata: buildSessionHistoryMetadata(entry),
  };
}

function buildSwitchableSessionList(entry: SessionEntry): SessionSwitchListItem[] {
  const history = (entry.sessionHistory ?? []).toReversed();
  const currentItem = buildSessionHistoryItem(entry);
  return [
    {
      sessionId: currentItem.sessionId,
      sessionFile: currentItem.sessionFile,
      current: true,
      label: currentItem.label,
      createdAt: currentItem.createdAt,
      metadata: currentItem.metadata,
    },
    ...history.map((item) => ({
      sessionId: item.sessionId,
      sessionFile: item.sessionFile,
      current: false,
      label: item.label,
      createdAt: item.createdAt,
      metadata: item.metadata,
    })),
  ];
}

function resolveSessionPreviewLine(params: {
  sessionId: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  storePath?: string;
  agentId?: string;
}): string | undefined {
  const items = readSessionPreviewItemsFromTranscript(
    params.sessionId,
    params.storePath,
    params.sessionFile ??
      (params.sessionEntry?.sessionId === params.sessionId
        ? params.sessionEntry.sessionFile
        : undefined),
    params.agentId,
    1,
    160,
  );
  const last = items.at(-1);
  if (!last?.text) {
    return undefined;
  }
  const prefix =
    last.role === "user"
      ? "👤"
      : last.role === "assistant"
        ? "🤖"
        : last.role === "tool"
          ? "🛠️"
          : "•";
  return `${prefix} ${last.text}`;
}

function applyHistoryMetadata(
  entry: SessionEntry,
  metadata?: SessionHistoryItem["metadata"],
): void {
  entry.systemSent = metadata?.systemSent ?? false;
  entry.thinkingLevel = metadata?.thinkingLevel;
  entry.verboseLevel = metadata?.verboseLevel;
  entry.reasoningLevel = metadata?.reasoningLevel;
  entry.ttsAuto = metadata?.ttsAuto;
  entry.modelOverride = metadata?.modelOverride;
  entry.providerOverride = metadata?.providerOverride;
  entry.label = metadata?.label;
  entry.sendPolicy = metadata?.sendPolicy;
  entry.queueMode = metadata?.queueMode;
  entry.queueDebounceMs = metadata?.queueDebounceMs;
  entry.queueCap = metadata?.queueCap;
  entry.queueDrop = metadata?.queueDrop;
  entry.inputTokens = metadata?.inputTokens;
  entry.outputTokens = metadata?.outputTokens;
  entry.cacheRead = metadata?.cacheRead;
  entry.cacheWrite = metadata?.cacheWrite;
  entry.totalTokens = metadata?.totalTokens;
  entry.totalTokensFresh = metadata?.totalTokensFresh ?? false;
  entry.contextTokens = metadata?.contextTokens;
  entry.compactionCount = metadata?.compactionCount ?? 0;
  entry.memoryFlushAt = metadata?.memoryFlushAt;
  entry.memoryFlushCompactionCount = metadata?.memoryFlushCompactionCount;
}

export const handleSessionsListCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== SESSIONS_COMMAND && !normalized.startsWith(`${SESSIONS_COMMAND} `)) {
    return null;
  }
  if (!isOrdinaryDirectSessionCommandContext(params)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /sessions from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!params.sessionEntry) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Session state is unavailable for this conversation." },
    };
  }

  const rest = normalized.slice(SESSIONS_COMMAND.length).trim();
  if (!rest) {
    const items = buildSwitchableSessionList(params.sessionEntry);
    const lines = ["📋 Sessions:"];
    for (const [index, item] of items.entries()) {
      const when = item.createdAt
        ? formatRelativeTimestamp(item.createdAt, { dateFallback: true, fallback: "" })
        : "";
      const preview = resolveSessionPreviewLine({
        sessionId: item.sessionId,
        sessionEntry: item.current ? params.sessionEntry : undefined,
        sessionFile: item.sessionFile,
        storePath: params.storePath,
        agentId: params.agentId,
      });
      const parts = [`${index + 1}.`, item.current ? "[current]" : "", item.sessionId.slice(0, 8)];
      if (when) {
        parts.push(`(${when})`);
      }
      if (preview) {
        const compactPreview = preview.replace(/[\r\n]+/g, " ").trim();
        parts.push(compactPreview.length > 20 ? `${compactPreview.slice(0, 20)}…` : compactPreview);
      }
      lines.push(parts.filter(Boolean).join(" "));
    }
    if (items.length <= 1) {
      lines.push("   No previous sessions yet. Use /new to start another one.");
    } else {
      lines.push("", "Use /sessions <number>, /sessions <sessionId>, or /sessions back.");
    }

    return {
      shouldContinue: false,
      reply: { text: lines.join("\n") },
    };
  }

  if (!params.sessionStore || !params.sessionKey) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Session state is unavailable for this conversation." },
    };
  }

  const action = rest.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";
  const allItems = buildSwitchableSessionList(params.sessionEntry);
  let ambiguousPrefixMatches: SessionSwitchListItem[] = [];
  const target = (() => {
    if (action === "back") {
      return allItems[1];
    }
    if (/^\d+$/.test(action)) {
      const index = Number(action) - 1;
      return index >= 0 ? allItems[index] : undefined;
    }
    const exact = allItems.find((item) => item.sessionId.toLowerCase() === action);
    if (exact) {
      return exact;
    }
    const prefixMatches = allItems.filter((item) =>
      item.sessionId.toLowerCase().startsWith(action),
    );
    if (prefixMatches.length > 1) {
      ambiguousPrefixMatches = prefixMatches;
      return undefined;
    }
    return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
  })();

  if (!target) {
    return {
      shouldContinue: false,
      reply: {
        text:
          action === "back"
            ? "ℹ️ There is no previous session to switch back to."
            : ambiguousPrefixMatches.length > 1
              ? `⚠️ Ambiguous session prefix: ${action}. Matches ${ambiguousPrefixMatches.length} sessions. Use /sessions or provide more characters.`
              : `⚠️ Session not found: ${action}. Use /sessions to list available sessions.`,
      },
    };
  }

  if (target.sessionId === params.sessionEntry.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "ℹ️ Already in that session." },
    };
  }

  const historyLimit = resolveSessionHistoryLimit(params);
  const currentItem = buildSessionHistoryItem(params.sessionEntry);
  const nextHistory = (params.sessionEntry.sessionHistory ?? []).filter(
    (item) => item.sessionId !== currentItem.sessionId && item.sessionId !== target.sessionId,
  );
  nextHistory.push(currentItem);
  while (nextHistory.length > historyLimit) {
    const removed = nextHistory.shift();
    if (removed) {
      archiveSessionTranscripts({
        sessionId: removed.sessionId,
        storePath: params.storePath,
        sessionFile: removed.sessionFile,
        agentId: params.agentId,
        reason: "reset",
      });
    }
  }

  params.sessionEntry.sessionId = target.sessionId;
  params.sessionEntry.sessionFile = target.sessionFile;
  params.sessionEntry.sessionHistory = nextHistory;
  applyHistoryMetadata(params.sessionEntry, target.metadata);
  await persistSessionEntry(params);

  const preview = resolveSessionPreviewLine({
    sessionId: target.sessionId,
    sessionFile: target.sessionFile,
    storePath: params.storePath,
    agentId: params.agentId,
  });
  const switchIndex = allItems.findIndex((item) => item.sessionId === target.sessionId);
  const lines = [
    `🔄 Switched to session #${switchIndex >= 0 ? switchIndex + 1 : "?"} (${target.sessionId.slice(0, 8)}).`,
  ];
  if (preview) {
    lines.push("", `Recent: ${preview}`);
  }

  return {
    shouldContinue: false,
    reply: { text: lines.join("\n") },
  };
};
