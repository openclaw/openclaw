import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../../agents/session-dirs.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawRegisteredAgentDatabase,
} from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseRegistryMutation } from "../../state/openclaw-agent-db-registry-listing.js";
import { matchesAgentDatabaseReadCandidatePath } from "../../state/openclaw-agent-db-resources.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import { captureRuntimeConfig } from "../runtime-source-projection.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentsDirFromSessionStorePath, resolveSessionStorePathCore } from "./paths.js";
import { resolveSqliteAgentId } from "./session-accessor.sqlite-scope-helpers.js";
import {
  listSqliteTargetCandidatePathsForSessionStorePath,
  resolveUnsuffixedSqliteTargetFromSessionStorePath,
} from "./session-sqlite-target-paths.js";
import {
  resolveSqliteTargetFromSessionStorePath,
  SessionStoreRegistryReadRequired,
  type SessionStoreRegistryRead,
} from "./session-sqlite-target.js";
import {
  captureSessionStoreReadCandidate,
  assertSessionStoreReadCandidate,
  type CapturedSessionStorePaths,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  type SessionStoreTarget,
} from "./targets-collision.js";
import {
  shouldSkipDiscoveryError,
  toDiscoveredSessionStoreTarget,
} from "./targets-path-validation.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  type SessionStoreTargetsReadCache,
  type SessionStoreTargetsReadResult,
} from "./targets-read-availability.js";
import {
  isPerAgentSessionStoreConfig,
  listConfiguredSessionStoreAgentIds,
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredSessionStoreTargets,
} from "./targets.js";

export type SessionStoreTargetReadRequest = {
  agentId?: string;
  defaultAgentId?: string;
  storePath: string;
  env: NodeJS.ProcessEnv;
  candidates: SessionStoreReadCandidate[];
  registeredDatabases: SessionStoreRegistryRead;
};

type SessionStoreRegistryRequired = {
  kind: "session-target-registry-required";
  readFailed?: boolean;
};

export type SessionStoreTargetReadResult =
  | SessionStoreRegistryRequired
  | {
      kind: "session-store-target";
      sourcePath: string;
      logicalAgentId: string;
      database: { agentId: string; path: string };
    };

class SessionStoreTargetDataReadError extends Error {
  constructor(readonly readError: unknown) {
    super("Session store target data read failed", { cause: readError });
  }
}

/** Preserve positive locator failures without catching native close or candidate revocation. */
export function readSessionStoreTargetResult(
  request: SessionStoreTargetReadRequest,
): Result<SessionStoreTargetReadResult, unknown> {
  try {
    const target = resolveSqliteTargetFromSessionStorePath(request.storePath, {
      agentId: request.agentId,
      defaultAgentId: request.defaultAgentId,
      env: request.env,
      registeredDatabases: request.registeredDatabases,
      readCandidates: request.candidates,
      onReadError(error) {
        throw new SessionStoreTargetDataReadError(error);
      },
    });
    let agentId: string | undefined;
    try {
      agentId = resolveSqliteAgentId({
        scopedAgentId: request.agentId,
        storeAgentId: target.agentId ?? request.agentId,
        storeShared: target.shared,
      });
      if (!agentId) {
        throw new Error("Cannot resolve SQLite session scope without an agent id");
      }
    } catch (error) {
      throw new SessionStoreTargetDataReadError(error);
    }
    return ok({
      kind: "session-store-target",
      sourcePath: target.path,
      logicalAgentId: agentId,
      database: {
        agentId: target.shared ? (target.agentId ?? agentId) : agentId,
        path: assertSessionStoreReadCandidate(target.path, request.candidates),
      },
    });
  } catch (error) {
    if (error instanceof SessionStoreRegistryReadRequired) {
      return ok({ kind: "session-target-registry-required" });
    }
    if (error instanceof SessionStoreTargetDataReadError) {
      return err(error.readError);
    }
    throw error;
  }
}

