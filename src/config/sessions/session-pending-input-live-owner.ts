import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type { SessionPendingInputOwner } from "./session-pending-input-owner.types.js";
import { parseSessionPendingInputMessage } from "./session-pending-input-value.js";
import type {
  SessionPendingInputWorkerFacts,
  SessionPendingInputWorkerReceipt,
} from "./session-pending-input.types.js";
import type { PreparedSessionMentionInvitation } from "./session-sharing-authority.types.js";

/** Invitation authority belongs to the live source owner, never a collected receipt copy. */
export function bindPendingInputMentionInvitation(
  owner: SessionPendingInputOwner | undefined,
  prepare: (message: PersistedUserTurnMessage) => PreparedSessionMentionInvitation | undefined,
): void {
  if (!owner || owner.consumed || owner.mentionInvitation) {
    return;
  }
  const prepared = prepare(parseSessionPendingInputMessage(owner.messageJson));
  if (prepared) {
    owner.mentionInvitation = structuredClone(prepared.invitation);
    owner.assertMentionInvitationCurrent = prepared.assertCurrent;
  }
}

/** Worker facts delegate liveness to the host; only the host may finish custody. */
export function hydratePendingInputWorkerOwner(
  facts: SessionPendingInputWorkerFacts,
  assertCurrent: () => void,
): SessionPendingInputOwner {
  const hydrate = (current: SessionPendingInputWorkerFacts): SessionPendingInputOwner => ({
    ...current,
    workerDatabasePath: current.databasePath,
    sources: current.sources?.map(hydrate),
    assertCurrent,
    assertReadCurrent: assertCurrent,
    finish: () => {
      throw new Error("Worker custody cannot finish its host owner");
    },
  });
  return hydrate(facts);
}

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
    mentionInvitation: owner.mentionInvitation,
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
export async function collectForeignLiveSessionPendingInputEntries(
  params: {
    readLiveOwners: () => Iterable<SessionPendingInputOwner>;
    currentOwner: SessionPendingInputOwner | undefined;
    assertActive: (owner: SessionPendingInputOwner) => void;
  },
  scope: { databasePath: string; sessionId: string; sessionKey: string },
): Promise<ReadonlyMap<string, string>> {
  const entries = new Map<string, string>();
  const eligible = (owner: SessionPendingInputOwner) =>
    owner !== (params.currentOwner?.promotedOwner ?? params.currentOwner) &&
    !entries.has(owner.transcriptInputId) &&
    owner.workerDatabasePath === scope.databasePath &&
    owner.sessionId === scope.sessionId &&
    owner.sessionKey === scope.sessionKey;
  const sources = [...params.readLiveOwners()];
  for (const source of sources) {
    if (!eligible(source.promotedOwner ?? source)) {
      continue;
    }
    try {
      // Check the registered source, not all siblings: one may already have settled.
      params.assertActive(source);
      if (source.authority) {
        source.authority.assertLifetimeCurrent();
      } else {
        const checking = source.assertReadCurrent();
        if (checking !== undefined) {
          await checking;
        }
      }
      params.assertActive(source);
      const owner = source.promotedOwner ?? source;
      if (eligible(owner)) {
        entries.set(owner.transcriptInputId, owner.idempotencyKey);
      }
    } catch {
      // Finished, cancelled, or superseded sources no longer protect an orphan.
    }
  }
  return entries;
}

export function finishPendingInputSources(
  sources: readonly SessionPendingInputOwner[],
  disposition: "cancelled" | "interrupted",
  userInitiated?: true,
): void {
  const failures: unknown[] = [];
  for (const source of sources) {
    try {
      source.finish(disposition, userInitiated);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Failed to finish collected input custody");
  }
}
