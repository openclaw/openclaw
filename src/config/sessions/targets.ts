import fsSync from "node:fs";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentDir,
  resolveConfiguredAgentId,
  resolveDefaultAgentId,
} from "../../agents/agent-scope-config.js";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../../agents/session-dirs.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import {
  resolveSessionStoreCompatibilityAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../legacy.default-agent-owner.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentsDirFromSessionStorePath, resolveSessionStorePathCore } from "./paths.js";
import { listSqliteTargetCandidatePathsForSessionStorePath } from "./session-sqlite-target-paths.js";
import {
  resolveSqliteTargetFromSessionStorePath,
  type SessionStoreRegistryRead,
} from "./session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "./session-store-config.js";
import {
  resolvePersistedSessionStoreOwner,
  resolvePersistedSessionStoreOwnerForTarget,
} from "./session-store-owner.js";
import {
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

export type SessionStoreTargetReadOptions = {
  env?: NodeJS.ProcessEnv;
  isSameDatabasePath?: DatabasePathMatcher;
  registeredDatabases?: SessionStoreRegistryRead;
  readCandidates?: readonly SessionStoreReadCandidate[];
  readPaths?: CapturedSessionStorePaths;
};

export function resolveConfiguredSessionStoreTargets(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  readPaths?: CapturedSessionStorePaths,
): SessionStoreTarget[] {
  return listConfiguredSessionStoreAgentIds(cfg).map((agentId) => ({
    agentId,
    storePath: resolveCapturedSessionStorePath(cfg.session?.store, agentId, env, readPaths),
  }));
}

function resolveSessionStoreDiscoveryState(
  cfg: OpenClawConfig,
  params: SessionStoreTargetReadOptions & {
    agentIds?: ReadonlySet<string>;
    fixedStoreAgentIds?: ReadonlySet<string>;
  },
): {
  configuredTargets: SessionStoreTarget[];
  agentsRoots: string[];
} {
  const env = params.env ?? process.env;
  const agentIds = params.agentIds;
  const configuredTargets = agentIds
    ? resolveConfiguredSessionStoreTargets(cfg, env, params.readPaths)
    : resolveSessionStoreTargets(cfg, { allAgents: true }, params);
  if (!isPerAgentSessionStoreConfig(cfg.session?.store)) {
    for (const agentId of params.fixedStoreAgentIds ?? []) {
      if (!isConfiguredSessionStoreAgentId(cfg, agentId)) {
        configuredTargets.push({
          agentId,
          storePath: resolveCapturedSessionStorePath(
            cfg.session?.store,
            agentId,
            env,
            params.readPaths,
          ),
        });
      }
    }
  }
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
    configuredTargets: agentIds
      ? configuredTargets.filter((target) => agentIds.has(target.agentId))
      : configuredTargets,
    agentsRoots: [...agentsRoots],
  };
}

/** Resolves all configured and discoverable agent session stores synchronously. */
export function resolveAllAgentSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  params: {
    env?: NodeJS.ProcessEnv;
    agentIds?: ReadonlySet<string>;
    fixedStoreAgentIds?: ReadonlySet<string>;
    registeredDatabases?: SessionStoreRegistryRead;
    readCandidates?: readonly SessionStoreReadCandidate[];
    readPaths?: CapturedSessionStorePaths;
    onResolvedTarget?: (selected: SessionStoreTarget, physical: SessionStoreTarget) => void;
  } = {},
): SessionStoreTarget[] {
  return resolveAllAgentSessionStoreTargets(cfg, params, false);
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
  return resolveAllAgentSessionStoreTargets(
    cfg,
    { env: params.env, registeredDatabases: params.registeredDatabases },
    true,
  );
}

