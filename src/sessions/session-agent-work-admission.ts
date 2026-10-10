import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getAgentDeletionDatabaseCleanup } from "../state/agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { collectSessionIdentityTargets } from "./session-lifecycle-identity.js";
import type { HandoffSessionWorkAdmission } from "./session-work-admission-handoff.js";

export type AgentWorkAdmissionTarget = {
  agentId: string;
  statePath?: string;
  env?: NodeJS.ProcessEnv;
};
export type AgentWorkAdmissionIdentity = { agentId: string; statePath: string };
export type SessionWorkAdmissionClosure = {
  identities: readonly string[];
  agent?: AgentWorkAdmissionIdentity;
  deletionOperationId?: string;
  reason: Error;
};

export class AgentDeletionPendingError extends Error {}

export const sessionWorkAdmissionClosures = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionWorkAdmissionClosures"),
  () => new Set<SessionWorkAdmissionClosure>(),
);

export function agentWorkAdmissionIdentity(
  target: AgentWorkAdmissionTarget,
): AgentWorkAdmissionIdentity {
  return {
    agentId: normalizeAgentId(target.agentId),
    statePath: readDatabasePathIdentitySync(
      target.statePath ?? resolveOpenClawStateSqlitePath(target.env ?? process.env),
    ).canonicalPath,
  };
}

/** Journal publication, not an individual attempt, owns the pending-deletion fence. */
export function publishAgentDeletionWorkAdmission(
  target: AgentWorkAdmissionTarget,
  operationId: string,
  pending: boolean,
): void {
  const agent = agentWorkAdmissionIdentity(target);
  for (const owner of sessionWorkAdmissionClosures) {
    if (
      owner.deletionOperationId !== undefined &&
      matchesAgentWorkAdmission(owner.agent, agent) &&
      (pending || owner.deletionOperationId === operationId)
    ) {
      sessionWorkAdmissionClosures.delete(owner);
    }
  }
  if (pending) {
    sessionWorkAdmissionClosures.add({
      agent,
      identities: [],
      deletionOperationId: operationId,
      reason: new AgentDeletionPendingError(
        `Agent ${agent.agentId} deletion cleanup is still pending; resolve the cleanup failure, then retry agents.delete.`,
      ),
    });
  }
}

/** Deletion's existing ingress fence also owns admission of new session writes. */
export function assertAgentSessionWriteAdmission(
  options: OpenClawAgentDatabaseOptions,
  logicalAgentId = options.agentId,
): void {
  const cleanup = getAgentDeletionDatabaseCleanup(options);
  if (cleanup) {
    cleanup.assertCurrentHost();
    return;
  }
  if (sessionWorkAdmissionClosures.size === 0) {
    return;
  }
  const agent = agentWorkAdmissionIdentity({ agentId: logicalAgentId, env: options.env });
  const closed = [...sessionWorkAdmissionClosures].find(
    (owner) => owner.identities.length === 0 && matchesAgentWorkAdmission(owner.agent, agent),
  );
  if (closed) {
    throw closed.reason;
  }
}

export function matchesAgentWorkAdmission(
  left: AgentWorkAdmissionIdentity | undefined,
  right: AgentWorkAdmissionIdentity | undefined,
): boolean {
  return Boolean(
    left && right && left.agentId === right.agentId && left.statePath === right.statePath,
  );
}

type AgentSessionWorkAdmission = HandoffSessionWorkAdmission & {
  agent?: AgentWorkAdmissionIdentity;
  phase: "pending" | "acquired";
  released: Promise<void>;
};

