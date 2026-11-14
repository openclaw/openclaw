import { statSync } from "node:fs";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../../agents/session-dirs.js";
import {
  readDatabasePathIdentitySync,
  assertDatabasePathIdentity,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { withArtifactPreservingStateReads } from "../../state/artifact-preserving-state-reads.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawRegisteredAgentDatabase,
} from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseRegistryMutation } from "../../state/openclaw-agent-db-registry-listing.js";
import { matchesAgentDatabaseReadCandidatePath } from "../../state/openclaw-agent-db-resources.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isIncognitoOpenClawAgentSqlitePath,
  type AgentDatabasePathIdentity,
} from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../types.openclaw.js";
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
  isSessionStoreSourceGenerationCurrent,
  captureSessionStoreCandidateIdentities,
  resolveSessionStoreWriteCandidate,
  isSessionStoreReadCandidateCurrent,
  assertSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
  type SessionStoreReadCustody,
} from "./session-store-read-candidates.js";
import {
  captureSessionStoreTargetInventory,
  type CapturedSessionStoreTargetInventory,
  type SessionStoreTargetInventoryRequest,
} from "./session-store-target-routing.js";
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
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredSessionStoreTargets,
} from "./targets.js";

export type SessionStoreTargetPreparationRequest =
  | { storePath: string; captureIdentity?: false }
  | { config: OpenClawConfig; agentIds: string[]; env: NodeJS.ProcessEnv }
  | ({ inventory: true } & CapturedSessionStoreTargetInventory)
  | {
      observePaths: {
        inventory?: CapturedSessionStoreTargetInventory;
        requiredPaths?: readonly string[];
        paths?: readonly string[];
        observations?: readonly AgentDatabasePathIdentity[];
      };
    }
  | { write: { storePath: string } }
  | {
      resolveWrite: {
        pathname: string;
        captured: ReturnType<typeof captureSessionStoreWriteCandidates>;
      };
    }
  | {
      validate: {
        readCustody?: readonly SessionStoreReadCustody[];
        candidates: readonly SessionStoreReadCandidate[];
        sources: readonly { path: string; identity: DatabasePathIdentity }[];
      };
    };

