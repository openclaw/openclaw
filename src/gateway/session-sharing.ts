import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionSharingIdentity,
  type SessionSharingRole,
  type SessionVisibility,
} from "../../packages/gateway-protocol/src/index.js";
import {
  isSessionMember,
  resolveAllAgentSessionStoreTargetsSync,
  type SessionEntry,
} from "../config/sessions.js";
import { listSessionEntries } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { verifyBoardViewTicket } from "./board-view-ticket.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import {
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils.js";

const ADMIN_SCOPE = "operator.admin";
const SNAPSHOT_CACHE_LIMIT = 2_048;

type SessionCreatorCarrier = {
  createdBy?: unknown;
};

export type SessionSharingTarget = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  storePath: string;
};

type SessionSharingSnapshot = {
  creatorId?: string;
  visibility: SessionVisibility;
};

type SessionMutationTarget = {
  sessionKey: string;
  agentId?: string;
};

const sharingSnapshotCache = new Map<string, SessionSharingSnapshot>();
const sharingSnapshotAliases = new Map<string, string>();

export function resolveSessionVisibility(
  entry: Pick<SessionEntry, "visibility">,
): SessionVisibility {
  return entry.visibility ?? "shared";
}

/** Reads W1's additive creator contract without defining or stamping it in this phase. */
export function resolveSessionCreator(entry: object): SessionSharingIdentity | null {
  const value = (entry as SessionCreatorCarrier).createdBy;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as { id?: unknown; label?: unknown };
  const id = normalizeOptionalString(record.id);
  if (!id) {
    return null;
  }
  const label = normalizeOptionalString(record.label);
  return { id, ...(label ? { label } : {}) };
}

export function resolveGatewayConnectionIdentity(
  client: Pick<
    GatewayClient,
    "authenticatedUserId" | "authenticatedUserProfile" | "connect"
  > | null,
): SessionSharingIdentity | null {
  const authenticatedUserId = normalizeOptionalString(client?.authenticatedUserId);
  if (authenticatedUserId) {
    const label = normalizeOptionalString(client?.authenticatedUserProfile?.displayName);
    return { id: authenticatedUserId, ...(label ? { label } : {}) };
  }
  if (!client?.connect.device) {
    return null;
  }
  const deviceLabel = normalizeOptionalString(client.connect.client.displayName);
  const id = normalizeOptionalString(client.connect.device.id);
  return id ? { id, ...(deviceLabel ? { label: deviceLabel } : {}) } : null;
}

export function isGatewayAdmin(client: Pick<GatewayClient, "connect"> | null): boolean {
  return client?.connect.scopes?.includes(ADMIN_SCOPE) === true;
}

export function allowedSessionVisibilities(cfg: OpenClawConfig): SessionVisibility[] {
  const policy = cfg.session?.sharing;
  return [
    "shared",
    ...(policy?.readOnly === false ? [] : (["read-only"] as const)),
    ...(policy?.suggest === false ? [] : (["suggest"] as const)),
    ...(policy?.drafts === false ? [] : (["draft"] as const)),
  ];
}

export function isSessionVisibilityAllowed(
  cfg: OpenClawConfig,
  visibility: SessionVisibility,
): boolean {
  return allowedSessionVisibilities(cfg).includes(visibility);
}

export function resolveSessionSharingTarget(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): SessionSharingTarget | null {
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg: params.cfg,
    key: params.sessionKey,
    agentId: params.agentId,
  });
  const entry = resolveFreshestSessionEntryFromStoreKeys(target.store, target.storeKeys);
  return entry
    ? {
        agentId: target.agentId,
        canonicalKey: target.canonicalKey,
        entry,
        storePath: target.storePath,
      }
    : null;
}

export function resolveSessionSharingRole(params: {
  client: GatewayClient | null;
  target: SessionSharingTarget;
  includeMembership?: boolean;
}): SessionSharingRole {
  if (isGatewayAdmin(params.client)) {
    return "admin";
  }
  const identity = resolveGatewayConnectionIdentity(params.client);
  // Shared-secret/no-auth solo deployments have no durable person identity.
  if (!identity) {
    return "owner";
  }
  if (resolveSessionCreator(params.target.entry)?.id === identity.id) {
    return "owner";
  }
  if (params.includeMembership === false) {
    return "viewer";
  }
  if (
    isSessionMember(
      {
        agentId: params.target.agentId,
        sessionKey: params.target.canonicalKey,
        storePath: params.target.storePath,
      },
      identity.id,
    )
  ) {
    return "member";
  }
  return "viewer";
}

