/** Builds normalized host-owned context for authorization policy evaluation. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type {
  AuthorizationInvocationContext,
  AuthorizationPrincipal,
} from "./authorization-policy.types.js";

export function createAuthorizationPrincipal(params: {
  provider?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  senderIsOwner?: boolean;
  isAuthorizedSender?: boolean;
  roleIds?: readonly string[] | null;
  operatorScopes?: readonly string[] | null;
  operatorClientId?: string | null;
  operatorDeviceId?: string | null;
  operatorIsOwner?: boolean;
  serviceId?: string | null;
}): AuthorizationPrincipal {
  const provider = normalizeOptionalString(params.provider);
  const accountId = normalizeOptionalString(params.accountId);
  const senderId = normalizeOptionalString(params.senderId);
  if (senderId) {
    const roleIds = normalizeSortedUniqueStringEntries(params.roleIds ?? []);
    return {
      kind: "sender",
      ...(provider ? { provider } : {}),
      ...(accountId ? { accountId } : {}),
      senderId,
      ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
      ...(params.isAuthorizedSender !== undefined
        ? { isAuthorizedSender: params.isAuthorizedSender }
        : {}),
      ...(roleIds.length > 0 ? { roleIds } : {}),
    };
  }
  if (params.operatorScopes) {
    const scopes = normalizeSortedUniqueStringEntries(params.operatorScopes);
    const clientId = normalizeOptionalString(params.operatorClientId);
    const deviceId = normalizeOptionalString(params.operatorDeviceId);
    return {
      kind: "operator",
      scopes,
      ...(clientId ? { clientId } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(params.operatorIsOwner !== undefined ? { isOwner: params.operatorIsOwner } : {}),
    };
  }
  const serviceId = normalizeOptionalString(params.serviceId);
  if (serviceId) {
    return {
      kind: "service",
      serviceId,
    };
  }
  return {
    kind: "unknown",
    ...(provider ? { provider } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

export function createAuthorizationInvocationContext(params: {
  principal: AuthorizationPrincipal;
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  parentConversationId?: string | null;
  threadId?: string | number | null;
  trigger?: string | null;
}): AuthorizationInvocationContext {
  const agentId = normalizeOptionalString(params.agentId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  const runId = normalizeOptionalString(params.runId);
  const conversationId = normalizeOptionalString(params.conversationId);
  const parentConversationId = normalizeOptionalString(params.parentConversationId);
  const trigger = normalizeOptionalString(params.trigger);
  const threadId =
    typeof params.threadId === "number" && Number.isFinite(params.threadId)
      ? params.threadId
      : normalizeOptionalString(params.threadId);
  return {
    principal: params.principal,
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(parentConversationId ? { parentConversationId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(trigger ? { trigger } : {}),
  };
}

export function normalizeAuthorizationCommandSource(value: unknown): "text" | "native" | "unknown" {
  return value === "text" || value === "native" ? value : "unknown";
}
