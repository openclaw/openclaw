import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionMessageWorkTarget } from "../../config/sessions/message-work-targets.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  resolveAbortCutoffFromContext,
  shouldPersistAbortCutoff,
  type AbortCutoff,
} from "./abort-cutoff.js";
import {
  abortSessionRunTarget,
  formatAbortReplyText,
  isAbortTrigger,
  resolveSessionEntryForKey,
  setAbortMemory,
  stopSubagentsForRequester,
} from "./abort.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { persistAbortTargetEntry } from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";
import { clearSessionQueues } from "./queue.js";
import { replyRunRegistry } from "./reply-run-registry.js";

type AbortTarget = {
  entry?: SessionEntry;
  key?: string;
  sessionId?: string;
};

function resolveAbortTarget(params: {
  ctx: { CommandTargetSessionKey?: string | null };
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
}): AbortTarget {
  const targetSessionKey =
    normalizeOptionalString(params.ctx.CommandTargetSessionKey) || params.sessionKey;
  const { entry, key } = resolveSessionEntryForKey(params.sessionStore, targetSessionKey);
  if (entry && key) {
    return {
      entry,
      key,
      sessionId: replyRunRegistry.resolveSessionId(key) ?? entry.sessionId,
    };
  }
  if (
    params.sessionEntry &&
    params.sessionKey &&
    (!targetSessionKey || targetSessionKey === params.sessionKey)
  ) {
    return {
      entry: params.sessionEntry,
      key: params.sessionKey,
      sessionId:
        replyRunRegistry.resolveSessionId(params.sessionKey) ?? params.sessionEntry.sessionId,
    };
  }
  return {
    entry: undefined,
    key: targetSessionKey,
    sessionId: targetSessionKey ? replyRunRegistry.resolveSessionId(targetSessionKey) : undefined,
  };
}

function resolveAbortCutoffForTarget(params: {
  ctx: Parameters<CommandHandler>[0]["ctx"];
  commandSessionKey?: string;
  targetSessionKey?: string;
}): AbortCutoff | undefined {
  if (
    !shouldPersistAbortCutoff({
      commandSessionKey: params.commandSessionKey,
      targetSessionKey: params.targetSessionKey,
    })
  ) {
    return undefined;
  }
  return resolveAbortCutoffFromContext(params.ctx);
}

async function applyAbortTarget(params: {
  abortTarget: AbortTarget;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  abortKey?: string;
  abortCutoff?: AbortCutoff;
  requireActive?: boolean;
}) {
  const { abortTarget } = params;
  const aborted = abortSessionRunTarget({ key: abortTarget.key, sessionId: abortTarget.sessionId });
  if (params.requireActive && !aborted) {
    return false;
  }

  const persisted = await persistAbortTargetEntry({
    entry: abortTarget.entry,
    key: abortTarget.key,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    abortCutoff: params.abortCutoff,
  });
  if (!persisted && params.abortKey) {
    setAbortMemory(params.abortKey, true);
  }
  return aborted;
}

function buildAbortTargetApplyParams(
  params: Parameters<CommandHandler>[0],
  abortTarget: AbortTarget,
  options?: { requireActive?: boolean },
) {
  return {
    abortTarget,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    abortKey: params.command.abortKey,
    abortCutoff: resolveAbortCutoffForTarget({
      ctx: params.ctx,
      commandSessionKey: params.sessionKey,
      targetSessionKey: abortTarget.key,
    }),
    requireActive: options?.requireActive,
  };
}

function telegramWorkTargetCandidates(ctx: Parameters<CommandHandler>[0]["ctx"]): string[] {
  const candidates = [
    ctx.OriginatingTo,
    ctx.From,
    ctx.To,
    ctx.NativeChannelId,
    ...telegramSessionKeyChatCandidates(ctx.CommandTargetSessionKey),
    ctx.MessageThreadId != null && ctx.From
      ? `${ctx.From}:topic:${ctx.MessageThreadId}`
      : undefined,
  ];
  const expanded = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeOptionalString(candidate);
    if (!normalized) {
      continue;
    }
    expanded.add(normalized);
    const telegramChat = /^telegram:([^:]+)(?::topic:.+)?$/.exec(normalized)?.[1];
    if (telegramChat) {
      expanded.add(telegramChat);
    }
  }
  return [...expanded];
}

