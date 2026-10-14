// Native discovery for worker readers plus deprecated synchronous SDK compatibility.

import fsSync from "node:fs";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { createOpenClawAgentDatabasePathMatcher } from "../../state/openclaw-agent-db.paths.js";
import { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { iterateSessionEntryKeys } from "./session-accessor.sqlite-entry-inventory.js";
import {
  listDurableSqliteTargetOwnersForSessionStorePath,
  readSessionStoreRegistryRows,
  resolveSqliteTargetFromSessionStorePath,
} from "./session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "./session-store-config.js";
import {
  assertSessionStoreReadCandidate,
  resolveCapturedSessionStorePath,
} from "./session-store-read-candidates.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  type SessionStoreTarget,
} from "./targets-collision.js";
import {
  isConfiguredSessionStoreAgentId,
  listConfiguredSessionStoreAgentIds,
} from "./targets-configured-agents.js";
import {
  resolveAgentSessionStoreTargets,
  resolveConfiguredSessionStoreTargets,
  resolveSessionStoreTargets,
  type ExistingAgentSessionStoreTargetResolver,
  type SessionStoreTargetReadOptions,
} from "./targets.js";

/** Lists configured owners plus persisted owners whose registered DB still matches this store. */
export function listKnownSessionStoreAgentIds(
  cfg: OpenClawConfig,
  params: Pick<SessionStoreTargetReadOptions, "env" | "registeredDatabases"> = {},
): string[] {
  const env = params.env ?? process.env;
  const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
  const isSameDatabasePath = createOpenClawAgentDatabasePathMatcher();
  const ids = new Set(listConfiguredSessionStoreAgentIds(cfg));
  if (!isPerAgentSessionStoreConfig(cfg.session?.store)) {
    const storePath = resolveSessionStorePathCore(cfg.session?.store, {
      agentId: defaultAgentId,
      env,
    });
    const durableTarget = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: defaultAgentId,
      defaultAgentId,
      env,
      registeredDatabases: params.registeredDatabases,
      isSameDatabasePath,
    });
    // Fixed stores can outlive their registry row. Preserve the database-recorded
    // owner so combined views and reapers do not drop a retired agent's live sessions.
    if (durableTarget.unsuffixedOwnerAgentId) {
      ids.add(normalizeAgentId(durableTarget.unsuffixedOwnerAgentId));
    } else if (durableTarget.ownerSource === "database-path" && durableTarget.agentId) {
      ids.add(normalizeAgentId(durableTarget.agentId));
    }
    // Retired owners may survive only in suffixed fixed-store databases after
    // their registry rows are removed. Scan this store's exact sibling family.
    for (const durableOwner of listDurableSqliteTargetOwnersForSessionStorePath(storePath)) {
      ids.add(normalizeAgentId(durableOwner));
    }
    if (durableTarget.shared && durableTarget.agentId && fsSync.existsSync(durableTarget.path)) {
      try {
        const logicalOwners = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            Array.from(iterateSessionEntryKeys(database)).flatMap((sessionKey) => {
              const parsed = parseAgentSessionKey(sessionKey);
              return parsed ? [normalizeAgentId(parsed.agentId)] : [];
            }),
          { agentId: durableTarget.agentId, env, path: durableTarget.path },
        );
        if (logicalOwners.found) {
          for (const logicalOwner of logicalOwners.value) {
            ids.add(logicalOwner);
          }
        }
      } catch {
        // Best-effort discovery: unreadable stores remain owned by their normal diagnostics path.
      }
    }
  }
  for (const registered of readSessionStoreRegistryRows(params.registeredDatabases, env)) {
    const agentId = normalizeAgentId(registered.agentId);
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
    const expectedPath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId,
      defaultAgentId,
      env,
      registeredDatabases: params.registeredDatabases,
      isSameDatabasePath,
    }).path;
    if (isSameDatabasePath(registered.path, expectedPath)) {
      ids.add(agentId);
    }
  }
  return [...ids];
}

/** Reuse configured fixed-store ownership only within one synchronous discovery operation. */
export function createExistingAgentSessionStoreTargetResolver(
  cfg: OpenClawConfig,
  params: SessionStoreTargetReadOptions & {
    isSameDatabasePath: NonNullable<SessionStoreTargetReadOptions["isSameDatabasePath"]>;
  },
): ExistingAgentSessionStoreTargetResolver {
  let configuredOwners: Set<string> | undefined;
  const isConfiguredTarget = (agentId: string) => {
    configuredOwners ??= new Set(
      resolveSessionStoreTargets(cfg, { allAgents: true }, params).map((target) =>
        normalizeAgentId(target.agentId),
      ),
    );
    return configuredOwners.has(agentId);
  };
  return (agentId, excludeStorePath) =>
    resolveExistingAgentSessionStoreTargets(
      cfg,
      agentId,
      { ...params, excludeStorePath },
      isConfiguredTarget,
    );
}

