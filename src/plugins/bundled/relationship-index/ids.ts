import path from "node:path";
import { createEntityId, type EntityId } from "../../../sre/contracts/entity.js";

function normalizeString(value: string | number | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function createMessageEntityId(params: {
  channelId: string;
  conversationId?: string;
  messageId?: string;
}): EntityId | undefined {
  const messageId = normalizeString(params.messageId);
  if (!messageId) {
    return undefined;
  }
  return createEntityId(
    "message",
    params.channelId,
    normalizeString(params.conversationId) ?? "conversation:unknown",
    messageId,
  );
}

export function createThreadEntityId(params: {
  channelId: string;
  conversationId?: string;
  threadId?: string | number;
}): EntityId | undefined {
  const threadId = normalizeString(params.threadId);
  if (!threadId) {
    return undefined;
  }
  return createEntityId(
    "thread",
    params.channelId,
    normalizeString(params.conversationId) ?? "conversation:unknown",
    threadId,
  );
}

export function createToolCallEntityId(params: {
  runId?: string;
  sessionKey?: string;
  toolCallId?: string;
  toolName: string;
}): EntityId {
  return createEntityId(
    "tool_call",
    normalizeString(params.toolCallId) ?? "tool-call:unknown",
    normalizeString(params.runId) ?? normalizeString(params.sessionKey) ?? "session:unknown",
    params.toolName,
  );
}

export function createArtifactEntityId(params: {
  toolName: string;
  toolCallId?: string;
  runId?: string;
  kind: "error" | "result";
}): EntityId {
  return createEntityId(
    "artifact",
    params.kind,
    params.toolName,
    normalizeString(params.toolCallId) ?? normalizeString(params.runId) ?? "result:unknown",
  );
}

export function createSessionEntityId(sessionKey: string | undefined): EntityId | undefined {
  const normalized = normalizeString(sessionKey);
  return normalized ? createEntityId("session", normalized) : undefined;
}

export function createWorkdirEntityId(workspaceDir: string | undefined): EntityId | undefined {
  const normalized = normalizeString(workspaceDir);
  return normalized ? createEntityId("workdir", path.resolve(normalized)) : undefined;
}

export function createRepoEntityId(params: {
  workspaceDir?: string;
  repoRoot?: string;
}): EntityId | undefined {
  const workspaceDir = normalizeString(params.workspaceDir);
  const repoRoot = normalizeString(params.repoRoot);
  if (!workspaceDir || !repoRoot) {
    return undefined;
  }
  const resolvedWorkspace = path.resolve(workspaceDir);
  const resolvedRoot = path.resolve(repoRoot);
  const relative = path.relative(resolvedRoot, resolvedWorkspace);
  if (!relative || relative.startsWith("..")) {
    return undefined;
  }
  const [repoId] = relative.split(path.sep);
  return repoId ? createEntityId("github_repo", repoId) : undefined;
}

export function normalizeEntityId(value: string | undefined): EntityId | undefined {
  const normalized = normalizeString(value);
  return normalized ? normalized : undefined;
}
