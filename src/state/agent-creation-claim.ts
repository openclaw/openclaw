import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type AgentCreationClaimScope = {
  kind: "host";
  agentId: string;
  statePath: string;
  isActive: () => boolean;
  registerClose: (close: () => Promise<void>) => void;
  retryClose: () => Promise<void>;
};
type AgentCreationClaimResource = Pick<OpenClawAgentDatabase, "agentId" | "path">;
export type AgentCreationClaimWitness = { agentId: string; statePath: string };
type DelegatedAgentCreationClaim = AgentCreationClaimWitness & {
  kind: "worker";
  assertCurrent: () => void;
};

// Only a creation receipt may admit its identity beneath a completed tombstone.
// Failed disposal retains handle custody, never the expired scope's write authority.
const creationClaim = resolveGlobalSingleton(
  Symbol.for("openclaw.agentCreationClaim"),
  () => new AsyncLocalStorage<AgentCreationClaimScope | DelegatedAgentCreationClaim>(),
);
const creationResources = resolveGlobalSingleton(
  Symbol.for("openclaw.agentCreationClaimResources"),
  () => new Map<AgentCreationClaimResource, AgentCreationClaimScope>(),
);

/** Runs creation-owned staging that may write the recreated identity's databases. */
export async function runWithAgentCreationClaim<T>(
  target: { agentId: string; env?: NodeJS.ProcessEnv },
  run: () => Promise<T>,
): Promise<T> {
  let active = true;
  const closers = new Set<() => Promise<void>>();
  let pendingClose: Promise<unknown[]> | undefined;
  const closeHandles = (): Promise<unknown[]> => {
    pendingClose ??= (async () => {
      const errors: unknown[] = [];
      for (const close of [...closers].toReversed()) {
        try {
          await close();
          closers.delete(close);
        } catch (error) {
          errors.push(error);
        }
      }
      return errors;
    })().finally(() => {
      pendingClose = undefined;
    });
    return pendingClose;
  };
  const scope: AgentCreationClaimScope = {
    kind: "host",
    agentId: normalizeAgentId(target.agentId),
    statePath: path.resolve(resolveOpenClawStateSqlitePath(target.env ?? process.env)),
    isActive: () => active,
    registerClose: (close) => {
      if (!active) {
        throw new Error("Agent creation claim is no longer active.");
      }
      closers.add(close);
    },
    retryClose: async () => {
      if (active) {
        throw new Error("Agent database belongs to an active agent creation claim.");
      }
      // Join settlement before retrying; overlapping scopes must not close a successor.
      await pendingClose;
      const errors = await closeHandles();
      if (errors.length > 0) {
        throw new AggregateError(errors, "Agent creation database close retry failed.");
      }
    },
  };
  return await creationClaim.run(scope, async () => {
    let outcome: Result<T, unknown>;
    const closeErrors: unknown[] = [];
    try {
      for (const previous of new Set(creationResources.values())) {
        if (previous.agentId === scope.agentId && previous.statePath === scope.statePath) {
          await previous.retryClose();
        }
      }
      outcome = ok(await run());
    } catch (error) {
      outcome = err(error);
    } finally {
      // Revoke retained callbacks before awaiting native disposal.
      active = false;
      closeErrors.push(...(await closeHandles()));
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
    scope.kind !== "host" ||
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
  const scope = creationClaim.getStore();
  if (
    scope &&
    scope.kind === "worker" &&
    scope.agentId === normalizeAgentId(claimAgentId) &&
    scope.statePath === path.resolve(statePath)
  ) {
    scope.assertCurrent();
    return scope.agentId;
  }
  return getActiveAgentCreationClaim(claimAgentId, statePath)?.agentId;
}

/** The transport carries identity; the retained host scope remains the authority. */
export function captureAgentCreationClaim(
  options: OpenClawAgentDatabaseOptions,
): { witness: AgentCreationClaimWitness; assertCurrent: () => void } | undefined {
  const scope = getActiveAgentCreationClaim(
    options.agentId,
    resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  if (!scope) {
    return undefined;
  }
  return {
    witness: { agentId: scope.agentId, statePath: scope.statePath },
    assertCurrent() {
      if (!scope.isActive() || creationClaim.getStore() !== scope) {
        throw new Error("Agent database belongs to an active agent creation claim.");
      }
    },
  };
}

/** Native admission borrows the host claim; its executor already owns native cleanup. */
export function withAgentCreationClaimWitness<T>(
  witness: AgentCreationClaimWitness,
  assertCurrent: () => void,
  run: () => T,
): T {
  if (isMainThread) {
    throw new Error("Agent creation witnesses require their native worker");
  }
  assertCurrent();
  return creationClaim.run({ kind: "worker", ...witness, assertCurrent }, run);
}

/** Hold pending native custody until publication hands it to the handle, or disposal succeeds. */
export function reserveAgentCreationClaimAdmission(
  admission: AgentCreationClaimResource,
  options: OpenClawAgentDatabaseOptions,
  close: () => Promise<void>,
): (() => void) | undefined {
  const scope = getActiveAgentCreationClaim(
    options.agentId,
    resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  if (!scope) {
    return undefined;
  }
  creationResources.set(admission, scope);
  scope.registerClose(async () => {
    if (creationResources.get(admission) !== scope) {
      return;
    }
    // The reservation fences new admissions until the native owner joins cleanup.
    await close();
    creationResources.delete(admission);
  });
  return () => {
    creationResources.delete(admission);
  };
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
    creationResources.set(database, scope);
  }
  return scope;
}

/** Refuse a creation-owned handle to every caller outside that same live scope. */
export function assertAgentCreationClaimAccess(
  database: AgentCreationClaimResource,
  options: OpenClawAgentDatabaseOptions,
): void {
  assertAgentCreationClaimCurrent(options);
  const owner = creationResources.get(database);
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

/** A retained admission must stop before resuming native work after settlement. */
export function assertAgentCreationClaimCurrent(options: OpenClawAgentDatabaseOptions): void {
  const scope = creationClaim.getStore();
  if (
    scope &&
    scope.kind === "host" &&
    !scope.isActive() &&
    scope.agentId === normalizeAgentId(options.agentId) &&
    scope.statePath === path.resolve(resolveOpenClawStateSqlitePath(options.env ?? process.env))
  ) {
    throw new Error("Agent creation claim is no longer active.");
  }
}

/** A different spelling or state root must not borrow a creation-owned physical store. */
export function assertAgentCreationClaimAliases(options: OpenClawAgentDatabaseOptions): void {
  const pathname = resolveOpenClawAgentSqlitePath(options);
  for (const owned of creationResources.keys()) {
    if (isSameOpenClawAgentDatabasePath(owned.path, pathname)) {
      assertAgentCreationClaimAccess(owned, options);
    }
  }
}

/** Release the tag once the native owner has closed the handle. */
export function releaseAgentCreationClaimHandle(database: OpenClawAgentDatabase): void {
  creationResources.delete(database);
}