/** Resolves only already-existing stores for one configured, retired, or manual agent. */
export function resolveExistingAgentSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  agentId: string,
  params: SessionStoreTargetReadOptions & { excludeStorePath?: string } = {},
): SessionStoreTarget[] {
  return resolveExistingAgentSessionStoreTargets(cfg, agentId, params);
}

function resolveExistingAgentSessionStoreTargets(
  cfg: OpenClawConfig,
  agentId: string,
  params: SessionStoreTargetReadOptions & { excludeStorePath?: string },
  isConfiguredTarget?: (agentId: string) => boolean,
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const requested = normalizeAgentId(agentId);
  const storeConfig = cfg.session?.store;
  const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
  if (!isPerAgentSessionStoreConfig(storeConfig)) {
    const fixedTarget = {
      agentId: requested,
      storePath: resolveCapturedSessionStorePath(storeConfig, requested, env, params.readPaths),
    };
    const isSelectedTarget = () => {
      if (isConfiguredTarget && isConfiguredSessionStoreAgentId(cfg, requested)) {
        return isConfiguredTarget(requested);
      }
      const configuredTargets = resolveConfiguredSessionStoreTargets(cfg, env, params.readPaths);
      if (!configuredTargets.some((target) => normalizeAgentId(target.agentId) === requested)) {
        configuredTargets.push(fixedTarget);
      }
      return dedupeSessionStoreTargetsBySqliteTarget(configuredTargets, {
        defaultAgentId,
        env,
        registeredDatabases: params.registeredDatabases,
        readCandidates: params.readCandidates,
      }).some((target) => normalizeAgentId(target.agentId) === requested);
    };
    const resolvedTarget = resolveSqliteTargetFromSessionStorePath(fixedTarget.storePath, {
      agentId: requested,
      defaultAgentId,
      env,
      registeredDatabases: params.registeredDatabases,
      readCandidates: params.readCandidates,
      isSameDatabasePath: params.isSameDatabasePath,
    });
    if (!resolvedTarget.shared && !isSelectedTarget()) {
      return [];
    }
    // Validate ownership even when the caller already has this fixed target.
    if (fixedTarget.storePath === params.excludeStorePath) {
      return [];
    }
    const sqlitePath = resolvedTarget.path;
    if (fsSync.existsSync(sqlitePath)) {
      try {
        const databasePath = params.readCandidates
          ? assertSessionStoreReadCandidate(sqlitePath, params.readCandidates)
          : sqlitePath;
        const databaseAgentId = resolvedTarget.shared
          ? normalizeAgentId(resolvedTarget.agentId ?? defaultAgentId)
          : requested;
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) => {
            for (const sessionKey of iterateSessionEntryKeys(database)) {
              const parsed = parseAgentSessionKey(sessionKey);
              // Unscoped keys belong to the validated database owner. Explicit agent keys must
              // match so a fixed store containing only another agent's rows proves nothing.
              const ownerAgentId = parsed ? normalizeAgentId(parsed.agentId) : databaseAgentId;
              if (ownerAgentId === requested) {
                return true;
              }
            }
            return false;
          },
          { agentId: databaseAgentId, env, path: databasePath },
        );
        return result.found && result.value ? [fixedTarget] : [];
      } catch {
        return [];
      }
    }
    return [];
  }
  // Validate the runtime SQLite artifact once; Doctor's broader discovery still accepts JSON.
  let targets = resolveAgentSessionStoreTargets(cfg, requested, {
    env,
    sqliteOnly: true,
    registeredDatabases: params.registeredDatabases,
    readCandidates: params.readCandidates,
    readPaths: params.readPaths,
  });
  if (!isConfiguredSessionStoreAgentId(cfg, requested)) {
    // Always run sqlite-target dedupe for retired/manual agents: it probes the agent database
    // registry, so an unreadable registry surfaces as an ambiguous-ownership result rather than a
    // silent "absent" verdict in placement evidence (see server-worker-placement-session-evidence
    // "keeps a placement when the agent database registry is unreadable"). Retired/manual lookups are
    // not the configured-agent hot path, so the registry probe cost is acceptable here.
    targets = dedupeSessionStoreTargetsBySqliteTarget(targets, {
      defaultAgentId,
      env,
      registeredDatabases: params.registeredDatabases,
      readCandidates: params.readCandidates,
    });
  }
  return params.excludeStorePath === undefined
    ? targets
    : targets.filter((target) => target.storePath !== params.excludeStorePath);
}