export function canManageSessionSharing(role: SessionSharingRole): boolean {
  return role === "admin" || role === "owner";
}

export function canMutateSession(params: {
  role: SessionSharingRole;
  visibility: SessionVisibility;
}): boolean {
  return params.visibility === "shared" || params.role !== "viewer";
}

export function authorizeResolvedSessionMutation(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  sessionKey: string;
  agentId?: string;
}): ErrorShape | null {
  if (isGatewayAdmin(params.client)) {
    return null;
  }
  const target = resolveSessionSharingTarget(params);
  if (!target) {
    return null;
  }
  const visibility = resolveSessionVisibility(target.entry);
  const role = resolveSessionSharingRole({ client: params.client, target });
  return canMutateSession({ role, visibility })
    ? null
    : errorShape(ErrorCodes.INVALID_REQUEST, `session is ${visibility} for this connection`, {
        details: {
          code: "SESSION_PARTICIPATION_REQUIRED",
          sessionKey: params.sessionKey,
          visibility,
        },
      });
}

function readStringParam(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  return normalizeOptionalString((params as Record<string, unknown>)[key]);
}

const SESSION_KEY_PARAM_BY_METHOD = new Map<string, "key" | "sessionKey">([
  ["agent", "sessionKey"],
  ["board.event", "sessionKey"],
  ["board.update", "sessionKey"],
  ["board.widget.grant", "sessionKey"],
  ["board.widget.put", "sessionKey"],
  ["chat.abort", "sessionKey"],
  ["chat.inject", "sessionKey"],
  ["chat.send", "sessionKey"],
  ["message.action", "sessionKey"],
  ["plugins.sessionAction", "sessionKey"],
  ["send", "sessionKey"],
  ["session.discussion.open", "sessionKey"],
  ["sessions.abort", "key"],
  ["sessions.compaction.branch", "key"],
  ["sessions.compaction.restore", "key"],
  ["sessions.compact", "key"],
  ["sessions.delete", "key"],
  ["sessions.dispatch", "key"],
  ["sessions.files.set", "sessionKey"],
  ["sessions.fork", "key"],
  ["sessions.patch", "key"],
  ["sessions.pluginPatch", "key"],
  ["sessions.reclaim", "key"],
  ["sessions.reset", "key"],
  ["sessions.rewind", "key"],
  ["sessions.send", "key"],
  ["sessions.steer", "key"],
  ["sessions.branches.switch", "key"],
  ["tools.invoke", "sessionKey"],
]);

const REQUIRED_SESSION_TARGET_METHODS = new Set([
  "board.action",
  "board.event",
  "board.update",
  "board.widget.grant",
  "board.widget.put",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "session.discussion.open",
  "sessions.abort",
  "sessions.branches.switch",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.delete",
  "sessions.dispatch",
  "sessions.files.set",
  "sessions.fork",
  "sessions.groups.delete",
  "sessions.groups.rename",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reclaim",
  "sessions.reset",
  "sessions.rewind",
  "sessions.send",
  "sessions.steer",
]);

function resolveSessionGroupMutationTargets(params: {
  cfg: OpenClawConfig;
  requestParams: unknown;
}): SessionMutationTarget[] | undefined {
  const groupName = readStringParam(params.requestParams, "name");
  if (!groupName) {
    return undefined;
  }
  return resolveAllAgentSessionStoreTargetsSync(params.cfg).flatMap((storeTarget) =>
    listSessionEntries({
      agentId: storeTarget.agentId,
      storePath: storeTarget.storePath,
    }).flatMap(({ sessionKey, entry }) =>
      entry.category?.trim() === groupName ? [{ sessionKey, agentId: storeTarget.agentId }] : [],
    ),
  );
}

