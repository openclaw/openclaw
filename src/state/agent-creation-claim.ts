import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type AgentCreationClaimScope = {
  agentId: string;
  statePath: string;
  isActive: () => boolean;
  registerClose: (close: () => void) => void;
};

// A completed deletion record keeps fencing the dead identity until the creation lifecycle
// claims it. Creation is that claimant, so while it stages state for the identity it is
// recreating it may open that identity's own databases beneath a completed record. The scope
// never covers incomplete deletions, other identities, or callers outside creation, and it
// owns every handle it admits: they stay private to the scope and close when it settles, so
// a failed creation leaves no warm handle behind its retained tombstone.
const creationClaim = resolveGlobalSingleton(
  Symbol.for("openclaw.agentCreationClaim"),
  () => new AsyncLocalStorage<AgentCreationClaimScope>(),
);
const creationHandles = resolveGlobalSingleton(
  Symbol.for("openclaw.agentCreationClaimHandles"),
  () => new Map<OpenClawAgentDatabase, AgentCreationClaimScope>(),
);

/** Runs creation-owned staging that may write the recreated identity's databases. */
export async function runWithAgentCreationClaim<T>(
  target: { agentId: string; env?: NodeJS.ProcessEnv },
  run: () => Promise<T>,
): Promise<T> {
  let active = true;
  const closers = new Set<() => void>();
  const scope: AgentCreationClaimScope = {
    agentId: normalizeAgentId(target.agentId),
    statePath: path.resolve(resolveOpenClawStateSqlitePath(target.env ?? process.env)),
    isActive: () => active,
    registerClose: (close) => {
      if (!active) {
        throw new Error("Agent creation claim is no longer active.");
      }
      closers.add(close);
    },
  };
  return await creationClaim.run(scope, async () => {
    let outcome: Result<T, unknown>;
    const closeErrors: unknown[] = [];
    try {
      outcome = ok(await run());
    } catch (error) {
      outcome = err(error);
    } finally {
      // Retained async callbacks keep this same store and must lose the exemption; handles
      // admitted under it close here so nothing warm outlives the receipt phase.
      active = false;
      for (const close of [...closers].toReversed()) {
        try {
          close();
        } catch (error) {
          closeErrors.push(error);
        }
      }
    }
    if (!outcome.ok) {
      throw closeErrors.length > 0
        ? new AggregateError([outcome.error, ...closeErrors], "Agent creation claim failed.")
        : outcome.error;
    }
    if (closeErrors.length > 0) {
      throw closeErrors.length === 1
        ? closeErrors[0]
        : new AggregateError(closeErrors, "Agent creation claim failed.");
    }
    return outcome.value;
  });
}

function getActiveAgentCreationClaim(
  agentId: string,
  statePath: string,
): AgentCreationClaimScope | undefined {
  const scope = creationClaim.getStore();
  if (
    !scope ||
    !scope.isActive() ||
    scope.agentId !== normalizeAgentId(agentId) ||
    scope.statePath !== path.resolve(statePath)
  ) {
    return undefined;
  }
  return scope;
}

/** The identity the live creation scope may admit beneath its own completed deletion record. */
export function resolveAgentCreationClaimAgentId(
  claimAgentId: string,
  statePath: string,
): string | undefined {
  return getActiveAgentCreationClaim(claimAgentId, statePath)?.agentId;
}

/** Tag a freshly opened handle as owned by the live creation scope for its identity. */
export function registerAgentCreationClaimHandle(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
): AgentCreationClaimScope | undefined {
  const scope = getActiveAgentCreationClaim(
    options.agentId,
    resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  if (scope) {
    creationHandles.set(database, scope);
  }
  return scope;
}

/** Refuse a creation-owned handle to every caller outside that same live scope. */
export function assertAgentCreationClaimAccess(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
): void {
  const owner = creationHandles.get(database);
  if (!owner) {
    return;
  }
  const scope = getActiveAgentCreationClaim(
    options.agentId,
    resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  if (owner !== scope) {
    throw new Error("Agent database belongs to an active agent creation claim.");
  }
}

/** Release the tag once the native owner has closed the handle. */
export function releaseAgentCreationClaimHandle(database: OpenClawAgentDatabase): void {
  creationHandles.delete(database);
}
