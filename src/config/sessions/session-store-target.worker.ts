import { statSync } from "node:fs";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { withArtifactPreservingStateReads } from "../../state/artifact-preserving-state-reads.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import { resolveSqliteAgentId } from "./session-accessor.sqlite-scope-helpers.js";
import { encodeSessionTranscriptWorkerError } from "./session-history-worker-errors.js";
import {
  resolveSqliteTargetFromSessionStorePath,
  SessionStoreRegistryReadRequired,
} from "./session-sqlite-target.js";
import { assertSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import type {
  SessionStoreTargetInventoryResult,
  SessionStoreTargetReadRequest,
  SessionStoreTargetReadResult,
} from "./session-store-target-inventory.js";
import type { SessionStoreTargetInventoryRequest } from "./session-store-target-routing.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  type SessionStoreTarget,
} from "./targets-collision.js";
import { listKnownSessionStoreAgentIds } from "./targets-discovery.native.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  type SessionStoreTargetsReadCache,
} from "./targets-read-availability.worker.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredSessionStoreTargets,
} from "./targets.js";

export function readSessionStoreTarget(request: SessionStoreTargetReadRequest) {
  request.env = cloneEnvWithPlatformSemantics(request.env);
  const read = readSessionStoreTargetResult(request);
  if (read.ok) {
    return read.value;
  }
  const readError = encodeSessionTranscriptWorkerError(read.error);
  if (!readError) {
    throw read.error;
  }
  return { kind: "session-store-target" as const, readError };
}

class SessionStoreTargetDataReadError extends Error {
  constructor(readonly readError: unknown) {
    super("Session store target data read failed", { cause: readError });
  }
}

/** Preserve positive locator failures without catching native close or candidate revocation. */
function readSessionStoreTargetResult(
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
