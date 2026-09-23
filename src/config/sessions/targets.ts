// Session store target discovery maps configured and on-disk agent stores to canonical targets.
import fsSync from "node:fs";
import path from "node:path";
import { resolveAgentDir, resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../../agents/session-dirs.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  listOpenClawRegisteredAgentDatabases,
} from "../../state/openclaw-agent-db-registry.js";
import {
  resolveSessionStoreCompatibilityAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../legacy.default-agent-owner.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentsDirFromSessionStorePath, resolveSessionStorePathCore } from "./paths.js";
import { iterateSessionEntryKeys } from "./session-accessor.sqlite-entry-inventory.js";
import {
  listDurableSqliteTargetOwnersForSessionStorePath,
  listSqliteTargetCandidatePathsForSessionStorePath,
  resolveSqliteTargetFromSessionStorePath,
  type SessionStoreRegistryRead,
} from "./session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "./session-store-config.js";
import {
  resolvePersistedSessionStoreOwner,
  resolvePersistedSessionStoreOwnerForTarget,
} from "./session-store-owner.js";
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
  isConfiguredSessionStoreAgentId,
  listConfiguredSessionStoreAgentIds,
} from "./targets-configured-agents.js";
import {
  createRealAgentsRootResolver,
  dedupeTargetsByStorePath,
  isValidatedRecoveryCandidateSessionsDir,
  resolveValidatedDiscoveredStorePathSync,
  shouldSkipDiscoveryError,
  toDiscoveredSessionStoreTarget,
  resolveExplicitSessionStoreTarget,
} from "./targets-path-validation.js";

export {
  isConfiguredSessionStoreAgentId,
  listConfiguredSessionStoreAgentIds,
} from "./targets-configured-agents.js";
export type { SessionStoreTarget } from "./targets-collision.js";
export { dedupeSessionStoreTargetsBySqliteTarget } from "./targets-collision.js";
export { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
export { isPerAgentSessionStoreConfig } from "./session-store-config.js";

/** CLI/session-store target selection options. */
export type SessionStoreSelectionOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
};

type DatabasePathMatcher = (left: string, right: string) => boolean;

type SessionStoreTargetReadOptions = {
  env?: NodeJS.ProcessEnv;
  isSameDatabasePath?: DatabasePathMatcher;
  registeredDatabases?: SessionStoreRegistryRead;
  readCandidates?: readonly SessionStoreReadCandidate[];
  readPaths?: CapturedSessionStorePaths;
};

/** Lists configured owners plus persisted owners whose registered DB still matches this store. */
export function listKnownSessionStoreAgentIds(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
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
  for (const registered of listOpenClawRegisteredAgentDatabases({ env })) {
    const agentId = normalizeAgentId(registered.agentId);
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
    const expectedPath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId,
      defaultAgentId,
      env,
      isSameDatabasePath,
    }).path;
    if (isSameDatabasePath(registered.path, expectedPath)) {
      ids.add(agentId);
    }
  }
  return [...ids];
}

function resolveSessionStoreDiscoveryState(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  registeredDatabases?: SessionStoreRegistryRead,
  readCandidates?: readonly SessionStoreReadCandidate[],
  readPaths?: CapturedSessionStorePaths,
): {
  configuredTargets: SessionStoreTarget[];
  agentsRoots: string[];
} {
  const configuredTargets = resolveSessionStoreTargets(
    cfg,
    { allAgents: true },
    {
      env,
      registeredDatabases,
      readCandidates,
      readPaths,
    },
  );
  const agentsRoots = new Set<string>();
  for (const target of configuredTargets) {
    const agentsDir = resolveAgentsDirFromSessionStorePath(target.storePath);
    if (agentsDir) {
      agentsRoots.add(agentsDir);
    }
  }
  agentsRoots.add(path.join(resolveStateDir(env), "agents"));
  // Search both configured template roots and the default state root so retired/manual agents are
  // visible even when no longer listed in config.
  return {
    configuredTargets,
    agentsRoots: [...agentsRoots],
  };
}

