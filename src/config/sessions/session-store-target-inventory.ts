import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../../agents/session-dirs.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "../legacy.default-agent-owner.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentsDirFromSessionStorePath, resolveSessionStorePathCore } from "./paths.js";
import { resolveSqliteAgentId } from "./session-accessor.sqlite-scope.js";
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
import type { SessionStoreTarget } from "./targets-collision.js";
import { shouldSkipDiscoveryError } from "./targets-path-validation.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  type SessionStoreTargetsReadCache,
  type SessionStoreTargetsReadResult,
} from "./targets-read-availability.js";
import { isPerAgentSessionStoreConfig, listConfiguredSessionStoreAgentIds } from "./targets.js";

export type SessionStoreTargetReadRequest = {
  agentId?: string;
  defaultAgentId?: string;
  storePath: string;
  env: NodeJS.ProcessEnv;
  candidates: SessionStoreReadCandidate[];
  registeredDatabases: SessionStoreRegistryRead;
};

export type SessionStoreTargetReadResult =
  | { kind: "session-target-registry-required" }
  | {
      kind: "session-store-target";
      sourcePath: string;
      logicalAgentId: string;
      database: { agentId: string; path: string };
    };

/** Resolve a single configured store without inspecting or listing its session rows. */
function readSessionStoreTarget(
  request: SessionStoreTargetReadRequest,
  onReadError?: (error: unknown) => never,
): SessionStoreTargetReadResult {
  try {
    const target = resolveSqliteTargetFromSessionStorePath(request.storePath, {
      agentId: request.agentId,
      defaultAgentId: request.defaultAgentId,
      env: request.env,
      registeredDatabases: request.registeredDatabases,
      readCandidates: request.candidates,
      onReadError,
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
      onReadError?.(error);
      throw error;
    }
    return {
      kind: "session-store-target",
      sourcePath: target.path,
      logicalAgentId: agentId,
      database: {
        agentId: target.shared ? (target.agentId ?? agentId) : agentId,
        path: assertSessionStoreReadCandidate(target.path, request.candidates),
      },
    };
  } catch (error) {
    if (error instanceof SessionStoreRegistryReadRequired) {
      return { kind: "session-target-registry-required" };
    }
    throw error;
  }
}

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
    return ok(
      readSessionStoreTarget(request, (error) => {
        throw new SessionStoreTargetDataReadError(error);
      }),
    );
  } catch (error) {
    if (error instanceof SessionStoreTargetDataReadError) {
      return err(error.readError);
    }
    throw error;
  }
}

export function captureSessionStoreReadCandidates(storePath: string): SessionStoreReadCandidate[] {
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const candidates = new Map<string, SessionStoreReadCandidate>();
  const add = (candidate: SessionStoreReadCandidate) =>
    candidates.set(JSON.stringify(candidate), candidate);
  if (!target.agentId && !target.shared) {
    add(captureSessionStoreReadCandidate(target.path, "sibling-family"));
  }
  add(captureSessionStoreReadCandidate(target.path));
  try {
    for (const candidate of listSqliteTargetCandidatePathsForSessionStorePath(storePath)) {
      add(captureSessionStoreReadCandidate(candidate));
    }
  } catch {
    // The worker refuses an unreadable or changed target outside this captured family.
  }
  return [...candidates.values()];
}

export type SessionStoreTargetInventoryRequest = {
  config: OpenClawConfig;
  legacyDefaultAgentId?: string;
  agentIds: string[];
  env: NodeJS.ProcessEnv;
  paths: CapturedSessionStorePaths;
  candidates: SessionStoreReadCandidate[];
  registeredDatabases: SessionStoreRegistryRead;
};

export type SessionStoreTargetInventoryResult =
  | { kind: "session-target-registry-required" }
  | {
      kind: "session-target-inventory";
      agents: Array<{
        agentId: string;
        result: SessionStoreTargetsReadResult;
        reads: Array<{ target: SessionStoreTarget; database: { agentId: string; path: string } }>;
      }>;
    };

/** Capture locators and bounded families without reading SQLite or assigning an owner. */
export function prepareSessionStoreTargetInventory(
  cfg: OpenClawConfig,
  inputAgentIds: readonly string[],
  inputEnv: NodeJS.ProcessEnv = process.env,
): Omit<SessionStoreTargetInventoryRequest, "registeredDatabases"> {
  const env = cloneEnvWithPlatformSemantics(inputEnv);
  const stateDir = resolveStateDir(env);
  env.OPENCLAW_STATE_DIR = stateDir;
  const config = structuredClone(cfg);
  const legacyDefaultAgentId = tryGetLegacyDefaultAgentId(cfg);
  retainLegacyDefaultAgentId(config, legacyDefaultAgentId);
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
  if (perAgent) {
    if (retired.size > 0) {
      for (const root of roots) {
        try {
          for (const sessionsDir of resolveAgentSessionDirsFromAgentsDirSync(root, (name) =>
            retired.has(normalizeAgentId(name)),
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
  }
  const candidates = new Map<string, SessionStoreReadCandidate>();
  const add = (candidate: SessionStoreReadCandidate) =>
    candidates.set(JSON.stringify(candidate), candidate);
  for (const storePath of logicalPaths) {
    const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
    if (
      agentIds.some((agentId) => isIncognitoOpenClawAgentSqlitePath(target.path, { agentId, env }))
    ) {
      throw new Error("Incognito session discovery requires its process-held owner");
    }
    for (const candidate of captureSessionStoreReadCandidates(storePath)) {
      add(candidate);
    }
  }
  return {
    config,
    legacyDefaultAgentId,
    agentIds,
    env: { ...env, OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR },
    paths,
    candidates: [...candidates.values()],
  };
}

/** Worker-only native discovery; registry facts come from the canonical host memo. */
export function readSessionStoreTargetInventory(
  request: SessionStoreTargetInventoryRequest,
): SessionStoreTargetInventoryResult {
  const env = cloneEnvWithPlatformSemantics(request.env);
  const config = retainLegacyDefaultAgentId(request.config, request.legacyDefaultAgentId);
  const cache: SessionStoreTargetsReadCache = new Map();
  try {
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
        return { agentId, result, reads: result.available ? reads : [] };
      }),
    };
  } catch (error) {
    if (error instanceof SessionStoreRegistryReadRequired) {
      return { kind: "session-target-registry-required" };
    }
    throw error;
  }
}