function resolveApprovalSessionTarget(
  method: string,
  params: unknown,
  context: GatewayRequestContext,
): SessionMutationTarget | undefined {
  const id = readStringParam(params, "id");
  if (!id) {
    return undefined;
  }
  const kind = readStringParam(params, "kind");
  const manager =
    method === "plugin.approval.resolve" || kind === "plugin"
      ? context.pluginApprovalManager
      : method === "approval.resolve" && kind === "system-agent"
        ? context.systemAgentApprovalManager
        : context.execApprovalManager;
  const resolvedId = manager?.lookupApprovalId(id, { includeResolved: true });
  const recordId =
    resolvedId?.kind === "exact" || resolvedId?.kind === "prefix" ? resolvedId.id : id;
  const request = manager?.getSnapshot(recordId)?.request;
  const sessionKey = readStringParam(request, "sessionKey");
  const agentId = readStringParam(request, "agentId");
  return sessionKey
    ? {
        sessionKey,
        ...(agentId ? { agentId } : {}),
      }
    : undefined;
}

export function resolveSessionMutationTargets(params: {
  cfg: OpenClawConfig;
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
}): SessionMutationTarget[] | undefined {
  if (params.method === "sessions.groups.rename" || params.method === "sessions.groups.delete") {
    return resolveSessionGroupMutationTargets(params);
  }
  if (
    params.method === "exec.approval.resolve" ||
    params.method === "plugin.approval.resolve" ||
    params.method === "approval.resolve"
  ) {
    const target = resolveApprovalSessionTarget(
      params.method,
      params.requestParams,
      params.context,
    );
    return target ? [target] : undefined;
  }
  const field = SESSION_KEY_PARAM_BY_METHOD.get(params.method);
  const directKey = field ? readStringParam(params.requestParams, field) : undefined;
  if (!directKey && (params.method === "board.event" || params.method === "board.action")) {
    const ticket = readStringParam(params.requestParams, "ticket");
    const sessionKey = ticket ? verifyBoardViewTicket(ticket)?.sessionKey : undefined;
    return sessionKey ? [{ sessionKey }] : undefined;
  }
  if (directKey || params.method !== "sessions.abort") {
    const agentId = readStringParam(params.requestParams, "agentId");
    return directKey
      ? [
          {
            sessionKey: directKey,
            ...(agentId ? { agentId } : {}),
          },
        ]
      : undefined;
  }
  const runId = readStringParam(params.requestParams, "runId");
  const run = runId ? params.context.chatAbortControllers.get(runId) : undefined;
  return run
    ? [{ sessionKey: run.sessionKey, ...(run.agentId ? { agentId: run.agentId } : {}) }]
    : undefined;
}

export function resolveSessionMutationTarget(params: {
  cfg: OpenClawConfig;
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
}): SessionMutationTarget | undefined {
  return resolveSessionMutationTargets(params)?.[0];
}

export function authorizeSessionMutation(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
}): ErrorShape | null {
  if (isGatewayAdmin(params.client)) {
    return null;
  }
  const targetRefs = resolveSessionMutationTargets(params);
  if (!targetRefs) {
    if (REQUIRED_SESSION_TARGET_METHODS.has(params.method)) {
      return errorShape(ErrorCodes.INVALID_REQUEST, "session mutation target is unavailable", {
        details: { code: "SESSION_MUTATION_TARGET_REQUIRED", method: params.method },
      });
    }
    return null;
  }
  for (const targetRef of targetRefs) {
    const error = authorizeResolvedSessionMutation({
      cfg: params.cfg,
      client: params.client,
      sessionKey: targetRef.sessionKey,
      agentId: targetRef.agentId,
    });
    if (error) {
      return error;
    }
  }
  return null;
}

function sharingSnapshotKey(sessionKey: string, agentId?: string): string {
  return `${agentId ?? ""}\0${sessionKey}`;
}

function rememberSharingSnapshot(key: string, snapshot: SessionSharingSnapshot): void {
  sharingSnapshotCache.delete(key);
  sharingSnapshotCache.set(key, snapshot);
  if (sharingSnapshotCache.size <= SNAPSHOT_CACHE_LIMIT) {
    return;
  }
  const oldest = sharingSnapshotCache.keys().next().value;
  if (oldest) {
    sharingSnapshotCache.delete(oldest);
    for (const [alias, canonical] of sharingSnapshotAliases) {
      if (canonical === oldest) {
        sharingSnapshotAliases.delete(alias);
      }
    }
  }
}