/** Resolves all configured and discoverable agent session stores synchronously. */
export function resolveAllAgentSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  params: {
    env?: NodeJS.ProcessEnv;
    registeredDatabases?: SessionStoreRegistryRead;
    onResolvedTarget?: (selected: SessionStoreTarget, physical: SessionStoreTarget) => void;
  } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(
    cfg,
    env,
    params.registeredDatabases,
  );
  const getRealAgentsRoot = createRealAgentsRootResolver();
  const validatedConfiguredTargets = configuredTargets.flatMap((target) => {
    const agentsRoot = resolveAgentsDirFromSessionStorePath(target.storePath);
    // Configured explicit non-agent paths are accepted as-is; only agent-tree paths need
    // containment validation.
    if (!agentsRoot) {
      return [target];
    }
    const realAgentsRoot = getRealAgentsRoot(agentsRoot);
    if (!realAgentsRoot) {
      return [];
    }
    const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
      sessionsDir: path.dirname(target.storePath),
      agentsRoot,
      realAgentsRoot,
    });
    return validatedStorePath ? [{ ...target, storePath: validatedStorePath }] : [];
  });
  const discoveredTargets = agentsRoots.flatMap((agentsDir) => {
    try {
      const realAgentsRoot = getRealAgentsRoot(agentsDir);
      if (!realAgentsRoot) {
        return [];
      }
      return resolveAgentSessionDirsFromAgentsDirSync(agentsDir).flatMap((sessionsDir) => {
        const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
          sessionsDir,
          agentsRoot: agentsDir,
          realAgentsRoot,
        });
        const target = validatedStorePath
          ? toDiscoveredSessionStoreTarget(sessionsDir, validatedStorePath)
          : undefined;
        return target ? [target] : [];
      });
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        return [];
      }
      throw err;
    }
  });
  return dedupeSessionStoreTargetsBySqliteTarget(
    [...validatedConfiguredTargets, ...discoveredTargets],
    {
      defaultAgentId: resolveSessionStoreCompatibilityAgentId(cfg),
      env,
      onResolvedTarget: params.onResolvedTarget,
      registeredDatabases: params.registeredDatabases,
    },
  );
}

export type ExistingAgentSessionStoreTargetResolver = (
  agentId: string,
  excludeStorePath?: string,
) => SessionStoreTarget[];

