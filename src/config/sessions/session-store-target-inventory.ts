import path from "node:path";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../../agents/session-dirs.js";
import { matchesAgentDatabaseReadCandidatePath } from "../../infra/agent-database-readers.js";
import {
  readDatabasePathIdentitySync,
  assertDatabasePathIdentity,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawRegisteredAgentDatabase,
} from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseRegistryMutation } from "../../state/openclaw-agent-db-registry-listing.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isIncognitoOpenClawAgentSqlitePath,
  type AgentDatabasePathIdentity,
} from "../../state/openclaw-agent-db.paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  listSqliteTargetCandidatePathsForSessionStorePath,
  resolveUnsuffixedSqliteTargetFromSessionStorePath,
} from "./session-sqlite-target-paths.js";
import type { SessionStoreRegistryRead } from "./session-sqlite-target.js";
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
import type { SessionStoreTarget } from "./targets-collision.js";
import {
  shouldSkipDiscoveryError,
  toDiscoveredSessionStoreTarget,
} from "./targets-path-validation.js";
import type { SessionStoreTargetsReadResult } from "./targets-read-availability.worker.js";

export type SessionStoreTargetPreparationRequest =
  | { storePath: string; captureIdentity?: false }
  | { config: OpenClawConfig; agentIds: string[]; env: NodeJS.ProcessEnv; captureIdentity?: false }
  | ({ inventory: true; captureIdentity?: false } & CapturedSessionStoreTargetInventory)
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
      scope || ("captureIdentity" in request && request.captureIdentity === false)
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
