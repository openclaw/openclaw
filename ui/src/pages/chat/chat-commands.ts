import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  scopedAgentIdForSession,
  visibleSessionMatches,
  type SessionCapability,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiSelectedGlobalSessionKey,
  resolveUiDefaultAgentId,
  resolveUiConversationIdentity,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { executeSlashCommand } from "./chat-command-executor.ts";
import { clearChatHistory } from "./chat-history-actions.ts";
import { setChatError } from "./chat-history-state.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import type { ChatExportResult } from "./export.ts";
import { publishChatSessionProjectionMessages } from "./history-merge.ts";
import { handleAbortChat } from "./run-lifecycle.ts";
import { scheduleChatScroll, type ChatScrollHost } from "./scroll.ts";

type ChatCommandDispatchResult = "completed" | "failed" | "uncertain" | "cancelled" | "deferred";

export type ChatCommandTarget = {
  client: GatewayBrowserClient;
  connectionEpoch: number;
  sessionKey: string;
  agentId?: string;
};

export type ChatCommandHost = Parameters<typeof handleAbortChat>[0] &
  Parameters<typeof clearChatHistory>[0] & {
    sessions: SessionCapability;
    chatModelCatalog: ModelCatalogEntry[];
    createChatSession?: () => Promise<boolean>;
    confirmConversationReset?: () => Promise<boolean>;
    exportCurrentChat?: () => Promise<ChatExportResult> | ChatExportResult;
  } & UiSessionDefaultsHost &
  ChatScrollHost;

function currentSessionAccessSnapshot(
  host: ChatCommandHost,
): Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> {
  return {
    client: host.client ?? null,
    hello: host.hello ?? null,
    phase: host.connected ? "connected" : "offline",
  };
}

export function requireChatSessionAction(
  host: ChatCommandHost,
  action: "abort" | "compact" | "reset",
): boolean {
  // Typed Stop is session-scoped, so it needs sessions.abort even while a run is local.
  const access = readChatSessionActionAccess(currentSessionAccessSnapshot(host), false, {
    session: host.sessionsResult?.sessions.find((row) =>
      visibleSessionMatches(host, row.key, row.agentId ?? host.sessionsResultAgentId ?? undefined),
    ),
  })[action];
  if (access.allowed) {
    return true;
  }
  setChatError(host, access.reason);
  return false;
}

export function captureChatCommandTarget(host: ChatCommandHost): ChatCommandTarget | null {
  if (!host.client || !host.connected) {
    return null;
  }
  return {
    client: host.client,
    connectionEpoch: host.connectionEpoch,
    sessionKey: host.sessionKey,
    agentId: scopedAgentIdForSession(host, host.sessionKey),
  };
}

function isChatCommandConnectionCurrent(host: ChatCommandHost, target: ChatCommandTarget): boolean {
  return (
    host.connected &&
    host.client === target.client &&
    host.connectionEpoch === target.connectionEpoch
  );
}

function isChatCommandTargetCurrent(host: ChatCommandHost, target: ChatCommandTarget): boolean {
  return (
    isChatCommandConnectionCurrent(host, target) &&
    visibleSessionMatches(host, target.sessionKey, target.agentId)
  );
}

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

export function readChatResetTargetAccess(
  host: ChatCommandHost,
  target: ChatCommandTarget,
): { allowed: true } | { allowed: false; reason: string } {
  if (!isChatCommandTargetCurrent(host, target)) {
    return { allowed: false, reason: "The Gateway connection changed. Retry the command." };
  }
  const access = readSessionMethodAccess(currentSessionAccessSnapshot(host), {
    method: "chat.send",
    requiredScope: "operator.admin",
  });
  return access.allowed ? { allowed: true } : access;
}

export function shouldQueueLocalSlashCommand(name: string): boolean {
  return !["stop", "export-session", "steer", "redirect", "new"].includes(name);
}

export async function confirmConversationResetForCurrentSession(
  host: ChatCommandHost,
  target?: { sessionKey: string; agentId?: string },
): Promise<"confirmed" | "cancelled" | "deferred"> {
  const resetSessionKey = target?.sessionKey ?? host.sessionKey;
  const targetIsCurrent = target
    ? () => visibleSessionMatches(host, target.sessionKey, target.agentId)
    : () =>
        host.sessionKey === resetSessionKey ||
        areUiSessionKeysEquivalent(host.sessionKey, resetSessionKey);
  if (!targetIsCurrent()) {
    return "deferred";
  }
  if (!host.confirmConversationReset) {
    return "confirmed";
  }
  const confirmed = await host.confirmConversationReset();
  if (!targetIsCurrent()) {
    return target ? "deferred" : "cancelled";
  }
  if (!confirmed) {
    return "cancelled";
  }
  return host.chatRunId ? "deferred" : "confirmed";
}

export async function dispatchChatSlashCommand(
  host: ChatCommandHost,
  name: string,
  args: string,
  attachments?: readonly ChatAttachment[],
): Promise<ChatCommandDispatchResult> {
  switch (name) {
    case "stop":
      if (!requireChatSessionAction(host, "abort")) {
        return "failed";
      }
      await handleAbortChat(host, { scope: "session" });
      return "completed";
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
      const target = captureChatCommandTarget(host);
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
      const target = captureChatCommandTarget(host);
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

  const target = captureChatCommandTarget(host);
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

  const runId = name === "steer" || name === "redirect" ? generateUUID() : undefined;
  const request = runId
    ? chatOutboxOwner(host).admissions.beginRequest(
        host,
        resolveUiConversationIdentity(host, target.sessionKey, target.agentId),
        runId,
      )
    : undefined;
  const targetIsCurrent = () =>
    !request?.signal.aborted && isChatCommandTargetCurrent(host, target);
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
