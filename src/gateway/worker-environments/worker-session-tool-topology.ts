import { isDeepStrictEqual } from "node:util";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { isCurrentPlacementTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";

export type WorkerSessionToolRowRead = (
  sessionKey: string,
  options?: { agentId?: string },
) => {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry | undefined;
};

function topologyFacts(entry: SessionEntry | undefined) {
  return (
    entry && {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      archivedAt: entry.archivedAt,
      parentSessionKey: entry.parentSessionKey,
      parentSessionId: entry.parentSessionId,
      spawnedBy: entry.spawnedBy,
      spawnDepth: entry.spawnDepth,
      permissionMode: entry.permissionMode,
    }
  );
}

/** Existing worker read custody plus published row facts fence asynchronous topology consumers. */
export async function withPreparedWorkerSessionToolRows<T>(params: {
  resolveGatewayContext: GatewayContextResolver;
  sessionKeys: readonly string[];
  assertCurrent: () => void;
  consume: (read: WorkerSessionToolRowRead) => Promise<T>;
}): Promise<T> {
  const context = params.resolveGatewayContext();
  const projection = getSessionRowProjection(context);
  if (!context || !projection) {
    throw new Error("Worker session authority is unavailable.");
  }
  await projection.prepareMembership();
  const assertOwner = () => {
    params.assertCurrent();
    if (
      params.resolveGatewayContext() !== context ||
      getSessionRowProjection(context) !== projection
    ) {
      throw new Error("Worker session authority changed.");
    }
  };
  assertOwner();
  const prepared = new Map<
    string,
    { agentId: string; entry: SessionEntry | undefined; assertCurrent: () => void }
  >();
  const keys = [...new Set(params.sessionKeys)];
  const prepare = async (index: number): Promise<T> => {
    const key = keys[index];
    if (key === undefined) {
      return params.consume((sessionKey, options) => {
        assertOwner();
        for (const value of prepared.values()) {
          value.assertCurrent();
        }
        const row = prepared.get(sessionKey);
        if (!row || (options?.agentId && row.agentId !== options.agentId)) {
          throw new Error("Worker session row was not prepared.");
        }
        return { agentId: row.agentId, canonicalKey: sessionKey, entry: row.entry };
      });
    }
    const agentId = parseAgentSessionKey(key)?.agentId;
    if (!agentId) {
      throw new Error("Worker session operation requires a canonical session key.");
    }
    const initial = projection.sharingTargetState({ key, agentId });
    if (initial.status === "pending") {
      throw new Error("Worker session row is preparing; retry the operation.");
    }
    const storePath =
      initial.status === "ready"
        ? initial.target.storePath
        : resolveSessionStorePathCore(projection.getPolicyConfig().session?.store, { agentId });
    return withSessionEntryReadOnlyInWorker(
      { sessionKey: key, agentId, storePath },
      assertOwner,
      async (result, assertReadCurrent) => {
        if (!result.ok) {
          throw result.error;
        }
        const facts = structuredClone(topologyFacts(result.value));
        const assertCurrent = () => {
          assertReadCurrent();
          assertOwner();
          const current = projection.sharingTargetState({ key, agentId, storePath });
          if (
            current.status === "pending" ||
            (current.status === "ready"
              ? current.target.storePath !== storePath ||
                !isDeepStrictEqual(topologyFacts(current.target.entry), facts)
              : facts !== undefined)
          ) {
            throw new Error("Worker session topology changed during the operation.");
          }
        };
        assertCurrent();
        prepared.set(key, { agentId, entry: result.value, assertCurrent });
        return prepare(index + 1);
      },
    );
  };
  return prepare(0);
}

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
  topologyParent?: {
    sessionKey: string;
    sessionId: string;
  };
};

function relationKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export { relationKey as workerSessionRelationKey };

export function resolveWorkerSessionToolSource(params: {
  identity: WorkerConnectionIdentity;
  placements: WorkerSessionPlacementStore;
  readEntry: WorkerSessionToolRowRead;
}): WorkerSessionToolSource {
  const identity = params.identity;
  const claim = identity.turnClaim;
  if (!identity.sessionId || !claim || claim.owner.kind !== "worker") {
    throw new Error("Worker session operation requires an active source turn");
  }
  const placement = params.placements.get(identity.sessionId);
  if (
    !placement ||
    (placement.state !== "active" && placement.state !== "draining") ||
    !isCurrentPlacementTurnClaim(placement, claim)
  ) {
    throw new Error("Worker source session placement changed");
  }
  const loaded = params.readEntry(placement.sessionKey, {
    agentId: placement.agentId,
  });
  if (
    loaded.canonicalKey !== placement.sessionKey ||
    loaded.entry?.sessionId !== identity.sessionId ||
    loaded.entry.archivedAt !== undefined
  ) {
    throw new Error("Worker source session incarnation changed");
  }
  return {
    agentId: placement.agentId,
    sessionKey: placement.sessionKey,
    sessionId: identity.sessionId,
    turnClaim: { ...claim, owner: claim.owner },
    entry: loaded.entry,
  };
}

export function resolveWorkerSessionToolTarget(params: {
  source: WorkerSessionToolSource;
  requestedSessionKey: string;
  readEntry: WorkerSessionToolRowRead;
}): WorkerSessionToolTarget {
  const loaded = params.readEntry(params.requestedSessionKey);
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
      ? params.readEntry(sourceParent)
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
    ...(siblingToSibling && sourceParent && sourceParentId
      ? { topologyParent: { sessionKey: sourceParent, sessionId: sourceParentId } }
      : {}),
  };
}

export function assertWorkerSessionToolChild(params: {
  childSessionKey: string;
  childSessionId: string;
  sourceSessionKey: string;
  sourceSessionId: string;
  targetAgentId: string;
  readEntry: WorkerSessionToolRowRead;
}): void {
  const loaded = params.readEntry(params.childSessionKey, {
    agentId: params.targetAgentId,
  });
  const parent =
    relationKey(loaded.entry?.parentSessionKey) ?? relationKey(loaded.entry?.spawnedBy);
  const parentSessionId = relationKey(loaded.entry?.parentSessionId);
  if (
    loaded.canonicalKey !== params.childSessionKey ||
    loaded.entry?.sessionId !== params.childSessionId ||
    loaded.entry.archivedAt !== undefined ||
    parent !== params.sourceSessionKey ||
    parentSessionId !== params.sourceSessionId
  ) {
    throw new Error("Spawned cloud child session incarnation changed");
  }
}
