// Physical target resolution is shared by readers and writers; it never admits a writer.
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  resolveExplicitIncognitoAgentSqliteTarget,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteAgentId,
  resolveSqliteSessionKey,
  type ResolvedSqliteReadScope,
  type ResolvedSqliteScope,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope-helpers.js";
import {
  resolveSqliteTargetFromSessionStorePath,
  type ResolvedSqliteStoreTarget,
} from "./session-sqlite-target.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

export type SessionSqliteTargetResolutionCache = Map<
  NodeJS.ProcessEnv | undefined,
  Map<string, ReturnType<typeof resolveSqliteTargetFromSessionStorePath>>
>;

export type SqliteScopeInput = Pick<
  SessionTranscriptReadScope,
  "agentId" | "defaultAgentId" | "env" | "sessionKey" | "storePath"
>;

export function resolveSqliteDatabaseScopeIdentity(scope: SqliteScopeInput) {
  const parsedAgentId = parseAgentSessionKey(scope.sessionKey)?.agentId;
  const scopedAgentId = scope.agentId ? normalizeAgentId(scope.agentId) : parsedAgentId;
  const incognitoAgentId = isIncognitoSessionKey(scope.sessionKey)
    ? resolveAgentIdFromSessionKey(scope.sessionKey)
    : undefined;
  const explicitIncognito = resolveExplicitIncognitoAgentSqliteTarget(scope.storePath, {
    agentId: incognitoAgentId ?? scopedAgentId,
    env: scope.env,
  });
  if (explicitIncognito) {
    return {
      effectiveAgentId: explicitIncognito.agentId,
      effectiveStorePath: explicitIncognito.path,
      effectiveEnv: explicitIncognito.env,
      explicitIncognito,
    };
  }
  const effectiveStorePath = incognitoAgentId
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: incognitoAgentId, env: scope.env })
    : scope.storePath;
  const effectiveAgentId = incognitoAgentId ?? scopedAgentId;
  return { effectiveAgentId, effectiveStorePath, effectiveEnv: scope.env };
}

function resolveSqliteDatabaseScope(
  scope: SqliteScopeInput,
  targetCache?: SessionSqliteTargetResolutionCache,
  preparedStoreTarget?: ResolvedSqliteStoreTarget,
) {
  const { effectiveAgentId, effectiveStorePath, effectiveEnv, explicitIncognito } =
    resolveSqliteDatabaseScopeIdentity(scope);
  const storeTarget: ResolvedSqliteStoreTarget | undefined =
    explicitIncognito ??
    preparedStoreTarget ??
    (effectiveStorePath
      ? resolveCachedSqliteStoreTarget(
          {
            agentId: effectiveAgentId,
            defaultAgentId: scope.defaultAgentId,
            env: effectiveEnv,
            storePath: effectiveStorePath,
          },
          targetCache,
        )
      : undefined);
  const agentId = resolveSqliteAgentId({
    scopedAgentId: effectiveAgentId,
    sessionKey: scope.sessionKey,
    storeAgentId: storeTarget?.agentId,
    storeShared: storeTarget?.shared,
  });
  return {
    agentId,
    ...(storeTarget?.shared && storeTarget.agentId ? { databaseAgentId: storeTarget.agentId } : {}),
    ...(effectiveEnv ? { env: effectiveEnv } : {}),
    ...(effectiveStorePath ? { ownerStorePath: effectiveStorePath } : {}),
    ...(storeTarget ? { path: storeTarget.path } : {}),
  };
}

export function resolveSqliteScope(
  scope: SqliteScopeInput & { sessionKey: string },
  targetCache?: SessionSqliteTargetResolutionCache,
  preparedStoreTarget?: ResolvedSqliteStoreTarget,
): ResolvedSqliteScope {
  const { agentId, ...database } = resolveSqliteDatabaseScope(
    scope,
    targetCache,
    preparedStoreTarget,
  );
  if (!agentId) {
    throw new Error("Cannot resolve SQLite session scope without an agent id");
  }
  return { agentId, ...database, sessionKey: resolveSqliteSessionKey(scope.sessionKey, agentId) };
}

export function resolveSqliteReadScope(
  scope: SqliteScopeInput,
  targetCache?: SessionSqliteTargetResolutionCache,
  preparedStoreTarget?: ResolvedSqliteStoreTarget,
): ResolvedSqliteReadScope {
  const sessionKey = scope.sessionKey ? normalizeStoreSessionKey(scope.sessionKey) : undefined;
  const { agentId, ...database } = resolveSqliteDatabaseScope(
    { ...scope, sessionKey },
    targetCache,
    preparedStoreTarget,
  );
  if (!agentId) {
    throw new Error("Cannot resolve SQLite transcript read scope without an agent id");
  }
  return { agentId, ...database, ...(sessionKey ? { sessionKey } : {}) };
}

function resolveCachedSqliteStoreTarget(
  params: {
    agentId?: string;
    defaultAgentId?: string;
    env?: NodeJS.ProcessEnv;
    storePath: string;
  },
  targetCache: SessionSqliteTargetResolutionCache | undefined,
): ReturnType<typeof resolveSqliteTargetFromSessionStorePath> {
  // Store ownership is stable for this batch. Scope the cache to the caller so later requests
  // still observe owner changes after migration, install, or doctor flows.
  const envCache = targetCache && (targetCache.get(params.env) ?? new Map());
  if (envCache) {
    targetCache?.set(params.env, envCache);
  }
  const cacheKey = envCache
    ? JSON.stringify([params.storePath, params.agentId, params.defaultAgentId])
    : "";
  const cached = envCache?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const resolved = resolveSqliteTargetFromSessionStorePath(params.storePath, {
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    ...(params.env ? { env: params.env } : {}),
  });
  envCache?.set(cacheKey, resolved);
  return resolved;
}

export function resolveSqliteStoreScope(
  storePath: string,
  options: { agentId?: string } = {},
): ResolvedSqliteScope {
  return resolveSqliteScope({
    ...(options.agentId ? { agentId: options.agentId } : {}),
    sessionKey: "",
    storePath,
  });
}

export function resolveSqliteTranscriptReadScope(
  scope: Pick<
    SessionTranscriptReadScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
  targetCache?: SessionSqliteTargetResolutionCache,
): ResolvedTranscriptReadScope {
  return {
    ...resolveSqliteReadScope(scope, targetCache),
    sessionId: scope.sessionId,
  };
}
