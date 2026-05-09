import {
  exportSqliteSessionTranscriptJsonl,
  hasSqliteSessionTranscriptEvents,
} from "../../config/sessions/transcript-store.sqlite.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { HandleCommandsParams } from "./commands-types.js";

const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));

function loadRouteReplyRuntime() {
  return routeReplyRuntimeLoader.load();
}

export type ResetCommandAction = "new" | "reset";

function parseTranscriptMessages(content: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message) {
        messages.push(entry.message);
      }
    } catch {
      // Skip malformed lines from partially-written transcripts.
    }
  }
  return messages;
}

type BeforeResetTranscriptScope = {
  agentId?: string;
  sessionId?: string;
};

function hasScopedSqliteTranscriptEvents(
  params: BeforeResetTranscriptScope,
): params is BeforeResetTranscriptScope & { agentId: string; sessionId: string } {
  if (!params.agentId?.trim() || !params.sessionId?.trim()) {
    return false;
  }
  try {
    return hasSqliteSessionTranscriptEvents({
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
  } catch {
    return false;
  }
}

function loadScopedBeforeResetTranscript(
  params: BeforeResetTranscriptScope,
): { messages: unknown[] } | undefined {
  if (!hasScopedSqliteTranscriptEvents(params)) {
    return undefined;
  }
  try {
    return {
      messages: parseTranscriptMessages(
        exportSqliteSessionTranscriptJsonl({
          agentId: params.agentId,
          sessionId: params.sessionId,
        }),
      ),
    };
  } catch {
    return undefined;
  }
}

async function loadBeforeResetTranscript(params: {
  agentId?: string;
  sessionId?: string;
}): Promise<{ messages: unknown[] }> {
  const scopedTranscript = loadScopedBeforeResetTranscript(params);
  if (scopedTranscript) {
    return scopedTranscript;
  }

  logVerbose(
    "before_reset: no scoped SQLite transcript available, firing hook with empty messages",
  );
  return { messages: [] };
}

export async function emitResetCommandHooks(params: {
  action: ResetCommandAction;
  ctx: HandleCommandsParams["ctx"];
  cfg: HandleCommandsParams["cfg"];
  command: Pick<
    HandleCommandsParams["command"],
    "surface" | "senderId" | "channel" | "from" | "to" | "resetHookTriggered"
  >;
  sessionKey?: string;
  sessionEntry?: HandleCommandsParams["sessionEntry"];
  previousSessionEntry?: HandleCommandsParams["previousSessionEntry"];
  workspaceDir: string;
}): Promise<{ routedReply: boolean }> {
  const hookEvent = createInternalHookEvent("command", params.action, params.sessionKey ?? "", {
    sessionEntry: params.sessionEntry,
    previousSessionEntry: params.previousSessionEntry,
    commandSource: params.command.surface,
    senderId: params.command.senderId,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  await triggerInternalHook(hookEvent);
  params.command.resetHookTriggered = true;

  let routedReply = false;
  if (hookEvent.messages.length > 0) {
    const channel = params.ctx.OriginatingChannel || params.command.channel;
    const to = params.ctx.OriginatingTo || params.command.from || params.command.to;
    if (channel && to) {
      const { routeReply } = await loadRouteReplyRuntime();
      await routeReply({
        payload: { text: hookEvent.messages.join("\n\n") },
        channel,
        to,
        sessionKey: params.sessionKey,
        accountId: params.ctx.AccountId,
        requesterSenderId: params.command.senderId,
        requesterSenderName: params.ctx.SenderName,
        requesterSenderUsername: params.ctx.SenderUsername,
        requesterSenderE164: params.ctx.SenderE164,
        threadId: params.ctx.MessageThreadId,
        cfg: params.cfg,
      });
      routedReply = true;
    }
  }

  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_reset")) {
    const prevEntry = params.previousSessionEntry;
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    void (async () => {
      const { messages } = await loadBeforeResetTranscript({
        agentId,
        sessionId: prevEntry?.sessionId,
      });

      try {
        await hookRunner.runBeforeReset(
          { messages, reason: params.action },
          {
            agentId,
            sessionKey: params.sessionKey,
            sessionId: prevEntry?.sessionId,
            workspaceDir: params.workspaceDir,
          },
        );
      } catch (err: unknown) {
        logVerbose(`before_reset hook failed: ${String(err)}`);
      }
    })();
  }
  return { routedReply };
}
