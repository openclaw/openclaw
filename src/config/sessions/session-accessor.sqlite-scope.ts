// Scope resolution and query helpers must not acquire the writable database graph.
// Write execution lives in sqlite-write-scope so transcript readers stay read-only.
import { isMainThread } from "node:worker_threads";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  resolveExplicitIncognitoAgentSqliteTarget,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import { formatSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import { resolveSessionArtifactDirectory } from "./paths.js";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptWriteScope,
} from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteAgentId,
  resolveSqliteSessionKey,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
  type ResolvedSqliteScope,
  type ResolvedTranscriptReadScope,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionEntryReadSource } from "./session-entry-read-source.types.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import {
  prepareSqliteTargetFromSessionStorePath,
  resolveSqliteTargetFromSessionStorePath,
  type ResolvedSqliteStoreTarget,
} from "./session-sqlite-target.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { InternalSessionEntry } from "./types.js";

export {
  getSessionKysely,
  resolveSqliteAgentId,
  resolveSqliteSessionKey,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
  type ResolvedSqliteScope,
  type ResolvedTranscriptReadScope,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope-helpers.js";

export type SessionSqliteTargetResolutionCache = Map<
  NodeJS.ProcessEnv | undefined,
  Map<string, ReturnType<typeof resolveSqliteTargetFromSessionStorePath>>
>;

/** Checks the freshly read identity and lifecycle before a synchronous transcript mutation. */
export function transcriptWriteScopeIsCurrent(
  entry:
    | Pick<InternalSessionEntry, "sessionId" | "activeWriterRunId" | "lifecycleRevision">
    | undefined,
  sessionId: string,
  scope: SessionTranscriptWriteScope,
): boolean {
  return (
    entry !== undefined &&
    entry.sessionId === sessionId &&
    (scope.expectedOwner === undefined ||
      (entry.lifecycleRevision === scope.expectedOwner.lifecycleRevision &&
        entry.activeWriterRunId === scope.expectedOwner.activeWriterRunId)) &&
    (scope.expectedLifecycleRevision === undefined ||
      entry.lifecycleRevision === scope.expectedLifecycleRevision) &&
    (scope.expectedWriterRunId === undefined ||
      entry.activeWriterRunId === scope.expectedWriterRunId)
  );
}

type SqliteScopeInput = Pick<
  SessionTranscriptReadScope,
  "agentId" | "defaultAgentId" | "env" | "sessionKey" | "storePath"
>;

function resolveSqliteDatabaseScopeIdentity(scope: SqliteScopeInput) {
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

export function resolveSqliteTranscriptArchiveDirectory(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "ownerStorePath" | "path">,
): string {
  // Pinning the native database must not move artifacts away from its configured selector.
  const storePath =
    scope.ownerStorePath ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
  return resolveSessionArtifactDirectory(storePath);
}

/** Validate prepared write identity without resolving or reopening its physical target. */
export function assertSqliteTranscriptWriteIdentity<
  T extends Pick<SessionTranscriptWriteScope, "sessionId" | "sessionKey">,
>(scope: T): asserts scope is T & { sessionId: string; sessionKey: string } {
  if (typeof scope.sessionId !== "string" || !scope.sessionId) {
    throw new Error(
      `Cannot resolve SQLite transcript scope without a session id: ${scope.sessionKey}`,
    );
  }
  if (typeof scope.sessionKey !== "string" || !scope.sessionKey) {
    throw new Error(
      `Cannot resolve SQLite transcript scope without a session key: ${scope.sessionId}`,
    );
  }
}

export function resolveSqliteTranscriptScope(
  scope: Pick<
    SessionTranscriptWriteScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
  readSource?: SessionEntryReadSource,
): ResolvedTranscriptScope {
  assertSqliteTranscriptWriteIdentity(scope);
  return {
    ...resolveSqliteScope(
      { ...scope, sessionKey: scope.sessionKey },
      undefined,
      readSource ? { ...readSource, shared: true } : undefined,
    ),
    sessionId: scope.sessionId,
  };
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

/** Prepare file ownership once; the history resource and its kernel consume this same scope. */
export async function prepareSqliteTranscriptReadScope(
  scope: SessionTranscriptReadScope,
  signal?: AbortSignal,
): Promise<ResolvedTranscriptReadScope> {
  const readScope = {
    ...scope,
    sessionKey: scope.sessionKey ? normalizeStoreSessionKey(scope.sessionKey) : undefined,
  };
  if (isIncognitoSessionKey(readScope.sessionKey)) {
    return resolveSqliteTranscriptReadScope(readScope);
  }
  const { getOwnedSessionTranscriptReader } = await import("./transcript-write-context.js");
  const reader = getOwnedSessionTranscriptReader(readScope);
  if (reader) {
    return {
      agentId: reader.logicalAgentId,
      databaseAgentId: reader.database.agentId,
      path: reader.database.path,
      ownerStorePath: readScope.storePath,
      env: reader.database.env,
      sessionKey: reader.sessionKey,
      sessionId: readScope.sessionId,
    };
  }
  const target = await prepareSqliteScopeTarget(readScope, signal);
  return {
    ...resolveSqliteReadScope(readScope, undefined, target),
    sessionId: readScope.sessionId,
  };
}

/** Exact locators can reserve their FIFO before worker-owned schema-owner discovery. */
export function resolveSqliteWriteAdmissionScope(
  scope: SqliteScopeInput & { sessionKey: string },
): (ResolvedSqliteReadScope & { path: string; shared?: boolean }) | undefined {
  const { effectiveAgentId, effectiveStorePath, effectiveEnv, explicitIncognito } =
    resolveSqliteDatabaseScopeIdentity(scope);
  const target: ResolvedSqliteStoreTarget | undefined = effectiveStorePath
    ? (explicitIncognito ?? resolveUnsuffixedSqliteTargetFromSessionStorePath(effectiveStorePath))
    : undefined;
  // Custom logical stores may select a persisted suffix; do not reserve the wrong file.
  if (target && !target.agentId && !target.shared) {
    return undefined;
  }
  // This names only the physical queue, not schema authority. Worker preparation
  // supplies the actual logical and database owners before reading or committing.
  const agentId = effectiveAgentId ?? target?.agentId ?? normalizeAgentId(scope.defaultAgentId);
  return {
    agentId,
    env: effectiveEnv,
    path: target?.path ?? resolveOpenClawAgentSqlitePath({ agentId, env: effectiveEnv }),
    ...(target?.shared ? { shared: true } : {}),
  };
}

/** Resolve custom physical ownership in the existing read worker. */
export async function prepareSqliteScope(
  scope: SqliteScopeInput & { sessionKey: string },
): Promise<ResolvedSqliteScope> {
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const captured = { ...scope, env };
  return resolveSqliteScope(captured, undefined, await prepareSqliteScopeTarget(captured));
}

/** Canonical writers must enter their existing FIFO before the first asynchronous yield. */
export function withPreparedSqliteScope<T>(
  scope: SqliteScopeInput & { sessionKey: string },
  run: (resolved: ResolvedSqliteScope) => T | Promise<T>,
): T | Promise<T> {
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const captured = { ...scope, env };
  if (!isMainThread) {
    return run(resolveSqliteScope(captured));
  }
  const { effectiveStorePath, explicitIncognito } = resolveSqliteDatabaseScopeIdentity(captured);
  const target = effectiveStorePath
    ? (explicitIncognito ?? resolveUnsuffixedSqliteTargetFromSessionStorePath(effectiveStorePath))
    : undefined;
  if (!effectiveStorePath || target?.agentId) {
    return run(resolveSqliteScope(captured, undefined, target));
  }
  // Shared and custom locators need worker-owned discovery; the resolved writer owns admission.
  return prepareSqliteScopeTarget(captured).then((prepared) =>
    run(resolveSqliteScope(captured, undefined, prepared)),
  );
}

async function prepareSqliteScopeTarget(scope: SqliteScopeInput, signal?: AbortSignal) {
  const { effectiveAgentId, effectiveStorePath, explicitIncognito } =
    resolveSqliteDatabaseScopeIdentity(scope);
  if (explicitIncognito) {
    return explicitIncognito;
  }
  if (isIncognitoSessionKey(scope.sessionKey)) {
    return undefined;
  }
  return effectiveStorePath
    ? await prepareSqliteTargetFromSessionStorePath(
        effectiveStorePath,
        {
          agentId: effectiveAgentId,
          defaultAgentId: scope.defaultAgentId,
          env: scope.env,
        },
        signal,
      )
    : undefined;
}

/** Pin the environment and database locator before lifecycle work yields. */
export function captureLifecycleDatabaseScope<T extends ResolvedSqliteReadScope>(
  scope: T,
): T & { env: NodeJS.ProcessEnv; path: string } {
  const env = { ...(scope.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  return {
    ...scope,
    env,
    path: resolveOpenClawAgentSqlitePath(toDatabaseOptions({ ...scope, env })),
  };
}

/** Legacy identity string retained only for transcript artifact metadata and plugin contracts. */
export function formatLegacySqliteSessionMarkerForScope(scope: ResolvedTranscriptScope): string {
  return formatSqliteSessionFileMarker({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    storePath: scope.path ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope)),
  });
}