function telegramSessionKeyChatCandidates(sessionKey: string | null | undefined): string[] {
  const normalized = normalizeOptionalString(sessionKey);
  if (!normalized) {
    return [];
  }
  const match = /:telegram:(?:direct|group|supergroup|chat):([^:]+)/.exec(normalized);
  const chatId = match?.[1];
  return chatId ? [chatId] : [];
}

export const handleStopCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const commandBody = params.command.commandBodyNormalized;
  if (commandBody !== "/stop" && commandBody !== "/cancel") {
    return null;
  }
  const isTelegramReplyScopedStop =
    params.ctx.Provider === "telegram" || params.ctx.Surface === "telegram";
  if (commandBody === "/cancel" && !isTelegramReplyScopedStop) {
    return null;
  }
  const replyToId = normalizeOptionalString(params.ctx.ReplyToId);
  if (isTelegramReplyScopedStop && commandBody === "/cancel" && !replyToId) {
    return {
      shouldContinue: false,
      reply: { text: "Reply to a message with /stop or /cancel to stop work for that message." },
    };
  }
  const unauthorizedStop = rejectUnauthorizedCommand(params, commandBody);
  if (unauthorizedStop) {
    return unauthorizedStop;
  }
  const messageWorkTarget =
    isTelegramReplyScopedStop && replyToId
      ? resolveSessionMessageWorkTarget({
          sessionStore: params.sessionStore,
          channel: "telegram",
          toCandidates: telegramWorkTargetCandidates(params.ctx),
          messageId: replyToId,
        })
      : undefined;
  if (isTelegramReplyScopedStop && replyToId && !messageWorkTarget) {
    return {
      shouldContinue: false,
      reply: { text: "No active work was found for the replied-to message." },
    };
  }
  const abortTarget = resolveAbortTarget({
    ctx: messageWorkTarget
      ? { ...params.ctx, CommandTargetSessionKey: messageWorkTarget.sessionKey }
      : params.ctx,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
  });
  const aborted = await applyAbortTarget(
    buildAbortTargetApplyParams(params, abortTarget, {
      requireActive: Boolean(messageWorkTarget),
    }),
  );
  if (messageWorkTarget && !aborted) {
    return {
      shouldContinue: false,
      reply: { text: "No active work is still running for the replied-to message." },
    };
  }
  const cleared = clearSessionQueues([abortTarget.key, abortTarget.sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `stop: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }

  // Trigger internal hook for stop command
  const hookEvent = createInternalHookEvent(
    "command",
    "stop",
    abortTarget.key ?? params.sessionKey ?? "",
    {
      sessionEntry: abortTarget.entry,
      sessionId: abortTarget.sessionId,
      commandSource: params.command.surface,
      senderId: params.command.senderId,
    },
  );
  await triggerInternalHook(hookEvent);

  const { stopped } = stopSubagentsForRequester({
    cfg: params.cfg,
    requesterSessionKey: abortTarget.key ?? params.sessionKey,
  });

  return { shouldContinue: false, reply: { text: formatAbortReplyText(stopped) } };
};

export const handleAbortTrigger: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (!isAbortTrigger(params.command.rawBodyNormalized)) {
    return null;
  }
  const unauthorizedAbortTrigger = rejectUnauthorizedCommand(params, "abort trigger");
  if (unauthorizedAbortTrigger) {
    return unauthorizedAbortTrigger;
  }
  const abortTarget = resolveAbortTarget({
    ctx: params.ctx,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
  });
  await applyAbortTarget(buildAbortTargetApplyParams(params, abortTarget));
  return { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } };
};
