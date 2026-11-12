import { statSync } from "node:fs";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../../agents/session-dirs.js";
import {
  readDatabasePathIdentitySync,
  assertDatabasePathIdentity,
  assertExistingDatabaseIdentity,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
  readAgentDatabaseReadAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import {
  isArtifactPreservingStateRead,
  withArtifactPreservingStateReads,
} from "../../state/artifact-preserving-state-reads.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawRegisteredAgentDatabase,
} from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseRegistryMutation } from "../../state/openclaw-agent-db-registry-listing.js";
import { matchesAgentDatabaseReadCandidatePath } from "../../state/openclaw-agent-db-resources.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  cloneEnvWithPlatformSemantics,
  getPublishedConfigRuntimeEnvState,
} from "../config-env-vars.js";
import { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import { getRuntimeConfigSnapshot } from "../runtime-snapshot.js";
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
  captureSessionStoreCandidateIdentities,
  qualifyAbsentSessionStoreReadCandidate,
  isSessionStoreReadCandidateCurrent,
  assertSessionStoreReadCandidate,
  type CapturedSessionStorePaths,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  type SessionStoreTarget,
} from "./targets-collision.js";
import { listKnownSessionStoreAgentIds } from "./targets-discovery.native.js";
import {
  shouldSkipDiscoveryError,
  toDiscoveredSessionStoreTarget,
} from "./targets-path-validation.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  type SessionStoreTargetsReadCache,
  type SessionStoreTargetsReadResult,
} from "./targets-read-availability.worker.js";
import {
  isPerAgentSessionStoreConfig,
  listConfiguredSessionStoreAgentIds,
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredSessionStoreTargets,
} from "./targets.js";

export type SessionStoreTargetPreparationRequest =
  | { storePath: string }
  | { config: OpenClawConfig; agentIds: string[]; env: NodeJS.ProcessEnv }
  | {
      validate: {
        candidates: readonly SessionStoreReadCandidate[];
        sources: readonly { path: string; identity: DatabasePathIdentity }[];
      };
    };

/** Only filesystem qualification runs before FIFO; content discovery remains ordered. */
export function prepareSessionStoreTargetCandidates(request: SessionStoreTargetPreparationRequest) {
  if ("validate" in request) {
    if (!request.validate.candidates.every(isSessionStoreReadCandidateCurrent)) {
      throw new Error("Session database selector changed before effect preparation");
    }
    for (const source of request.validate.sources) {
      assertDatabasePathIdentity(source.path, source.identity);
    }
    return {
      kind: "session-target-prepare" as const,
      candidates: [...request.validate.candidates],
      inventory: undefined,
    };
  }
  const inventory =
    "storePath" in request
      ? undefined
      : prepareSessionStoreTargetInventory(request.config, request.agentIds, request.env);
  const candidates = (
    inventory?.candidates ??
    captureSessionStoreReadCandidates("storePath" in request ? request.storePath : "")
  ).map(({ path: pathname, physicalPath, scope, identity }) => ({
    path: pathname,
    physicalPath,
    scope,
    identity: scope ? identity : readDatabasePathIdentitySync(pathname),
  }));
  return {
    kind: "session-target-prepare" as const,
    candidates,
    inventory: inventory && { ...inventory, candidates },
  };
}

