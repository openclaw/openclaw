import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getAgentDeletionDatabaseCleanup } from "../state/agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export type AgentWorkAdmissionTarget = {
  agentId: string;
  statePath?: string;
  env?: NodeJS.ProcessEnv;
};
export type AgentWorkAdmissionIdentity = { agentId: string; statePath: string };
type AgentDeletionTerminalWrite = {
  target: { agentId: string; path: string };
  persist: (assertCurrent: () => void) => Promise<void>;
};
export type SessionWorkAdmissionClosure = {
  identities: readonly string[];
  agent?: AgentWorkAdmissionIdentity;
  deletionOperationId?: string;
  reason: Error;
  terminalWrites?: Set<AgentDeletionTerminalWrite>;
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
  const terminalWrites = new Set<AgentDeletionTerminalWrite>();
  for (const owner of sessionWorkAdmissionClosures) {
    if (
      owner.deletionOperationId !== undefined &&
      matchesAgentWorkAdmission(owner.agent, agent) &&
      (pending || owner.deletionOperationId === operationId)
    ) {
      if (pending) {
        for (const write of owner.terminalWrites ?? []) {
          terminalWrites.add(write);
        }
      }
      sessionWorkAdmissionClosures.delete(owner);
    }
  }
  if (pending) {
    sessionWorkAdmissionClosures.add({
      agent,
      identities: [],
      deletionOperationId: operationId,
      terminalWrites,
      reason: new AgentDeletionPendingError(
        `Agent ${agent.agentId} deletion cleanup is still pending; resolve the cleanup failure, then retry agents.delete.`,
      ),
    });
  }
}

/** The deletion fence retains terminal outcomes independently of the run's drain. */
export function retainAgentDeletionTerminalWrite(
  target: AgentWorkAdmissionTarget,
  write: AgentDeletionTerminalWrite,
): boolean {
  const agent = agentWorkAdmissionIdentity(target);
  const owner = [...sessionWorkAdmissionClosures].find(
    (closure) =>
      closure.deletionOperationId !== undefined && matchesAgentWorkAdmission(closure.agent, agent),
  );
  if (!owner) {
    return false;
  }
  (owner.terminalWrites ??= new Set()).add(write);
  return true;
}

/** Replay before rollback removes the journal fence; failures leave custody intact. */
export async function replayAgentDeletionTerminalWrites(
  target: AgentWorkAdmissionTarget,
  replay: (write: AgentDeletionTerminalWrite) => Promise<void>,
): Promise<void> {
  const agent = agentWorkAdmissionIdentity(target);
  for (const owner of sessionWorkAdmissionClosures) {
    if (!matchesAgentWorkAdmission(owner.agent, agent)) {
      continue;
    }
    for (const write of owner.terminalWrites ?? []) {
      await replay(write);
      owner.terminalWrites?.delete(write);
    }
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