/** Only filesystem qualification runs before FIFO; content discovery remains ordered. */
export function prepareSessionStoreTargetCandidates(request: SessionStoreTargetPreparationRequest) {
  if ("observePaths" in request) {
    const input = request.observePaths;
    const paths = createOpenClawAgentDatabasePathMatcher(input.observations);
    if (!paths.isCurrent()) {
      throw new Error("Session store changed while preparing its metadata. Retry the request.");
    }
    const inventory = input.inventory && qualifySessionStoreTargetInventory(input.inventory);
    const candidates = new Map<string, SessionStoreReadCandidate>();
    const capture = (candidate: SessionStoreReadCandidate) => {
      try {
        paths.capture(candidate.path);
      } catch (error) {
        if (!shouldSkipDiscoveryError(error)) {
          throw error;
        }
        return;
      }
      candidates.set(JSON.stringify(candidate), candidate);
    };
    for (const pathname of input.requiredPaths ?? []) {
      paths.capture(pathname);
    }
    for (const candidate of inventory?.candidates ?? []) {
      capture(candidate);
    }
    for (const pathname of [...(input.requiredPaths ?? []), ...(input.paths ?? [])]) {
      capture(captureSessionStoreReadCandidate(pathname));
    }
    return {
      kind: "session-target-prepare" as const,
      candidates: [...candidates.values()],
      inventory: undefined,
      observations: paths.observations(),
    };
  }
  if ("write" in request) {
    const captured = captureSessionStoreWriteCandidates(request.write.storePath);
    return {
      kind: "session-target-prepare" as const,
      candidates: captured.candidates,
      inventory: undefined,
      write: captured,
    };
  }
  if ("resolveWrite" in request) {
    const { pathname, captured } = request.resolveWrite;
    return {
      kind: "session-target-prepare" as const,
      candidates: captured.candidates,
      inventory: undefined,
      identity: resolveSessionStoreWriteCandidate(pathname, captured),
    };
  }
  if ("validate" in request) {
    const readPaths = (request.validate.readCustody ?? []).map((source) =>
      assertSessionStoreReadCandidate(source.sourcePath, source.candidates),
    );
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
      readPaths,
    };
  }
  const inventory =
    "inventory" in request
      ? qualifySessionStoreTargetInventory(request)
      : "storePath" in request
        ? undefined
        : prepareSessionStoreTargetInventory(request.config, request.agentIds, request.env);
  const candidates = (
    inventory?.candidates ??
    captureSessionStoreReadCandidates("storePath" in request ? request.storePath : "")
  ).map(({ path: pathname, physicalPath, scope, identity }) => ({
    path: pathname,
    physicalPath,
    scope,
    identity:
      scope || ("storePath" in request && request.captureIdentity === false)
        ? identity
        : readDatabasePathIdentitySync(pathname),
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
function captureSessionStoreWriteCandidates(storePath: string) {
  const captured = captureSessionStoreCandidateInventory(storePath);
  return {
    ...captured,
    identities: [...captureSessionStoreCandidateIdentities(captured.candidates).values()],
  };
}

export type SessionStoreTargetInventoryResult =
  | SessionStoreRegistryRequired
  | {
      kind: "session-target-inventory";
      agents: Array<{
        agentId: string;
        result: SessionStoreTargetsReadResult;
        reads: Array<{
          target: SessionStoreTarget;
          database: { agentId: string; path: string };
          readIdentity: DatabasePathIdentity;
          readCustody: readonly SessionStoreReadCustody[];
        }>;
      }>;
    };

/** Scope registry publications to the paths that can change the original selection. */
export function createSessionStoreRegistryMutationFilter(params: {
  captured: readonly {
    candidate: SessionStoreReadCandidate;
    identity?: string;
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
  return (
    mutation: AgentDatabaseRegistryMutation,
    entries: readonly OpenClawRegisteredAgentDatabase[] | undefined,
  ) =>
    mutation.sources.every((source) => {
      const sameCapturedRegistration = params.captured.some(
        ({ candidate, identity, birthtime }) =>
          identity?.startsWith("file:") &&
          identity === source.identity &&
          (source.path === candidate.path || source.path === candidate.physicalPath) &&
          isSessionStoreSourceGenerationCurrent(
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
              isSessionStoreSourceGenerationCurrent(prepared, source),
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
        !params.captured.some(
          ({ candidate, identity }) =>
            (identity?.startsWith("file:") && source.identity === identity) ||
            matchesAgentDatabaseReadCandidatePath(candidate, source.path) ||
            matchesAgentDatabaseReadCandidatePath(
              { ...candidate, path: candidate.physicalPath },
              source.physicalPath,
            ),
        )
      );
    });
}

/** Physical selection consumes the original routing and refusal snapshot. */
function qualifySessionStoreTargetInventory(
  captured: CapturedSessionStoreTargetInventory,
): Omit<SessionStoreTargetInventoryRequest, "registeredDatabases"> {
  const { selection, config, agentIds, env, paths, recoveryExclusions, roots } = captured;
  const excludedAgentIds = new Set(recoveryExclusions?.agentIds);
  const excludedDatabasePaths = new Set(recoveryExclusions?.databasePaths);
  const excludedStorePaths: string[] = [];
  const logicalPaths = new Set(captured.logicalPaths);
  const retired = new Set(captured.retiredAgentIds);
  if (selection === "recovery" || retired.size > 0) {
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
    ...(captured.preserveSourceArtifacts ? { preserveSourceArtifacts: true as const } : {}),
    selection,
    config,
    agentIds,
    env,
    paths,
    candidates: [...candidates.values()],
    ...(recoveryExclusions
      ? { recoveryExclusions: { ...recoveryExclusions, storePaths: excludedStorePaths } }
      : {}),
    ...(retired.size > 0
      ? {
          registryDiscovery: {
            agentIds: [...retired],
            roots: roots.map((root) => captureSessionStoreReadCandidate(root)),
          },
        }
      : {}),
  };
}

/** Synchronous maintenance callers retain the same logical and physical selection owner. */
export function prepareSessionStoreTargetInventory(
  cfg: OpenClawConfig,
  inputAgentIds: readonly string[],
  inputEnv?: NodeJS.ProcessEnv,
  selection?: SessionStoreTargetInventoryRequest["selection"],
  admission: "read" | "write" = "write",
): Omit<SessionStoreTargetInventoryRequest, "registeredDatabases"> {
  return qualifySessionStoreTargetInventory(
    captureSessionStoreTargetInventory(cfg, inputAgentIds, inputEnv, selection, admission),
  );
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
  const prepareRead = (
    target: SessionStoreTarget,
    database: { agentId: string; path: string },
    sourcePath = database.path,
  ) => {
    const selected = request.candidates.find(
      (candidate) => !candidate.scope && candidate.identity?.canonicalPath === database.path,
    );
    return {
      target,
      database,
      readIdentity: selected?.identity ?? readDatabasePathIdentitySync(database.path),
      readCustody: [{ sourcePath, candidates: request.candidates }],
    };
  };
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
              prepareRead(
                physical,
                {
                  agentId: physical.agentId,
                  path: isIncognitoOpenClawAgentSqlitePath(physical.storePath, {
                    agentId: physical.agentId,
                    env,
                  })
                    ? physical.storePath
                    : databasePath,
                },
                physical.storePath,
              ),
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
        const reads: ReturnType<typeof prepareRead>[] = [];
        const result = resolveExistingAgentSessionStoreTargetsReadOnlyResult(config, agentId, {
          env,
          cache,
          registeredDatabases: request.registeredDatabases,
          readCandidates: request.candidates,
          readPaths: request.paths,
          onResolvedTarget: (target, database) => reads.push(prepareRead(target, database)),
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