export function captureSessionStoreReadCandidates(storePath: string): SessionStoreReadCandidate[] {
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const candidates = [captureSessionStoreReadCandidate(target.path)];
  if (target.agentId || target.shared) {
    return candidates;
  }
  candidates.unshift(captureSessionStoreReadCandidate(target.path, "sibling-family"));
  try {
    for (const candidate of listSqliteTargetCandidatePathsForSessionStorePath(storePath)) {
      if (candidate !== target.path) {
        candidates.push(captureSessionStoreReadCandidate(candidate));
      }
    }
  } catch {
    // The worker refuses an unreadable or changed target outside this captured family.
  }
  return candidates;
}

export type SessionStoreTargetInventoryRequest = {
  selection?: "configured" | "recovery";
  config: OpenClawConfig;
  agentIds: string[];
  env: NodeJS.ProcessEnv;
  paths: CapturedSessionStorePaths;
  candidates: SessionStoreReadCandidate[];
  registryDiscovery?: {
    agentIds: string[];
    roots: Array<{ path: string; physicalPath: string }>;
  };
  registeredDatabases: SessionStoreRegistryRead;
};

export type SessionStoreTargetInventoryResult =
  | SessionStoreRegistryRequired
  | {
      kind: "session-target-inventory";
      agents: Array<{
        agentId: string;
        result: SessionStoreTargetsReadResult;
        reads: Array<{ target: SessionStoreTarget; database: { agentId: string; path: string } }>;
      }>;
    };

/** Scope registry publications to the paths that can change the original selection. */
export function createSessionStoreRegistryMutationFilter(params: {
  captured: readonly {
    candidate: SessionStoreReadCandidate;
    identity: string;
    birthtime?: string;
  }[];
  preparedSources: readonly {
    agentId: string;
    path: string;
    identity: string;
    birthtime: string;
  }[];
  registryDiscovery?: SessionStoreTargetInventoryRequest["registryDiscovery"];
}) {
  const registryCandidates = params.captured.filter(
    ({ candidate }) => !resolveUnsuffixedSqliteTargetFromSessionStorePath(candidate.path).agentId,
  );
  return (
    mutation: AgentDatabaseRegistryMutation,
    entries: readonly OpenClawRegisteredAgentDatabase[] | undefined,
  ) =>
    mutation.sources.every((source) => {
      const sameCapturedRegistration = params.captured.some(
        ({ candidate, identity, birthtime }) =>
          identity.startsWith("file:") &&
          identity === source.identity &&
          (source.path === candidate.path || source.path === candidate.physicalPath) &&
          isCurrentRegistrySourceGeneration(
            { path: candidate.path, identity, birthtime },
            source,
          ) &&
          entries?.some(
            (entry) =>
              entry.agentId === source.agentId &&
              entry.schemaVersion === source.schemaVersion &&
              (entry.path === candidate.path || entry.path === candidate.physicalPath),
          ),
      );
      if (
        mutation.kind === "upsert" &&
        source.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION &&
        (sameCapturedRegistration ||
          params.preparedSources.some(
            (prepared) =>
              prepared.agentId === source.agentId &&
              prepared.identity === source.identity &&
              isCurrentRegistrySourceGeneration(prepared, source),
          ))
      ) {
        return true;
      }
      return (
        !params.preparedSources.some(
          (prepared) =>
            prepared.path === source.path ||
            prepared.path === source.physicalPath ||
            prepared.identity === source.identity,
        ) &&
        !isSessionStoreRegistryDiscoveryPath(params.registryDiscovery, source) &&
        !registryCandidates.some(
          ({ candidate, identity }) =>
            (identity.startsWith("file:") && source.identity === identity) ||
            matchesAgentDatabaseReadCandidatePath(candidate, source.path) ||
            matchesAgentDatabaseReadCandidatePath(
              { ...candidate, path: candidate.physicalPath },
              source.physicalPath,
            ),
        )
      );
    });
}

