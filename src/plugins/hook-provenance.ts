import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createEntityId } from "../sre/contracts/entity.js";

export type HookProvenanceFields = {
  entityId?: string;
  parentEntityId?: string;
  sourceRefs?: string[];
  derivedFrom?: string[];
  confidence?: number;
};

function normalizeRef(value: string | number | undefined | null): string | undefined {
  if (value == null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

export function normalizeRefs(
  values: Array<string | number | undefined | null>,
): string[] | undefined {
  const refs = Array.from(
    new Set(
      values
        .map((value) => normalizeRef(value))
        .filter((value): value is string => typeof value === "string"),
    ),
  );
  return refs.length > 0 ? refs : undefined;
}

export function createSessionEntityId(sessionKey: string | undefined): string | undefined {
  const normalized = normalizeRef(sessionKey);
  return normalized ? createEntityId("session", normalized) : undefined;
}

export function createThreadEntityId(params: {
  explicitThreadEntityId?: string;
  channelId?: string;
  conversationId?: string;
  threadId?: string | number;
}): string | undefined {
  const explicit = normalizeRef(params.explicitThreadEntityId);
  if (explicit) {
    return explicit;
  }
  const channelId = normalizeRef(params.channelId);
  const threadId = normalizeRef(params.threadId);
  if (!channelId || !threadId) {
    return undefined;
  }
  return createEntityId(
    "thread",
    channelId,
    normalizeRef(params.conversationId) ?? "conversation",
    threadId,
  );
}

export function createMessageEntityId(params: {
  channelId?: string;
  messageId?: string;
  from?: string;
  content?: string;
  timestamp?: number;
}): string | undefined {
  const channelId = normalizeRef(params.channelId);
  if (!channelId) {
    return undefined;
  }
  const messageId = normalizeRef(params.messageId);
  if (messageId) {
    return createEntityId("message", channelId, messageId);
  }
  const from = normalizeRef(params.from);
  const content = normalizeRef(params.content);
  if (!from || !content) {
    return undefined;
  }
  return createEntityId(
    "message",
    channelId,
    from,
    content,
    normalizeRef(params.timestamp) ?? "no-ts",
  );
}

export function createToolCallEntityId(params: {
  toolName?: string;
  toolCallId?: string;
  runId?: string;
  sessionKey?: string;
}): string | undefined {
  const toolName = normalizeRef(params.toolName);
  if (!toolName) {
    return undefined;
  }
  return createEntityId(
    "tool_call",
    toolName,
    normalizeRef(params.toolCallId) ?? "no-call-id",
    normalizeRef(params.runId) ?? "no-run-id",
    normalizeRef(params.sessionKey) ?? "no-session",
  );
}

export function createSubagentEntityId(params: {
  childSessionKey?: string;
  targetSessionKey?: string;
  runId?: string;
  agentId?: string;
  reason?: string;
}): string | undefined {
  const sessionKey = normalizeRef(params.childSessionKey ?? params.targetSessionKey);
  if (!sessionKey) {
    return undefined;
  }
  return createEntityId(
    "subagent",
    sessionKey,
    normalizeRef(params.runId) ?? "no-run-id",
    normalizeRef(params.agentId) ?? normalizeRef(params.reason) ?? "unknown",
  );
}

export function buildMessagePersistenceProvenance(params: {
  message: AgentMessage;
  sessionKey?: string;
  toolName?: string;
  toolCallId?: string;
  isSynthetic?: boolean;
}): HookProvenanceFields {
  const sessionEntityId = createSessionEntityId(params.sessionKey);
  const toolEntityId =
    (params.message as { role?: unknown }).role === "toolResult"
      ? createToolCallEntityId({
          toolName: params.toolName,
          toolCallId: params.toolCallId,
          sessionKey: params.sessionKey,
        })
      : undefined;
  return {
    entityId: toolEntityId ?? sessionEntityId,
    parentEntityId: toolEntityId ? sessionEntityId : undefined,
    sourceRefs: normalizeRefs([params.sessionKey, params.toolCallId, params.toolName]),
    derivedFrom: params.isSynthetic ? ["synthetic-tool-result"] : undefined,
    confidence: toolEntityId || sessionEntityId ? 1 : undefined,
  };
}
