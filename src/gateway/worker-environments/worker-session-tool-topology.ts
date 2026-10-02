import { normalizeOptionalString as relationKey } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";

export type WorkerSessionToolSource = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  turnClaim: NonNullable<WorkerConnectionIdentity["turnClaim"]> & {
    owner: { kind: "worker"; environmentId: string; ownerEpoch: number };
  };
  entry: SessionEntry;
};

export type WorkerSessionToolTarget = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  storePath: string;
  topologyParent?: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    storePath: string;
  };
};

export async function readWorkerSessionToolEntry(sessionKey: string, agentId?: string) {
  const target = await resolveGatewaySessionStoreTargetInWorker({
    cfg: getRuntimeConfig(),
    key: sessionKey,
    agentId,
  });
  return {
    ...target,
    storePath: target.readSource?.path ?? target.storePath,
    entry: target.store[target.canonicalKey],
  };
}

export async function resolveWorkerSessionToolSource(params: {
  identity: WorkerConnectionIdentity;
  placements: WorkerSessionPlacementStore;
}): Promise<WorkerSessionToolSource> {
  const identity = params.identity;
  const claim = identity.turnClaim;
  if (!identity.sessionId || !claim || claim.owner.kind !== "worker") {
    throw new Error("Worker session operation requires an active source turn");
  }
  const authority = await params.placements.prepareTurnClaimAuthority(claim);
  try {
    const source = authority.identity;
    const assertCurrent = () => {
      if (!authority.isCurrent()) {
        throw new Error("Worker source session placement changed");
      }
    };
    const bound = getWorkerTurnExecutionIdentityCapability(params.placements, claim)?.sessionTarget;
    const loaded = bound
      ? {
          canonicalKey: bound.sessionKey,
          entry: await withSessionEntryReadOnlyInWorker(bound, assertCurrent, async (read) => {
            if (!read.ok) {
              throw read.error;
            }
            return read.value;
          }),
        }
      : await readWorkerSessionToolEntry(source.sessionKey, source.agentId);
    assertCurrent();
    if (
      loaded.canonicalKey !== source.sessionKey ||
      loaded.entry?.sessionId !== identity.sessionId ||
      loaded.entry.archivedAt !== undefined
    ) {
      throw new Error("Worker source session incarnation changed");
    }
    return {
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      sessionId: identity.sessionId,
      turnClaim: { ...claim, owner: claim.owner },
      entry: loaded.entry,
    };
  } finally {
    authority.release();
  }
}

export async function resolveWorkerSessionToolTarget(params: {
  source: WorkerSessionToolSource;
  requestedSessionKey: string;
}): Promise<WorkerSessionToolTarget> {
  const loaded = await readWorkerSessionToolEntry(params.requestedSessionKey);
  const entry = loaded.entry;
  const targetSessionId = entry?.sessionId;
  if (
    loaded.canonicalKey !== params.requestedSessionKey ||
    !targetSessionId ||
    !entry ||
    entry.archivedAt !== undefined ||
    targetSessionId === params.source.sessionId
  ) {
    throw new Error("Worker sessions_send target is not an exact live session");
  }
  const sourceParent =
    relationKey(params.source.entry.parentSessionKey) ?? relationKey(params.source.entry.spawnedBy);
  const sourceParentId = relationKey(params.source.entry.parentSessionId);
  const targetParent = relationKey(entry.parentSessionKey) ?? relationKey(entry.spawnedBy);
  const targetParentId = relationKey(entry.parentSessionId);
  const parentToChild =
    targetParent === params.source.sessionKey && targetParentId === params.source.sessionId;
  const childToParent = sourceParent === loaded.canonicalKey && sourceParentId === targetSessionId;
  const sharedParentIncarnation = Boolean(
    sourceParent &&
    sourceParentId &&
    sourceParent === targetParent &&
    sourceParentId === targetParentId,
  );
  const parent =
    sharedParentIncarnation && sourceParent && sourceParentId
      ? await readWorkerSessionToolEntry(sourceParent)
      : undefined;
  const siblingToSibling = Boolean(
    parent &&
    parent.canonicalKey === sourceParent &&
    parent.entry?.sessionId === sourceParentId &&
    parent.entry?.archivedAt === undefined,
  );
  if (!parentToChild && !childToParent && !siblingToSibling) {
    throw new Error("Worker sessions_send target is outside the authorized session tree");
  }
  // Session identity owns messaging authority. Target turn admission chooses
  // its execution placement, including Gateway-local or reclaimed workers.
  return {
    agentId: loaded.agentId,
    sessionKey: loaded.canonicalKey,
    sessionId: targetSessionId,
    storePath: loaded.storePath,
    ...(siblingToSibling && parent && sourceParent && sourceParentId
      ? {
          topologyParent: {
            agentId: parent.agentId,
            sessionKey: sourceParent,
            sessionId: sourceParentId,
            storePath: parent.storePath,
          },
        }
      : {}),
  };
}

export async function assertWorkerSessionToolChild(params: {
  childSessionKey: string;
  childSessionId: string;
  sourceSessionKey: string;
  sourceSessionId: string;
  targetAgentId: string;
  storePath: string;
}): Promise<void> {
  const loaded = await readWorkerSessionToolEntry(params.childSessionKey, params.targetAgentId);
  const parent =
    relationKey(loaded.entry?.parentSessionKey) ?? relationKey(loaded.entry?.spawnedBy);
  const parentSessionId = relationKey(loaded.entry?.parentSessionId);
  if (
    loaded.canonicalKey !== params.childSessionKey ||
    loaded.storePath !== params.storePath ||
    loaded.entry?.sessionId !== params.childSessionId ||
    loaded.entry.archivedAt !== undefined ||
    parent !== params.sourceSessionKey ||
    parentSessionId !== params.sourceSessionId
  ) {
    throw new Error("Spawned cloud child session incarnation changed");
  }
}