/** Reuse configured fixed-store ownership only within one synchronous discovery operation. */
export function createExistingAgentSessionStoreTargetResolver(
  cfg: OpenClawConfig,
  params: SessionStoreTargetReadOptions & { isSameDatabasePath: DatabasePathMatcher },
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
      const configuredTargets = listConfiguredSessionStoreAgentIds(cfg).map(
        (configuredAgentId) => ({
          agentId: configuredAgentId,
          storePath: resolveCapturedSessionStorePath(
            storeConfig,
            configuredAgentId,
            env,
            params.readPaths,
          ),
        }),
      );
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
    if (sqlitePath && fsSync.existsSync(sqlitePath)) {
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

/**
 * Resolves recovery candidates without requiring either the legacy store or SQLite file.
 * Callers must validate the selected artifact before performing filesystem mutations.
 */
export function resolveAllAgentSessionStoreCandidateTargetsSync(
  cfg: OpenClawConfig,
  params: {
    env?: NodeJS.ProcessEnv;
    registeredDatabases?: SessionStoreRegistryRead;
  } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(
    cfg,
    env,
    params.registeredDatabases,
  );
  const getRealAgentsRoot = createRealAgentsRootResolver();
  const validatedConfiguredTargets = configuredTargets.flatMap((target) => {
    const agentsRoot = resolveAgentsDirFromSessionStorePath(target.storePath);
    if (!agentsRoot) {
      return [target];
    }
    if (!fsSync.existsSync(agentsRoot)) {
      return [target];
    }
    const realAgentsRoot = getRealAgentsRoot(agentsRoot);
    return realAgentsRoot &&
      isValidatedRecoveryCandidateSessionsDir({
        allowMissingAgentDir: true,
        realAgentsRoot,
        sessionsDir: path.dirname(target.storePath),
      })
      ? [target]
      : [];
  });
  const discoveredTargets = agentsRoots.flatMap((agentsDir) => {
    try {
      const realAgentsRoot = getRealAgentsRoot(agentsDir);
      if (!realAgentsRoot) {
        return [];
      }
      return resolveAgentSessionDirsFromAgentsDirSync(agentsDir).flatMap((sessionsDir) => {
        if (
          !isValidatedRecoveryCandidateSessionsDir({
            realAgentsRoot,
            sessionsDir,
          })
        ) {
          return [];
        }
        const target = toDiscoveredSessionStoreTarget(
          sessionsDir,
          path.join(sessionsDir, "sessions.json"),
        );
        return target ? [target] : [];
      });
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        return [];
      }
      throw err;
    }
  });
  return dedupeSessionStoreTargetsBySqliteTarget(
    [...validatedConfiguredTargets, ...discoveredTargets],
    {
      defaultAgentId: resolveSessionStoreCompatibilityAgentId(cfg),
      env,
      registeredDatabases: params.registeredDatabases,
    },
  );
}

/** Resolves session store targets for one agent, including retired/manual stores. */
export function resolveAgentSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  agentId: string,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionStoreTarget[] {
  return resolveAgentSessionStoreTargets(cfg, agentId, params);
}

function resolveAgentSessionStoreTargets(
  cfg: OpenClawConfig,
  agentId: string,
  params: SessionStoreTargetReadOptions & { sqliteOnly?: boolean },
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const requested = normalizeAgentId(agentId);
  const storePaths = new Set<string>([
    resolveCapturedSessionStorePath(cfg.session?.store, requested, env, params.readPaths),
    resolveCapturedSessionStorePath(
      cfg.session?.store,
      requested,
      env,
      params.readPaths,
      "default",
    ),
  ]);
  const targets: SessionStoreTarget[] = [];
  const getRealAgentsRoot = createRealAgentsRootResolver();

  for (const storePath of storePaths) {
    const agentsRoot = resolveAgentsDirFromSessionStorePath(storePath);
    if (!agentsRoot) {
      if (params.sqliteOnly) {
        const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId: requested,
          env,
          registeredDatabases: params.registeredDatabases,
          readCandidates: params.readCandidates,
        }).path;
        if (!sqlitePath || !fsSync.existsSync(sqlitePath)) {
          continue;
        }
      }
      targets.push({ agentId: requested, storePath });
      continue;
    }
    const realAgentsRoot = getRealAgentsRoot(agentsRoot);
    if (!realAgentsRoot) {
      continue;
    }
    const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
      sessionsDir: path.dirname(storePath),
      agentsRoot,
      realAgentsRoot,
      sqliteOnly: params.sqliteOnly,
    });
    if (validatedStorePath) {
      targets.push({ agentId: requested, storePath: validatedStorePath });
    }
  }

  // Configured agents own canonical direct paths; broad discovery is retired/manual-only.
  // Falling through here makes per-agent Gateway prewarm scan the full roster quadratically.
  if (isConfiguredSessionStoreAgentId(cfg, requested)) {
    return dedupeTargetsByStorePath(targets);
  }

  const { agentsRoots } = resolveSessionStoreDiscoveryState(
    cfg,
    env,
    params.registeredDatabases,
    params.readCandidates,
    params.readPaths,
  );
  for (const agentsDir of agentsRoots) {
    try {
      const realAgentsRoot = getRealAgentsRoot(agentsDir);
      if (!realAgentsRoot) {
        continue;
      }
      for (const sessionsDir of resolveAgentSessionDirsFromAgentsDirSync(
        agentsDir,
        (dirName) => normalizeAgentId(dirName) === requested,
      )) {
        const target = toDiscoveredSessionStoreTarget(
          sessionsDir,
          path.join(sessionsDir, "sessions.json"),
        );
        if (!target) {
          continue;
        }
        const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
          sessionsDir,
          agentsRoot: agentsDir,
          realAgentsRoot,
          sqliteOnly: params.sqliteOnly,
        });
        if (validatedStorePath) {
          targets.push({ ...target, storePath: validatedStorePath });
        }
      }
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        continue;
      }
      throw err;
    }
  }

  return dedupeTargetsByStorePath(targets);
}

/** Candidate files for version inspection only; this does not assign migration ownership. */
export function resolveConfiguredAgentDatabaseCandidatePaths(
  cfg: OpenClawConfig,
  params: { env: NodeJS.ProcessEnv },
): string[] {
  return [
    ...new Set(
      listConfiguredSessionStoreAgentIds(cfg).flatMap((agentId) =>
        listSqliteTargetCandidatePathsForSessionStorePath(
          resolveSessionStorePathCore(cfg.session?.store, { agentId, env: params.env }),
        ),
      ),
    ),
  ];
}