function resolveAllAgentSessionStoreTargets(
  cfg: OpenClawConfig,
  params: NonNullable<Parameters<typeof resolveAllAgentSessionStoreTargetsSync>[1]>,
  recoveryCandidates: boolean,
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(cfg, {
    env,
    registeredDatabases: params.registeredDatabases,
    readCandidates: params.readCandidates,
    readPaths: params.readPaths,
    agentIds: params.agentIds,
    fixedStoreAgentIds: params.fixedStoreAgentIds,
  });
  const getRealAgentsRoot = createRealAgentsRootResolver();
  const validatedConfiguredTargets = configuredTargets.flatMap((target) => {
    const agentsRoot = resolveAgentsDirFromSessionStorePath(target.storePath);
    // Configured explicit non-agent paths are accepted as-is; only agent-tree paths need
    // containment validation.
    if (!agentsRoot || (recoveryCandidates && !fsSync.existsSync(agentsRoot))) {
      return [target];
    }
    const realAgentsRoot = getRealAgentsRoot(agentsRoot);
    if (!realAgentsRoot) {
      return [];
    }
    if (recoveryCandidates) {
      return isValidatedRecoveryCandidateSessionsDir({
        allowMissingAgentDir: true,
        realAgentsRoot,
        sessionsDir: path.dirname(target.storePath),
      })
        ? [target]
        : [];
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
        const validatedStorePath = recoveryCandidates
          ? isValidatedRecoveryCandidateSessionsDir({ realAgentsRoot, sessionsDir })
            ? path.join(sessionsDir, "sessions.json")
            : undefined
          : resolveValidatedDiscoveredStorePathSync({
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
  const candidates = [...validatedConfiguredTargets, ...discoveredTargets];
  const agentIds = params.agentIds;
  return dedupeSessionStoreTargetsBySqliteTarget(
    agentIds ? candidates.filter((target) => agentIds.has(target.agentId)) : candidates,
    {
      defaultAgentId: resolveSessionStoreCompatibilityAgentId(cfg),
      env,
      onResolvedTarget: params.onResolvedTarget,
      registeredDatabases: params.registeredDatabases,
      readCandidates: params.readCandidates,
    },
  );
}

export type ExistingAgentSessionStoreTargetResolver = (
  agentId: string,
  excludeStorePath?: string,
) => SessionStoreTarget[];

/** Resolves session store targets for one agent, including retired/manual stores. */
export function resolveAgentSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  agentId: string,
  params: Pick<SessionStoreTargetReadOptions, "env" | "registeredDatabases"> = {},
): SessionStoreTarget[] {
  return resolveAgentSessionStoreTargets(cfg, agentId, params);
}

export function resolveAgentSessionStoreTargets(
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
        if (!fsSync.existsSync(sqlitePath)) {
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

  const { agentsRoots } = resolveSessionStoreDiscoveryState(cfg, { ...params, env });
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
          agentId,
        ).concat(path.join(resolveAgentDir(cfg, agentId, params.env), "openclaw-agent.sqlite")),
      ),
    ),
  ];
}

/** Include configured agent roots and session stores with their exact database owners. */
export function resolveConfiguredAgentDatabaseTargets(
  cfg: OpenClawConfig,
  params: { env: NodeJS.ProcessEnv; registeredDatabases?: SessionStoreRegistryRead },
): Array<{ agentId: string; path: string }> {
  const { env } = params;
  const targets = new Map<string, { agentId: string; path: string }>();
  const add = (agentId: string, pathname: string) =>
    targets.set(`${agentId}\0${pathname}`, { agentId, path: pathname });
  dedupeSessionStoreTargetsBySqliteTarget(resolveConfiguredSessionStoreTargets(cfg, env), {
    ...params,
    defaultAgentId: resolveSessionStoreCompatibilityAgentId(cfg),
    onResolvedTarget: (_selected, physical) => add(physical.agentId, physical.storePath),
  });
  for (const agentId of listAgentIds(cfg)) {
    add(agentId, path.join(resolveAgentDir(cfg, agentId, env), "openclaw-agent.sqlite"));
  }
  return [...targets.values()];
}

export function isConfiguredAgentDatabaseTarget(
  targets: readonly { agentId?: string; path: string }[],
  agentId: string | undefined,
  pathname: string,
): boolean {
  // Only concrete files prove aliases; preserve exact configured claims for inspection.
  return targets.some(
    (target) =>
      (agentId === undefined || target.agentId === undefined || target.agentId === agentId) &&
      (target.path === pathname ||
        (fsSync.statSync(target.path, { throwIfNoEntry: false }) &&
          fsSync.statSync(pathname, { throwIfNoEntry: false }) &&
          isSameOpenClawAgentDatabasePath(target.path, pathname))),
  );
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
    const targets = resolveConfiguredSessionStoreTargets(cfg, env, params.readPaths);
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