function rememberSharingSnapshotAlias(alias: string, canonical: string): void {
  sharingSnapshotAliases.delete(alias);
  sharingSnapshotAliases.set(alias, canonical);
  if (sharingSnapshotAliases.size <= SNAPSHOT_CACHE_LIMIT * 2) {
    return;
  }
  const oldest = sharingSnapshotAliases.keys().next().value;
  if (oldest) {
    sharingSnapshotAliases.delete(oldest);
  }
}

export function invalidateSessionSharingSnapshot(sessionKey?: string): void {
  if (sessionKey) {
    const matchingCanonicalKeys = new Set<string>();
    for (const key of sharingSnapshotCache.keys()) {
      if (key.endsWith(`\0${sessionKey}`)) {
        matchingCanonicalKeys.add(key);
      }
    }
    for (const [alias, canonical] of sharingSnapshotAliases) {
      if (alias.endsWith(`\0${sessionKey}`) || canonical.endsWith(`\0${sessionKey}`)) {
        matchingCanonicalKeys.add(canonical);
      }
    }
    for (const key of matchingCanonicalKeys) {
      sharingSnapshotCache.delete(key);
    }
    for (const [alias, canonical] of sharingSnapshotAliases) {
      if (matchingCanonicalKeys.has(canonical)) {
        sharingSnapshotAliases.delete(alias);
      }
    }
    return;
  }
  sharingSnapshotCache.clear();
  sharingSnapshotAliases.clear();
}

function loadSharingSnapshot(
  cfg: OpenClawConfig,
  sessionKey: string,
  agentId?: string,
): SessionSharingSnapshot {
  const requestedKey = sharingSnapshotKey(sessionKey, agentId);
  const aliasedKey = sharingSnapshotAliases.get(requestedKey);
  const cached = sharingSnapshotCache.get(aliasedKey ?? requestedKey);
  if (cached) {
    return cached;
  }
  const target = resolveSessionSharingTarget({ cfg, sessionKey, agentId });
  const canonicalKey = target
    ? sharingSnapshotKey(target.canonicalKey, target.agentId)
    : requestedKey;
  const canonicalCached = sharingSnapshotCache.get(canonicalKey);
  if (canonicalCached) {
    rememberSharingSnapshotAlias(requestedKey, canonicalKey);
    return canonicalCached;
  }
  const snapshot = {
    // Missing rows occur after deletion. Fail closed here; the delete path also
    // emits an unscoped catalog invalidation so identified readers still refresh.
    visibility: target ? resolveSessionVisibility(target.entry) : "draft",
    ...(target ? { creatorId: resolveSessionCreator(target.entry)?.id } : {}),
  } satisfies SessionSharingSnapshot;
  rememberSharingSnapshot(canonicalKey, snapshot);
  rememberSharingSnapshotAlias(requestedKey, canonicalKey);
  return snapshot;
}

export function canReceiveSessionEvent(params: {
  cfg: OpenClawConfig;
  client: GatewayWsClient;
  sessionKeys: readonly string[];
  agentId?: string;
}): boolean {
  if (isGatewayAdmin(params.client)) {
    return true;
  }
  const identity = resolveGatewayConnectionIdentity(params.client);
  if (!identity) {
    return true;
  }
  return params.sessionKeys.every((sessionKey) => {
    const snapshot = loadSharingSnapshot(params.cfg, sessionKey, params.agentId);
    return snapshot.visibility !== "draft" || snapshot.creatorId === identity.id;
  });
}

export function filterDraftSessionsForClient(params: {
  client: GatewayClient | null;
  store: Record<string, SessionEntry>;
}): Record<string, SessionEntry> {
  const identity = resolveGatewayConnectionIdentity(params.client);
  if (isGatewayAdmin(params.client) || !identity) {
    return params.store;
  }
  return Object.fromEntries(
    Object.entries(params.store).filter(([, entry]) => {
      return (
        resolveSessionVisibility(entry) !== "draft" ||
        resolveSessionCreator(entry)?.id === identity.id
      );
    }),
  );
}
