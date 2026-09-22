import fs from "node:fs";
import path from "node:path";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { iterateSessionEntryKeys } from "./session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteTargetFromSessionStorePath,
  SessionStoreRegistryReadRequired,
  type SessionStoreRegistryRead,
} from "./session-sqlite-target.js";
import { resolvePersistedSessionStoreOwner } from "./session-store-owner.js";
import {
  assertSessionStoreReadCandidate,
  resolveCapturedSessionStorePath,
  type CapturedSessionStorePaths,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  type SessionStoreTarget,
} from "./targets-collision.js";
import {
  isPerAgentSessionStoreConfig,
  listConfiguredSessionStoreAgentIds,
  resolveExistingAgentSessionStoreTargetsSync,
} from "./targets.js";

export type SessionStoreTargetsReadResult =
  | { available: true; targets: SessionStoreTarget[] }
  | {
      available: false;
      reason: "database-missing" | "schema-missing" | "read-failed";
    };
type FixedSessionStoreReadSnapshot =
  | {
      available: true;
      databaseAgentId: string;
      databasePath: string;
      hasUnscopedRow: boolean;
      scopedAgentIds: Set<string>;
    }
  | Extract<SessionStoreTargetsReadResult, { available: false }>;
export type SessionStoreTargetsReadCache = Map<string, FixedSessionStoreReadSnapshot>;

type SessionStoreTargetsReadOptions = {
  cache?: SessionStoreTargetsReadCache;
  env?: NodeJS.ProcessEnv;
  registeredDatabases?: SessionStoreRegistryRead;
  readCandidates?: readonly SessionStoreReadCandidate[];
  readPaths?: CapturedSessionStorePaths;
  onResolvedTarget?: (
    target: SessionStoreTarget,
    database: { agentId: string; path: string },
  ) => void;
};

function resolveReadDefaultAgentId(cfg: OpenClawConfig, targetAgentId: string): string {
  const persistedOwner = resolvePersistedSessionStoreOwner(cfg);
  return persistedOwner.kind === "none" ? normalizeAgentId(targetAgentId) : persistedOwner.agentId;
}

function dedupeTargetsByStorePath(targets: SessionStoreTarget[]): SessionStoreTarget[] {
  return [...new Map(targets.map((target) => [target.storePath, target])).values()];
}

function readSessionStoreTargetSnapshot(params: {
  cache?: SessionStoreTargetsReadCache;
  databaseAgentId: string;
  env: NodeJS.ProcessEnv;
  sqlitePath: string;
  readCandidates?: readonly SessionStoreReadCandidate[];
}): FixedSessionStoreReadSnapshot {
  const databasePath = params.readCandidates
    ? assertSessionStoreReadCandidate(params.sqlitePath, params.readCandidates)
    : params.sqlitePath;
  const cacheKey = path.resolve(params.sqlitePath);
  const cached = params.cache?.get(cacheKey);
  if (cached) {
    return cached;
  }
  let snapshot: FixedSessionStoreReadSnapshot;
  if (!fs.existsSync(params.sqlitePath)) {
    snapshot = { available: false, reason: "database-missing" };
  } else {
    try {
      const result = withOpenClawAgentDatabaseReadOnly(
        (database) => {
          const scopedAgentIds = new Set<string>();
          let hasUnscopedRow = false;
          for (const sessionKey of iterateSessionEntryKeys(database)) {
            const parsed = parseAgentSessionKey(sessionKey);
            if (parsed) {
              scopedAgentIds.add(normalizeAgentId(parsed.agentId));
            } else {
              hasUnscopedRow = true;
            }
          }
          return {
            databaseAgentId: params.databaseAgentId,
            databasePath,
            hasUnscopedRow,
            scopedAgentIds,
          };
        },
        { agentId: params.databaseAgentId, env: params.env, path: databasePath },
      );
      snapshot = result.found
        ? { available: true, ...result.value }
        : { available: false, reason: result.reason };
    } catch {
      // An unreadable candidate cannot prove absence for cleanup or placement.
      snapshot = { available: false, reason: "read-failed" };
    }
  }
  params.cache?.set(cacheKey, snapshot);
  return snapshot;
}

