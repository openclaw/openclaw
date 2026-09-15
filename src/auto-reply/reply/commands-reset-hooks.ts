// Emits reset hooks and cleanup work around session reset commands.
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import {
  type BeforeResetHookMessages,
  readBeforeResetHookMessages,
} from "../../gateway/session-reset-hook-messages.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { HandleCommandsParams } from "./commands-types.js";

const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));

function loadRouteReplyRuntime() {
  return routeReplyRuntimeLoader.load();
}

export type ResetCommandAction = "new" | "reset";

export type { BeforeResetHookMessages } from "../../gateway/session-reset-hook-messages.js";

/** Bounded pre-reset transcript for plugin observers; see `readBeforeResetHookMessages`. */
export async function readBeforeResetMessages(params: {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
}): Promise<BeforeResetHookMessages> {
  return readBeforeResetHookMessages(params, "raw");
}

export async function emitResetCommandHooks(params: {
  action: ResetCommandAction;
  agentId?: string;
  ctx: HandleCommandsParams["ctx"];
  cfg: HandleCommandsParams["cfg"];
  command: Pick<
    HandleCommandsParams["command"],
    "surface" | "senderId" | "channel" | "from" | "to" | "resetHookTriggered"
  >;
  sessionKey?: string;
  storePath?: string;
  sessionEntry?: HandleCommandsParams["sessionEntry"];
  previousSessionEntry?: HandleCommandsParams["previousSessionEntry"];
  previousSessionMemory?: HandleCommandsParams["previousSessionMemory"];
  previousSessionResetMessages?: BeforeResetHookMessages;
  onObservedReplyDelivery?: () => Promise<void> | void;
  workspaceDir: string;
}): Promise<{ routedReply: boolean }> {
  const hookAgentId =
    parseAgentSessionKey(params.sessionKey)?.agentId ??
    params.agentId ??
    resolveDefaultAgentId(params.cfg);
  const hookStorePath =
    hookAgentId && params.storePath
      ? resolveSessionStorePathForScope({
          agentId: hookAgentId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        })
      : params.storePath;
  const hookEvent = createInternalHookEvent("command", params.action, params.sessionKey ?? "", {
    agentId: hookAgentId,
    sessionEntry: params.sessionEntry,
    previousSessionEntry: params.previousSessionEntry,
    previousSessionMemory: params.previousSessionMemory,
    commandSource: params.command.surface,
    senderId: params.command.senderId,
    workspaceDir: params.workspaceDir,
    storePath: hookStorePath,
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
      const result = await routeReply({
        payload: { text: hookEvent.messages.join("\n\n") },
        channel,
        to,
        agentId: hookAgentId,
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
      if (result.delivered) {
        await params.onObservedReplyDelivery?.();
      }
      routedReply = result.delivered || result.suppressed === true;
    }
  }

  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_reset")) {
    const prevEntry = params.previousSessionEntry;
    const agentId = hookAgentId;
    const storePath = hookStorePath;
    const sessionFile =
      agentId && prevEntry?.sessionId && storePath
        ? formatSqliteSessionFileMarker({ agentId, sessionId: prevEntry.sessionId, storePath })
        : params.sessionKey;
    const payload =
      params.previousSessionResetMessages ??
      (await readBeforeResetMessages({
        agentId,
        sessionId: prevEntry?.sessionId,
        sessionKey: params.sessionKey,
        storePath,
      }));
    void (async () => {
      try {
        await hookRunner.runBeforeReset(
          {
            sessionFile,
            messages: payload.messages,
            totalMessages: payload.totalMessages,
            truncated: payload.truncated,
            reason: params.action,
          },
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