export type SessionStoreTargetReadRequest = {
  preserveSourceArtifacts?: true;
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
  if (request.preserveSourceArtifacts) {
    return withArtifactPreservingStateReads(
      () => readSessionStoreTargetResult({ ...request, preserveSourceArtifacts: undefined }),
      { agentDatabases: true },
    );
  }
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

function captureSessionStoreCandidateInventory(storePath: string) {
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const candidates = [captureSessionStoreReadCandidate(target.path)];
  if (target.agentId || target.shared) {
    return { candidates, familyListingComplete: false };
  }
  candidates.unshift(captureSessionStoreReadCandidate(target.path, "sibling-family"));
  let familyListingComplete = false;
  try {
    for (const candidate of listSqliteTargetCandidatePathsForSessionStorePath(storePath)) {
      if (candidate !== target.path) {
        candidates.push(captureSessionStoreReadCandidate(candidate));
      }
    }
    familyListingComplete = true;
  } catch {
    // The worker refuses an unreadable or changed target outside this captured family.
  }
  return { candidates, familyListingComplete };
}

export function captureSessionStoreReadCandidates(storePath: string): SessionStoreReadCandidate[] {
  return captureSessionStoreCandidateInventory(storePath).candidates;
}

/** A complete initial listing proves absence for a later-selected sibling without predicting ownership. */
export function captureSessionStoreWriteCandidates(storePath: string) {
  const captured = captureSessionStoreCandidateInventory(storePath);
  const identities = captureSessionStoreCandidateIdentities(captured.candidates);
  const assertCurrent = () => {
    if (!captured.candidates.every(isSessionStoreReadCandidateCurrent)) {
      throw new Error("Session database selector changed during discovery");
    }
  };
  return {
    assertCurrent,
    resolveIdentity(pathname: string) {
      assertCurrent();
      const physicalPath = assertSessionStoreReadCandidate(pathname, captured.candidates);
      const identity = identities.get(physicalPath);
      if (identity) {
        assertDatabasePathIdentity(pathname, identity);
        return identity;
      }
      return qualifyAbsentSessionStoreReadCandidate(pathname, captured);
    },
  };
}

export type SessionStoreTargetInventoryRequest = {
  preserveSourceArtifacts?: true;
  selection?: "configured" | "recovery" | "known-owners";
  config: OpenClawConfig;
  agentIds: string[];
  env: NodeJS.ProcessEnv;
  paths: CapturedSessionStorePaths;
  candidates: SessionStoreReadCandidate[];
  recoveryExclusions?: { agentIds: string[]; storePaths: string[]; databasePaths: string[] };
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
              (prepared.identity === source.identity ||
                // A creator's COMMIT promotes its captured absent locator to this file.
                params.captured.some(
                  ({ candidate, identity, birthtime }) =>
                    birthtime === undefined &&
                    identity === source.identity &&
                    (candidate.path === prepared.path || candidate.physicalPath === prepared.path),
                )) &&
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

type InventoryEnvironment = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  serialized: NodeJS.ProcessEnv;
  configuredPaths?: CapturedSessionStorePaths;
};
let publishedInventoryEnvironment:
  | {
      config: OpenClawConfig;
      publication: ReturnType<typeof getPublishedConfigRuntimeEnvState>;
      captured: InventoryEnvironment;
    }
  | undefined;

/** Capture runtime routing without discovering physical store candidates. */
export function captureSessionStoreEnvironment(
  cfg: OpenClawConfig,
  inputEnv?: NodeJS.ProcessEnv,
): InventoryEnvironment {
  const config = captureRuntimeConfig(cfg);
  const publication =
    inputEnv === undefined && cfg === getRuntimeConfigSnapshot()
      ? getPublishedConfigRuntimeEnvState()
      : undefined;
  let environment =
    publication &&
    publishedInventoryEnvironment?.config === config &&
    publishedInventoryEnvironment.publication === publication
      ? publishedInventoryEnvironment.captured
      : undefined;
  if (!environment) {
    const env = cloneEnvWithPlatformSemantics(inputEnv ?? process.env);
    const stateDir = resolveStateDir(env);
    env.OPENCLAW_STATE_DIR = stateDir;
    // Windows path resolution needs the proxy; worker requests need a plain snapshot.
    environment = {
      config,
      env,
      stateDir,
      serialized: Object.freeze({ ...env, OPENCLAW_STATE_DIR: stateDir }),
    };
    if (publication) {
      // Config publication and env rollback both replace their existing owner-held identities.
      publishedInventoryEnvironment = { config, publication, captured: environment };
    }
  }
  return environment;
}

/** Capture locators and bounded families without reading SQLite or assigning an owner. */
export function prepareSessionStoreTargetInventory(
  cfg: OpenClawConfig,
  inputAgentIds: readonly string[],
  inputEnv?: NodeJS.ProcessEnv,
  selection?: SessionStoreTargetInventoryRequest["selection"],
  admission: "read" | "write" = "write",
): Omit<SessionStoreTargetInventoryRequest, "registeredDatabases"> {
  const environment = captureSessionStoreEnvironment(cfg, inputEnv);
  const { config, env, stateDir, serialized } = environment;
  const capturePaths = (agentId: string) => ({
    configured: resolveSessionStorePathCore(config.session?.store, { agentId, env }),
    default: resolveSessionStorePathCore(undefined, { agentId, env }),
  });
  // Only logical configured paths follow config/env publication. Physical candidates
  // and retired-owner discovery below must observe filesystem changes on every read.
  const configuredPaths = (environment.configuredPaths ??= new Map(
    listConfiguredSessionStoreAgentIds(config).map((agentId) => [agentId, capturePaths(agentId)]),
  ));
  // Background inventories skip unavailable stores before joining their native opening.
  // The preparing owner can still discover its own borrowed admission.
  const refusals =
    selection === "recovery" || selection === "configured"
      ? listAgentDatabaseAdmissionRefusals({ env }).filter((refusal) =>
          admission === "read"
            ? readAgentDatabaseReadAdmissionRefusal(refusal.agentId, { env })
            : readAgentDatabaseAdmissionRefusal(refusal.agentId, { env }),
        )
      : [];
  const excludedAgentIds = new Set(refusals.map((refusal) => refusal.agentId));
  const excludedDatabasePaths = new Set(
    refusals.flatMap((refusal) => refusal.paths.map((pathname) => path.resolve(pathname))),
  );
  const excludedStorePaths: string[] = [];
  const agentIds = [...new Set(inputAgentIds.map(normalizeAgentId))];
  const configured = [...configuredPaths.keys()];
  const paths = new Map(
    [...new Set([...agentIds, ...configured])].map((agentId) => [
      agentId,
      configuredPaths.get(agentId) ?? capturePaths(agentId),
    ]),
  );
  const perAgent = isPerAgentSessionStoreConfig(config.session?.store);
  const retired = new Set(agentIds.filter((agentId) => !configured.includes(agentId)));
  const logicalPaths = new Set(
    agentIds
      .filter((agentId) => !excludedAgentIds.has(agentId))
      .flatMap((agentId) => {
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
          (name) =>
            !excludedAgentIds.has(normalizeAgentId(name)) &&
            (selection === "recovery" || retired.has(normalizeAgentId(name))),
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
    const storeCandidates = captureSessionStoreReadCandidates(storePath);
    const availableCandidates = storeCandidates.filter(
      (candidate) =>
        !excludedDatabasePaths.has(candidate.path) &&
        !excludedDatabasePaths.has(candidate.physicalPath),
    );
    const hasExcludedCandidate = availableCandidates.length !== storeCandidates.length;
    if (hasExcludedCandidate && (target.agentId || target.shared)) {
      excludedStorePaths.push(storePath);
      continue;
    }
    for (const candidate of availableCandidates) {
      // Family custody would still join the refused sibling's native admission.
      if (hasExcludedCandidate && candidate.scope === "sibling-family") {
        continue;
      }
      candidates.set(JSON.stringify(candidate), candidate);
    }
  }
  return {
    ...(isArtifactPreservingStateRead("agent") ? { preserveSourceArtifacts: true as const } : {}),
    selection,
    config,
    agentIds,
    env: serialized,
    paths,
    candidates: [...candidates.values()],
    ...(refusals.length > 0
      ? {
          recoveryExclusions: {
            agentIds: [...excludedAgentIds],
            databasePaths: [...excludedDatabasePaths],
            storePaths: excludedStorePaths,
          },
        }
      : {}),
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
  if (request.preserveSourceArtifacts) {
    return withArtifactPreservingStateReads(
      () => readSessionStoreTargetInventory({ ...request, preserveSourceArtifacts: undefined }),
      { agentDatabases: true },
    );
  }
  const env = cloneEnvWithPlatformSemantics(request.env);
  const config = request.config;
  const cache: SessionStoreTargetsReadCache = new Map();
  let readFailed = false;
  try {
    if (request.selection === "known-owners") {
      return {
        kind: "session-target-inventory",
        agents: listKnownSessionStoreAgentIds(config, {
          env,
          registeredDatabases: request.registeredDatabases,
        }).map((agentId) => ({ agentId, result: { available: true, targets: [] }, reads: [] })),
      };
    }
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
        excludeTarget: (target: SessionStoreTarget) =>
          request.recoveryExclusions?.agentIds.includes(target.agentId) === true ||
          request.recoveryExclusions?.storePaths.includes(target.storePath) === true,
        onResolvedTarget(target: SessionStoreTarget, physical: SessionStoreTarget) {
          // Partial recovery has no rows to recover from uncreated stores.
          if (
            request.selection === "recovery" &&
            request.recoveryExclusions &&
            !statSync(physical.storePath, { throwIfNoEntry: false })
          ) {
            return;
          }
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
        // Maintenance must retain retired and held stores in its discovered roster.
        resolveAllAgentSessionStoreTargetsSync(config, {
          ...options,
          fixedStoreAgentIds: new Set(request.agentIds),
        });
      } else {
        dedupeSessionStoreTargetsBySqliteTarget(
          resolveConfiguredSessionStoreTargets(config, env, request.paths).filter(
            (target) => !options.excludeTarget(target),
          ),
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