function resolveFixedSessionStoreTargetsReadOnly(
  cfg: OpenClawConfig,
  requested: string,
  env: NodeJS.ProcessEnv,
  params: SessionStoreTargetsReadOptions,
): SessionStoreTargetsReadResult {
  const storeConfig = cfg.session?.store;
  const defaultAgentId = resolveReadDefaultAgentId(cfg, requested);
  const fixedTarget = {
    agentId: requested,
    storePath: resolveCapturedSessionStorePath(storeConfig, requested, env, params.readPaths),
  };
  try {
    const configuredTargets = listConfiguredSessionStoreAgentIds(cfg).map((configuredAgentId) => ({
      agentId: configuredAgentId,
      storePath: resolveCapturedSessionStorePath(
        storeConfig,
        configuredAgentId,
        env,
        params.readPaths,
      ),
    }));
    if (!configuredTargets.some((target) => normalizeAgentId(target.agentId) === requested)) {
      configuredTargets.push(fixedTarget);
    }
    const resolvedTarget = resolveSqliteTargetFromSessionStorePath(fixedTarget.storePath, {
      agentId: requested,
      defaultAgentId,
      env,
      registeredDatabases: params.registeredDatabases,
      readCandidates: params.readCandidates,
    });
    const snapshot = readSessionStoreTargetSnapshot({
      cache: params.cache,
      databaseAgentId: normalizeAgentId(resolvedTarget.agentId ?? defaultAgentId),
      env,
      sqlitePath: resolvedTarget.path,
      readCandidates: params.readCandidates,
    });
    if (!snapshot.available) {
      return snapshot;
    }
    if (snapshot.scopedAgentIds.has(requested)) {
      params.onResolvedTarget?.(fixedTarget, {
        agentId: snapshot.databaseAgentId,
        path: snapshot.databasePath,
      });
      return { available: true, targets: [fixedTarget] };
    }
    const ownerValidated =
      resolvedTarget.shared === true ||
      dedupeSessionStoreTargetsBySqliteTarget(configuredTargets, {
        defaultAgentId,
        env,
        registeredDatabases: params.registeredDatabases,
        readCandidates: params.readCandidates,
      }).some((target) => normalizeAgentId(target.agentId) === requested);
    if (!ownerValidated) {
      return { available: false, reason: "read-failed" };
    }
    const ownsUnscopedRows = snapshot.databaseAgentId === requested && snapshot.hasUnscopedRow;
    if (ownsUnscopedRows) {
      params.onResolvedTarget?.(fixedTarget, {
        agentId: snapshot.databaseAgentId,
        path: snapshot.databasePath,
      });
    }
    return { available: true, targets: ownsUnscopedRows ? [fixedTarget] : [] };
  } catch (error) {
    if (error instanceof SessionStoreRegistryReadRequired) {
      throw error;
    }
    return { available: false, reason: "read-failed" };
  }
}

/** Resolves every plausible store while preserving read availability and ownership. */
export function resolveExistingAgentSessionStoreTargetsReadOnlyResult(
  cfg: OpenClawConfig,
  agentId: string,
  params: SessionStoreTargetsReadOptions = {},
): SessionStoreTargetsReadResult {
  const env = params.env ?? process.env;
  const requested = normalizeAgentId(agentId);
  if (!isPerAgentSessionStoreConfig(cfg.session?.store)) {
    return resolveFixedSessionStoreTargetsReadOnly(cfg, requested, env, params);
  }
  const configuredTarget = {
    agentId: requested,
    storePath: resolveCapturedSessionStorePath(
      cfg.session?.store,
      requested,
      env,
      params.readPaths,
    ),
  };
  const candidates = dedupeTargetsByStorePath([
    configuredTarget,
    ...resolveExistingAgentSessionStoreTargetsSync(cfg, requested, {
      env,
      registeredDatabases: params.registeredDatabases,
      readCandidates: params.readCandidates,
      readPaths: params.readPaths,
    }),
  ]);
  const targets: SessionStoreTarget[] = [];
  for (const target of candidates) {
    const defaultAgentId = resolveReadDefaultAgentId(cfg, target.agentId);
    const resolved = resolveSqliteTargetFromSessionStorePath(target.storePath, {
      agentId: target.agentId,
      defaultAgentId,
      env,
      registeredDatabases: params.registeredDatabases,
      readCandidates: params.readCandidates,
    });
    const snapshot = readSessionStoreTargetSnapshot({
      cache: params.cache,
      databaseAgentId: normalizeAgentId(resolved.agentId ?? target.agentId),
      env,
      sqlitePath: resolved.path,
      readCandidates: params.readCandidates,
    });
    if (!snapshot.available) {
      // The configured template may point at a store that has not been
      // created yet (fresh config, store migration window) while the agent's
      // real sessions live in a discovered store. A missing candidate must
      // not poison the readable siblings — treating it as whole-agent
      // unavailability made session-evidence consumers report "absent" and
      // destroy live worker placements. Broken-but-present stores still fail
      // the whole agent: partial visibility must never prove absence.
      if (snapshot.reason === "database-missing") {
        continue;
      }
      return snapshot;
    }
    targets.push(target);
    params.onResolvedTarget?.(target, {
      agentId: snapshot.databaseAgentId,
      path: snapshot.databasePath,
    });
  }
  if (targets.length === 0) {
    return { available: false, reason: "database-missing" };
  }
  return { available: true, targets };
}
