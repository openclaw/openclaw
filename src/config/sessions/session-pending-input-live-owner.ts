import type { SessionPendingInputOwner } from "./session-pending-input-owner.types.js";
import type {
  SessionPendingInputWorkerFacts,
  SessionPendingInputWorkerReceipt,
} from "./session-pending-input.types.js";

/** Only serializable custody facts cross to the worker; live promotion links stay on the host. */
export function copySessionPendingInputWorkerFacts(
  owner: SessionPendingInputOwner,
): SessionPendingInputWorkerFacts {
  return {
    agentId: owner.agentId,
    databaseAgentId: owner.databaseAgentId,
    inputId: owner.inputId,
    transcriptInputId: owner.transcriptInputId,
    sessionId: owner.sessionId,
    sessionKey: owner.sessionKey,
    databasePath: owner.workerDatabasePath,
    idempotencyKey: owner.idempotencyKey,
    lifecycleGeneration: owner.lifecycleGeneration,
    messageJson: owner.messageJson,
    preparedAuthority:
      owner.authority || owner.sources?.some((source) => source.authority) ? true : undefined,
    ...(owner.sources ? { sources: owner.sources.map(copySessionPendingInputWorkerFacts) } : {}),
  };
}

/** Sync commits and worker receipts publish the same host-owned promotion fact. */
export function publishConsumedSessionPendingInputSources(
  owner: SessionPendingInputOwner | undefined,
  sources: readonly SessionPendingInputOwner[],
  consumedInputIds?: ReadonlySet<string>,
): void {
  for (const source of sources) {
    if (consumedInputIds && !consumedInputIds.has(source.inputId)) {
      continue;
    }
    source.consumed = true;
    if (owner?.sources) {
      source.promotedOwner = owner;
    }
  }
}

export function publishSessionPendingInputWorkerReceipt(
  owner: SessionPendingInputOwner,
  receipt: SessionPendingInputWorkerReceipt,
): void {
  owner.transcriptInputId = receipt.transcriptInputId;
  publishConsumedSessionPendingInputSources(
    owner,
    owner.sources ?? [owner],
    new Set(receipt.consumedInputIds),
  );
}

/** A promoted input stays protected while any of its admitted sources is still live. */
export function collectForeignLiveSessionPendingInputEntries(params: {
  scope: { databasePath: string; sessionId: string; sessionKey: string };
  liveOwners: Iterable<SessionPendingInputOwner>;
  currentOwner: SessionPendingInputOwner | undefined;
  assertLifetimeCurrent: (owner: SessionPendingInputOwner) => void;
}): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  const current = params.currentOwner?.promotedOwner ?? params.currentOwner;
  for (const source of params.liveOwners) {
    const owner = source.promotedOwner ?? source;
    if (
      owner === current ||
      entries.has(owner.transcriptInputId) ||
      owner.workerDatabasePath !== params.scope.databasePath ||
      owner.sessionId !== params.scope.sessionId ||
      owner.sessionKey !== params.scope.sessionKey
    ) {
      continue;
    }
    try {
      // Check the registered source, not all siblings: one may already have settled.
      params.assertLifetimeCurrent(source);
      entries.set(owner.transcriptInputId, owner.idempotencyKey);
    } catch {
      // Finished, cancelled, or superseded sources no longer protect an orphan.
    }
  }
  return entries;
}
