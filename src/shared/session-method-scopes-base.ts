import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isIncognitoSessionKey } from "./incognito-session-key.js";

export type SessionMutationOperatorScope = "operator.write" | "operator.admin";
export type SessionOperatorScope = "operator.sessions.read" | "operator.sessions.write";

const SESSION_READ_METHODS: ReadonlySet<string> = new Set([
  "agent.identity.get",
  "agents.list",
  "models.list",
  "progressCard.get",
  "projects.list",
  "session.suggestions.list",
  "sessions.groups.list",
  "sessions.list",
  "sessions.subscribe",
  "sessions.messages.subscribe",
  "sessions.messages.unsubscribe",
  "sessions.viewers.set",
  "sessions.preview",
  "sessions.describe",
  "sessions.branches.list",
  "sessions.get",
  "sessions.resolve",
  "sessions.search",
  "sessions.files.list",
  "sessions.files.get",
  "sessions.setInvolvement",
  "chat.history",
  "chat.startup",
  "chat.metadata",
  "chat.message.get",
  "session.members.list",
  "session.members.listEvidence",
  "themes.get",
  "themes.list",
  "users.prefs.get",
  "users.self",
]);

const SESSION_WRITE_METHODS: ReadonlySet<string> = new Set([
  "question.request",
  "question.waitAnswer",
  "question.resolve",
  "question.get",
  "question.list",
  "chat.send",
  "chat.abort",
  "sessions.create",
  "sessions.patch",
  "sessions.patchMany",
  "sessions.fork",
  "sessions.recover",
  "sessions.send",
  "sessions.steer",
  "sessions.abort",
  "sessions.goal.update",
  "sessions.goal.clear",
]);

/** Admission only: reads retain sharing policy; mutation owners must bind the caller's own row. */
export function resolveSessionMethodScope(
  method: string,
  params?: unknown,
): SessionOperatorScope | undefined {
  if (SESSION_READ_METHODS.has(method)) {
    return "operator.sessions.read";
  }
  if (
    SESSION_WRITE_METHODS.has(method) &&
    resolveBaseSessionMutationRequiredScope(method, params) !== "operator.admin"
  ) {
    return "operator.sessions.write";
  }
  return undefined;
}

const SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS: ReadonlySet<string> = new Set([
  "label",
  "autoLabel",
  "icon",
  "color",
  "category",
  "boardFace",
  "boardPresentation",
  "pinned",
  "archived",
  "unread",
  "model",
  "agentRuntime",
  "thinkingLevel",
  "fastMode",
  "permissionMode",
]);

const SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "agentId",
  "expectedSessionId",
  "expectedLifecycleRevision",
  "expectedPermissionMode",
  "expectedMarkedUnreadAt",
]);

const SESSIONS_DELETE_WRITE_SCOPE_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "agentId",
  "deleteTranscript",
  "expectedSessionId",
  "archivedOnly",
]);

function resolveSessionsPatchRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params)) {
    return "operator.write";
  }
  if (params.permissionMode === "full" || Object.hasOwn(params, "sandboxMode")) {
    return "operator.admin";
  }
  return Object.keys(params).every(
    (key) =>
      SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS.has(key) ||
      SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS.has(key),
  )
    ? "operator.write"
    : "operator.admin";
}

function resolveSessionsPatchManyRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params) || !isRecord(params.patch)) {
    return "operator.write";
  }
  if (params.patch.permissionMode === "full" || Object.hasOwn(params.patch, "sandboxMode")) {
    return "operator.admin";
  }
  return Object.keys(params.patch).every((key) => SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS.has(key))
    ? "operator.write"
    : "operator.admin";
}

function resolveSessionsCreateRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params)) {
    return "operator.write";
  }
  if (
    params.incognito === true ||
    (typeof params.key === "string" && isIncognitoSessionKey(params.key)) ||
    (typeof params.parentSessionKey === "string" &&
      isIncognitoSessionKey(params.parentSessionKey)) ||
    Object.hasOwn(params, "execNode") ||
    Object.hasOwn(params, "toolOverrides") ||
    params.permissionMode === "full"
  ) {
    return "operator.admin";
  }
  return "operator.write";
}

function resolveSessionsDeleteRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params) || params.archivedOnly !== true) {
    return "operator.admin";
  }
  return Object.keys(params).every((key) => SESSIONS_DELETE_WRITE_SCOPE_FIELDS.has(key))
    ? "operator.write"
    : "operator.admin";
}

/** Browser-safe session mutation policy for methods without protocol validation. */
export function resolveBaseSessionMutationRequiredScope(
  method: string,
  params?: unknown,
): SessionMutationOperatorScope | undefined {
  if (method === "sessions.recover") {
    return "operator.write";
  }
  if (method === "sessions.create") {
    return resolveSessionsCreateRequiredScope(params);
  }
  if (method === "sessions.patch") {
    return resolveSessionsPatchRequiredScope(params);
  }
  if (method === "sessions.patchMany") {
    return resolveSessionsPatchManyRequiredScope(params);
  }
  if (method === "sessions.delete") {
    return resolveSessionsDeleteRequiredScope(params);
  }
  return undefined;
}