/** Include configured agent roots and session stores with their exact database owners. */
export function resolveConfiguredAgentDatabaseTargets(
  cfg: OpenClawConfig,
  params: {
    env: NodeJS.ProcessEnv;
    registeredDatabases?: SessionStoreRegistryRead;
  },
): Array<{ agentId: string; path: string }> {
  const targets = resolveSessionStoreTargets(cfg, { allAgents: true }, params).map((target) => {
    const resolved = resolveSqliteTargetFromSessionStorePath(target.storePath, {
      agentId: target.agentId,
      defaultAgentId: isPerAgentSessionStoreConfig(cfg.session?.store)
        ? target.agentId
        : resolveSessionStoreCompatibilityAgentId(cfg),
      env: params.env,
      registeredDatabases: params.registeredDatabases,
    });
    // Shared stores partition logical agents inside one physical schema owner.
    return { agentId: resolved.agentId ?? target.agentId, path: resolved.path };
  });
  const seen = new Set(targets.map((target) => `${target.agentId}\0${target.path}`));
  for (const agentId of listAgentIds(cfg)) {
    const databasePath = path.join(
      resolveAgentDir(cfg, agentId, params.env),
      "openclaw-agent.sqlite",
    );
    if (!seen.has(`${agentId}\0${databasePath}`)) {
      targets.push({ agentId, path: databasePath });
    }
  }
  return targets;
}

/** Resolves session store targets from explicit CLI-style selection options. */
export function resolveSessionStoreTargets(
  cfg: OpenClawConfig,
  opts: SessionStoreSelectionOptions,
  params: SessionStoreTargetReadOptions & { diagnostics?: string[] } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const requestedAgent = opts.agent?.trim();
  if (opts.agent !== undefined && !requestedAgent) {
    throw new Error("--agent must not be blank");
  }
  if (opts.store !== undefined && !opts.store.trim()) {
    throw new Error("--store must not be blank");
  }
  const hasAgent = requestedAgent !== undefined;
  const allAgents = opts.allAgents === true;
  if (hasAgent && allAgents) {
    throw new Error("--agent and --all-agents cannot be used together");
  }
  if (opts.store && allAgents) {
    throw new Error("--store cannot be combined with --all-agents");
  }
  if (opts.store) {
    const persistedStoreOwner = resolvePersistedSessionStoreOwnerForTarget({
      config: cfg,
      sessionKey: "main",
      storePath: opts.store,
      env,
    });
    if (persistedStoreOwner.kind === "retired") {
      throw new Error(`Session store owner is retired: ${persistedStoreOwner.agentId}`);
    }
    const requestedAgentId = requestedAgent ? normalizeAgentId(requestedAgent) : undefined;
    if (
      requestedAgentId &&
      persistedStoreOwner.kind === "configured" &&
      persistedStoreOwner.agentId !== requestedAgentId
    ) {
      throw new Error(
        `Session store belongs to agent "${persistedStoreOwner.agentId}", not requested agent "${requestedAgentId}".`,
      );
    }
    const defaultAgentId =
      requestedAgentId ??
      (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
      tryResolveLegacyCompatibilityAgentId(cfg) ??
      resolveDefaultAgentId(cfg);
    if (hasAgent) {
      resolveConfiguredAgentId(cfg, defaultAgentId);
    }
    const target = resolveExplicitSessionStoreTarget({ defaultAgentId, env, store: opts.store });
    if (
      (hasAgent || persistedStoreOwner.kind === "configured") &&
      target.agentId !== defaultAgentId
    ) {
      throw new Error(
        `Session store belongs to agent "${target.agentId}", not requested agent "${defaultAgentId}".`,
      );
    }
    return [target];
  }

  if (allAgents) {
    const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
    const targets = listConfiguredSessionStoreAgentIds(cfg).map((agentId) => ({
      agentId,
      storePath: resolveCapturedSessionStorePath(
        cfg.session?.store,
        agentId,
        env,
        params.readPaths,
      ),
    }));
    return dedupeSessionStoreTargetsBySqliteTarget(targets, {
      defaultAgentId,
      env,
      registeredDatabases: params.registeredDatabases,
      readCandidates: params.readCandidates,
      ...(params.diagnostics
        ? { onDiagnostic: (diagnostic) => params.diagnostics?.push(diagnostic.message) }
        : {}),
    });
  }

  if (hasAgent) {
    const requested = normalizeAgentId(requestedAgent);
    resolveConfiguredAgentId(cfg, requested);
    return [
      {
        agentId: requested,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: requested, env }),
      },
    ];
  }

  const persistedStoreOwner = resolvePersistedSessionStoreOwner(cfg);
  if (persistedStoreOwner.kind === "retired") {
    throw new Error(`Session store owner is retired: ${persistedStoreOwner.agentId}`);
  }
  const defaultAgentId =
    (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
    tryResolveLegacyCompatibilityAgentId(cfg) ??
    resolveDefaultAgentId(cfg);
  return [
    {
      agentId: defaultAgentId,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: defaultAgentId, env }),
    },
  ];
}