/** Agent drains use the lifecycle owner's existing admission index and closures. */
export function createAgentWorkAdmissionQueries<T extends AgentSessionWorkAdmission>(
  admissions: ReadonlyMap<string, ReadonlySet<T>>,
  currentAdmissions: () => ReadonlySet<T> | undefined,
) {
  const closures = sessionWorkAdmissionClosures;
  /** The deletion owner reserves this fence before publishing its durable journal. */
  function closeAgentWorkAdmissions(
    params: AgentWorkAdmissionTarget & { reason: Error },
  ): () => void {
    const agent = agentWorkAdmissionIdentity(params);
    if (
      [...(currentAdmissions() ?? [])].some((admission) =>
        matchesAgentWorkAdmission(admission.agent, agent),
      )
    ) {
      throw new Error("Cannot delete an agent from its own active turn.");
    }
    const owner = {
      agent,
      identities: [],
      reason: params.reason,
    };
    closures.add(owner);
    try {
      interruptSessionWorkAdmissionOwners(collectAgentWorkAdmissions(params, true), params.reason);
    } catch (error) {
      closures.delete(owner);
      throw error;
    }
    return () => {
      closures.delete(owner);
    };
  }

  function assertSessionWorkAdmissionOpen(admission: T): void {
    let stopReason: Error | undefined;
    for (const owner of closures) {
      if (owner.agent && !matchesAgentWorkAdmission(owner.agent, admission.agent)) {
        continue;
      }
      // Agent retirement takes precedence over a session's transient Stop fence.
      if (owner.agent && owner.identities.length === 0) {
        throw owner.reason;
      }
      if (!stopReason && owner.identities.some((identity) => admission.identities.has(identity))) {
        stopReason = owner.reason;
      }
    }
    if (stopReason) {
      if (!admission.interrupted) {
        admission.interrupt?.(stopReason);
      }
      throw stopReason;
    }
  }

  function collectAgentWorkAdmissions(target: AgentWorkAdmissionTarget, pendingOnly = false) {
    const agent = agentWorkAdmissionIdentity(target);
    const matching = new Set<T>();
    for (const owners of admissions.values()) {
      for (const admission of owners) {
        if (
          matchesAgentWorkAdmission(admission.agent, agent) &&
          (!pendingOnly || admission.phase === "pending")
        ) {
          matching.add(admission);
        }
      }
    }
    return matching;
  }

  function collectActiveAgentSessionWorkAdmissions(
    target: AgentWorkAdmissionTarget,
  ): Map<string, Set<string>> {
    const identities: string[] = [];
    for (const admission of collectAgentWorkAdmissions(target)) {
      identities.push(...admission.identities);
    }
    return collectSessionIdentityTargets(identities);
  }

  function startAgentWorkAdmissionInterruption(
    params: AgentWorkAdmissionTarget & { reason?: Error; assertCurrent?: () => void },
  ): {
    released: Promise<void>;
    interruptedRunIds: ReadonlySet<string>;
  } {
    return interruptSessionWorkAdmissionOwners(
      collectAgentWorkAdmissions(params),
      params.reason,
      params.assertCurrent,
    );
  }

  return {
    closeAgentWorkAdmissions,
    collectActiveAgentSessionWorkAdmissions,
    startAgentWorkAdmissionInterruption,
    assertSessionWorkAdmissionOpen,
  };
}

export function interruptSessionWorkAdmissionOwners(
  admissions: ReadonlySet<AgentSessionWorkAdmission>,
  reason?: Error,
  assertCurrent?: () => void,
) {
  const interruptedRunIds = new Set<string>();
  const interrupted = new Set<AgentSessionWorkAdmission>();
  let failure: { error: unknown } | undefined;
  try {
    for (const admission of admissions) {
      assertCurrent?.();
      interrupted.add(admission);
      admission.interrupted ??= reason ?? new Error("Session work admission interrupted");
      const receipt = admission.interrupt?.(admission.interrupted);
      if (receipt) {
        interruptedRunIds.add(receipt.runId);
      }
    }
  } catch (error) {
    // Pending reservations have no writes to settle; acquired owners retain cleanup custody.
    if (![...interrupted].some((admission) => admission.phase === "acquired")) {
      throw error;
    }
    failure = { error };
  }
  return {
    interruptedRunIds,
    released: Promise.all(
      Array.from(failure ? interrupted : admissions, (admission) => admission.released),
    ).then(() => {
      if (failure) {
        throw failure.error;
      }
    }),
  };
}
