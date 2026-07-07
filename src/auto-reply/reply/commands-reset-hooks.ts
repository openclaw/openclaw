import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
// Emits reset hooks and cleanup work around session reset commands.
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

async function loadBeforeResetTranscript(params: {
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  agentId?: string;
}): Promise<{ sessionFile?: string; messages: unknown[] }> {
  const sessionFile = params.sessionFile;
  const sessionId = params.sessionId;
  if (!sessionFile || !sessionId) {
    logVerbose("before_reset: no session file/id available, firing hook with empty messages");
    return { sessionFile, messages: [] };
  }

  try {
    const messages = await readSessionMessagesAsync(
      {
        // Only bind to an agent when we have a storePath; otherwise the reader
        // should honor the explicit sessionFile path (e.g. absolute temp paths).
        agentId: params.storePath ? params.agentId : undefined,
        sessionFile,
        sessionId,
        sessionKey: params.sessionKey,
      },
      {
        mode: "full",
        reason: "before_reset hook payload",
        allowResetArchiveFallback: true,
      },
    );
    return { sessionFile, messages };
  } catch (err: unknown) {
    logVerbose(
      `before_reset: failed to read session messages for ${sessionId}; firing hook with empty messages (${String(err)})`,
    );
    return { sessionFile, messages: [] };
  }
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
  storePath?: string;
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
        replyKind: "final",
      });
      routedReply = true;
    }
  }

  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_reset")) {
    const prevEntry = params.previousSessionEntry;
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    void (async () => {
      const { sessionFile, messages } = await loadBeforeResetTranscript({
        sessionFile: prevEntry?.sessionFile,
        sessionId: prevEntry?.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        agentId,
      });

      try {
        await hookRunner.runBeforeReset(
          { sessionFile, messages, reason: params.action },
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
