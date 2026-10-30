import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedGlobalAgentId,
  resolveUiDefaultAgentId,
} from "../../lib/sessions/session-key.ts";
import type { executeSlashCommand } from "./chat-command-executor.ts";
import {
  currentSessionAccessSnapshot,
  isChatCommandConnectionCurrent,
  isChatCommandTargetCurrent,
  confirmConversationResetForCurrentSession,
  requireChatSessionAction,
  type ChatCommandAdmission,
  type ChatCommandDispatchResult,
  type ChatCommandHost,
  type ChatCommandTarget,
} from "./chat-commands.ts";
import { clearChatHistory } from "./chat-history-actions.ts";
import { setChatError } from "./chat-history-state.ts";
import { publishChatSessionProjectionMessages } from "./history-merge.ts";
import { scheduleChatScroll } from "./scroll.ts";

function isChatCommandModelCacheOwnerCurrent(
  host: ChatCommandHost,
  target: ChatCommandTarget,
): boolean {
  if (!isChatCommandConnectionCurrent(host, target)) {
    return false;
  }
  // The selected-agent global session shares one UI cache key across agents.
  // Keep delayed results out when that selection changes on the same Gateway.
  return (
    !isUiSelectedGlobalSessionKey(host, target.sessionKey) ||
    resolveUiSelectedGlobalAgentId(host) === target.agentId
  );
}

export async function dispatchCapturedChatSlashCommand(
  host: ChatCommandHost,
  name: string,
  args: string,
  attachments: readonly ChatAttachment[] | undefined,
  target: ChatCommandTarget | null,
  isCurrent: () => boolean,
  runId: string | undefined,
  request: ChatCommandAdmission | undefined,
): Promise<ChatCommandDispatchResult> {
  switch (name) {
    case "new":
      if (!host.createChatSession) {
        setChatError(host, "New Chat is unavailable.");
        return "failed";
      }
      return (await host.createChatSession()) ? "completed" : "cancelled";
    case "clear": {
      if (!requireChatSessionAction(host, "reset")) {
        return "failed";
      }
      if (!target) {
        return "failed";
      }
      const confirmation = await confirmConversationResetForCurrentSession(host);
      if (confirmation !== "confirmed") {
        return confirmation;
      }
      if (!isChatCommandTargetCurrent(host, target)) {
        setChatError(host, "The Gateway connection changed. Retry the command.");
        return "failed";
      }
      if (!requireChatSessionAction(host, "reset")) {
        return "failed";
      }
      return clearChatHistory(host);
    }
    case "compact":
      if (!requireChatSessionAction(host, "compact")) {
        return "failed";
      }
      break;
    case "export-session": {
      if (args.trim()) {
        setChatError(host, t("chat.commandResults.exportPathUnsupported"));
        return "failed";
      }
      setChatError(host, null);
      const { sessionKey, currentSessionId } = host;
      const targetIsCurrent = () =>
        host.sessionKey === sessionKey &&
        host.currentSessionId === currentSessionId &&
        (!target || isChatCommandTargetCurrent(host, target));
      try {
        const result = await host.exportCurrentChat?.();
        if (!targetIsCurrent()) {
          return "cancelled";
        }
        if (result === "empty") {
          injectCommandResult(host, t("chat.commandResults.emptyExport"));
          scheduleChatScroll(host, false, false, { contentChanged: true });
        }
        return "completed";
      } catch (error) {
        if (targetIsCurrent()) {
          setChatError(host, formatUiError(error));
        }
        return "failed";
      }
    }
  }

  if (!target) {
    setChatError(host, "Gateway not connected");
    injectCommandResult(
      host,
      `Cannot run \`/${name}\`: Control UI is not connected to the Gateway.`,
    );
    scheduleChatScroll(host, false, false, {
      contentChanged: true,
    });
    return "failed";
  }

  const targetIsCurrent = () => !request?.signal.aborted && isCurrent();
  let result: Awaited<ReturnType<typeof executeSlashCommand>>;
  try {
    const { executeSlashCommand } = await import("./chat-command-executor.ts");
    if (!targetIsCurrent()) {
      return "failed";
    }
    result = await executeSlashCommand(target.client, target.sessionKey, name, args, {
      sessions: host.sessions,
      attachments,
      sessionAccessSnapshot: currentSessionAccessSnapshot(host),
      readSessionAccessSnapshot: () => currentSessionAccessSnapshot(host),
      isCurrent: targetIsCurrent,
      runRequest: request && runId ? { runId, signal: request.signal } : undefined,
      chatModelCatalog: host.chatModelCatalog,
      defaultAgentId: resolveUiDefaultAgentId(host),
      agentId: target.agentId,
      ownsModelOverride: () => isChatCommandModelCacheOwnerCurrent(host, target),
    });
  } catch (err) {
    if (targetIsCurrent()) {
      setChatError(host, formatUiError(err));
      injectCommandResult(host, `Command \`/${name}\` failed unexpectedly.`);
      scheduleChatScroll(host, false, false, {
        contentChanged: true,
      });
    }
    return "failed";
  } finally {
    request?.release();
  }

  if (result.content && targetIsCurrent()) {
    injectCommandResult(host, result.content);
  }
  if (result.failed) {
    if (targetIsCurrent()) {
      setChatError(host, result.content || `Command /${name} failed.`);
      scheduleChatScroll(host, false, false, {
        contentChanged: Boolean(result.content),
      });
    }
    return "failed";
  }

  if (result.trackRunId && targetIsCurrent()) {
    host.chatRunId = result.trackRunId;
    host.chatStream = "";
    host.chatSending = false;
  }

  if (result.action === "refresh" && targetIsCurrent()) {
    await host.refreshCurrentChat?.();
  }

  if (targetIsCurrent()) {
    scheduleChatScroll(host, false, false, {
      contentChanged: Boolean(result.content),
    });
  }
  return "completed";
}

function injectCommandResult(host: ChatCommandHost, content: string) {
  publishChatSessionProjectionMessages(host, [
    ...host.chatMessages,
    {
      role: "system",
      content,
      timestamp: Date.now(),
    },
  ]);
}