function isCurrentRegistrySourceGeneration(
  captured: { path: string; identity: string; birthtime?: string },
  source: { path: string; physicalPath: string },
): boolean {
  if (captured.birthtime === undefined) {
    return false;
  }
  try {
    for (const pathname of new Set([captured.path, source.path, source.physicalPath])) {
      assertExistingDatabaseIdentity(pathname, captured.identity, captured.birthtime);
    }
    return true;
  } catch {
    return false;
  }
}

/** Capture locators and bounded families without reading SQLite or assigning an owner. */
export function prepareSessionStoreTargetInventory(
  cfg: OpenClawConfig,
  inputAgentIds: readonly string[],
  inputEnv: NodeJS.ProcessEnv = process.env,
  selection?: SessionStoreTargetInventoryRequest["selection"],
): Omit<SessionStoreTargetInventoryRequest, "registeredDatabases"> {
  const env = cloneEnvWithPlatformSemantics(inputEnv);
  const stateDir = resolveStateDir(env);
  env.OPENCLAW_STATE_DIR = stateDir;
  const config = captureRuntimeConfig(cfg);
  const agentIds = [...new Set(inputAgentIds.map(normalizeAgentId))];
  const configured = listConfiguredSessionStoreAgentIds(config);
  const paths = new Map(
    [...new Set([...agentIds, ...configured])].map((agentId) => [
      agentId,
      {
        configured: resolveSessionStorePathCore(config.session?.store, { agentId, env }),
        default: resolveSessionStorePathCore(undefined, { agentId, env }),
      },
    ]),
  );
  const perAgent = isPerAgentSessionStoreConfig(config.session?.store);
  const retired = new Set(agentIds.filter((agentId) => !configured.includes(agentId)));
  const logicalPaths = new Set(
    agentIds.flatMap((agentId) => {
      const captured = paths.get(agentId)!;
      return perAgent ? [captured.configured, captured.default] : [captured.configured];
    }),
  );
  if (perAgent && retired.size > 0) {
    for (const agentId of configured) {
      logicalPaths.add(paths.get(agentId)!.configured);
    }
  }
  const roots = new Set([path.join(stateDir, "agents")]);
  for (const value of paths.values()) {
    const root = resolveAgentsDirFromSessionStorePath(value.configured);
    if (root) {
      roots.add(root);
    }
  }
  if (selection === "recovery" || (perAgent && retired.size > 0)) {
    for (const root of roots) {
      try {
        for (const sessionsDir of resolveAgentSessionDirsFromAgentsDirSync(
          root,
          (name) => selection === "recovery" || retired.has(normalizeAgentId(name)),
        )) {
          logicalPaths.add(path.join(sessionsDir, "sessions.json"));
        }
      } catch (error) {
        if (!shouldSkipDiscoveryError(error)) {
          throw error;
        }
      }
    }
  }
  const candidates = new Map<string, SessionStoreReadCandidate>();
  for (const storePath of logicalPaths) {
    const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
    // Locator-only inventories keep incognito reads with their process-held owner.
    if (
      selection === undefined &&
      agentIds.some((agentId) => isIncognitoOpenClawAgentSqlitePath(target.path, { agentId, env }))
    ) {
      throw new Error("Incognito session discovery requires its process-held owner");
    }
    for (const candidate of captureSessionStoreReadCandidates(storePath)) {
      candidates.set(JSON.stringify(candidate), candidate);
    }
  }
  return {
    selection,
    config,
    agentIds,
    env: { ...env, OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR },
    paths,
    candidates: [...candidates.values()],
    ...(perAgent && retired.size > 0
      ? {
          registryDiscovery: {
            agentIds: [...retired],
            roots: [...roots].map((root) => captureSessionStoreReadCandidate(root)),
          },
        }
      : {}),
  };
}

