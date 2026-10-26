import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
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
  resolveUiConversationIdentity,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { clearChatHistory } from "./chat-history-actions.ts";
import { setChatError } from "./chat-history-state.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import type { ChatExportResult } from "./export.ts";
import { handleAbortChat } from "./run-lifecycle.ts";
import type { ChatScrollHost } from "./scroll.ts";

export type ChatCommandDispatchResult =
  | "completed"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "deferred";

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

export function currentSessionAccessSnapshot(
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

export function isChatCommandConnectionCurrent(
  host: ChatCommandHost,
  target: ChatCommandTarget,
): boolean {
  return (
    host.connected &&
    host.client === target.client &&
    host.connectionEpoch === target.connectionEpoch
  );
}

export function isChatCommandTargetCurrent(
  host: ChatCommandHost,
  target: ChatCommandTarget,
): boolean {
  return (
    isChatCommandConnectionCurrent(host, target) &&
    visibleSessionMatches(host, target.sessionKey, target.agentId)
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

export type ChatCommandAdmission = ReturnType<
  ReturnType<typeof chatOutboxOwner>["admissions"]["beginRequest"]
>;

export async function dispatchChatSlashCommand(
  host: ChatCommandHost,
  name: string,
  args: string,
  attachments?: readonly ChatAttachment[],
): Promise<ChatCommandDispatchResult> {
  if (name === "stop") {
    if (!requireChatSessionAction(host, "abort")) {
      return "failed";
    }
    await handleAbortChat(host, { scope: "session" });
    return "completed";
  }
  if (
    (name === "clear" || name === "compact") &&
    !requireChatSessionAction(host, name === "clear" ? "reset" : "compact")
  ) {
    return "failed";
  }
  const target = captureChatCommandTarget(host);
  const { client, connectionEpoch, sessionKey, currentSessionId } = host;
  const isCurrent = () =>
    host.client === client &&
    host.connectionEpoch === connectionEpoch &&
    host.currentSessionId === currentSessionId &&
    (target ? isChatCommandTargetCurrent(host, target) : host.sessionKey === sessionKey);
  const runId = target && (name === "steer" || name === "redirect") ? generateUUID() : undefined;
  const request =
    target && runId
      ? chatOutboxOwner(host).admissions.beginRequest(
          host,
          resolveUiConversationIdentity(host, target.sessionKey, target.agentId),
          runId,
        )
      : undefined;
  let runtimeOwnsRequest = false;
  try {
    const { dispatchCapturedChatSlashCommand } = await import("./chat-command-dispatch.runtime.ts");
    if (!isCurrent() || request?.signal.aborted) {
      return "cancelled";
    }
    runtimeOwnsRequest = true;
    return await dispatchCapturedChatSlashCommand(
      host,
      name,
      args,
      attachments,
      target,
      isCurrent,
      runId,
      request,
    );
  } catch (error) {
    if (isCurrent()) {
      setChatError(host, formatUiError(error));
    }
    return "failed";
  } finally {
    if (!runtimeOwnsRequest) {
      request?.release();
    }
  }
}