/** Future retired directories follow the same root and directory-name rules as discovery. */
function isSessionStoreRegistryDiscoveryPath(
  scope: SessionStoreTargetInventoryRequest["registryDiscovery"],
  source: { path: string; physicalPath: string },
): boolean {
  if (!scope) {
    return false;
  }
  return scope.roots.some((root) =>
    [root.path, root.physicalPath].some((rootPath) =>
      [source.path, source.physicalPath].some((sourcePath) => {
        const relative = path.relative(rootPath, sourcePath);
        const directoryName = relative.split(path.sep)[0];
        if (path.isAbsolute(relative) || !directoryName || directoryName === "..") {
          return false;
        }
        const sessionsDir = path.join(rootPath, directoryName, "sessions");
        const target = toDiscoveredSessionStoreTarget(
          sessionsDir,
          path.join(sessionsDir, "sessions.json"),
        );
        return (
          target !== undefined &&
          scope.agentIds.includes(target.agentId) &&
          resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).path === sourcePath
        );
      }),
    ),
  );
}

/** Worker-only native discovery; registry facts come from the canonical host memo. */
export function readSessionStoreTargetInventory(
  request: SessionStoreTargetInventoryRequest,
): SessionStoreTargetInventoryResult {
  const env = cloneEnvWithPlatformSemantics(request.env);
  const config = request.config;
  const cache: SessionStoreTargetsReadCache = new Map();
  let readFailed = false;
  try {
    if (request.selection === "configured" || request.selection === "recovery") {
      const agents: Extract<
        SessionStoreTargetInventoryResult,
        { kind: "session-target-inventory" }
      >["agents"] = [];
      const options = {
        defaultAgentId: resolveSessionStoreCompatibilityAgentId(config),
        env,
        registeredDatabases: request.registeredDatabases,
        readCandidates: request.candidates,
        readPaths: request.paths,
        onResolvedTarget(target: SessionStoreTarget, physical: SessionStoreTarget) {
          const databasePath = assertSessionStoreReadCandidate(
            physical.storePath,
            request.candidates,
          );
          const selected =
            request.selection === "recovery" ? { ...target, agentId: physical.agentId } : target;
          agents.push({
            agentId: selected.agentId,
            result: { available: true, targets: [selected] },
            reads: [
              {
                target: physical,
                database: {
                  agentId: physical.agentId,
                  path: isIncognitoOpenClawAgentSqlitePath(physical.storePath, {
                    agentId: physical.agentId,
                    env,
                  })
                    ? physical.storePath
                    : databasePath,
                },
              },
            ],
          });
        },
      };
      if (request.selection === "recovery") {
        const selected = new Set(request.agentIds);
        resolveAllAgentSessionStoreTargetsSync(config, {
          ...options,
          ...(isPerAgentSessionStoreConfig(config.session?.store)
            ? { agentIds: selected }
            : { fixedStoreAgentIds: selected }),
        });
      } else {
        dedupeSessionStoreTargetsBySqliteTarget(
          resolveConfiguredSessionStoreTargets(config, env, request.paths),
          options,
        );
      }
      return { kind: "session-target-inventory", agents };
    }
    return {
      kind: "session-target-inventory",
      agents: request.agentIds.map((agentId) => {
        const reads: Array<{
          target: SessionStoreTarget;
          database: { agentId: string; path: string };
        }> = [];
        const result = resolveExistingAgentSessionStoreTargetsReadOnlyResult(config, agentId, {
          env,
          cache,
          registeredDatabases: request.registeredDatabases,
          readCandidates: request.candidates,
          readPaths: request.paths,
          onResolvedTarget: (target, database) => reads.push({ target, database }),
        });
        readFailed ||= !result.available && result.reason !== "database-missing";
        return { agentId, result, reads: result.available ? reads : [] };
      }),
    };
  } catch (error) {
    if (error instanceof SessionStoreRegistryReadRequired) {
      return {
        kind: "session-target-registry-required",
        readFailed,
      };
    }
    throw error;
  }
}
