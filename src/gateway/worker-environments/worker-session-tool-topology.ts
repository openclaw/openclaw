import { listAgentIds } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { isCurrentPlacementTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";

export type WorkerSessionToolSource = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  turnClaim: NonNullable<WorkerConnectionIdentity["turnClaim"]> & {
    owner: { kind: "worker"; environmentId: string; ownerEpoch: number };
  };
  entry: NonNullable<ReturnType<typeof loadGatewaySessionEntryReadOnly>["entry"]>;
};

export type WorkerSessionToolTarget = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  topologyParent?: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
  };
};

function relationKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export { relationKey as workerSessionRelationKey };

function resolveWorkerSourcePlacement(params: {
  identity: WorkerConnectionIdentity;
  placements: WorkerSessionPlacementStore;
}) {
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
  return { placement, claim: { ...claim, owner: claim.owner }, sessionId: identity.sessionId };
}

export async function prepareWorkerSessionToolSource(
  params: Parameters<typeof resolveWorkerSourcePlacement>[0],
) {
  const initial = resolveWorkerSourcePlacement(params);
  const { agentId, sessionKey } = initial.placement;
  const prepared = await prepareSessionMutationFacts({
    cfg: getRuntimeConfig(),
    agentId,
    sessionKey,
    allowMissing: true,
  });
  const readSession = () => {
    const target = prepared.readCurrent(getRuntimeConfig()).target;
    if (
      !target ||
      target.agentId !== agentId ||
      target.canonicalKey !== sessionKey ||
      target.entry.sessionId !== initial.sessionId ||
      target.entry.archivedAt !== undefined
    ) {
      throw new Error("Worker source session incarnation changed");
    }
    return target.entry;
  };
  const assertCurrent = () => {
    const { placement } = resolveWorkerSourcePlacement(params);
    if (placement.agentId !== agentId || placement.sessionKey !== sessionKey) {
      throw new Error("Worker source session placement changed");
    }
    readSession();
  };
  try {
    assertCurrent();
    const source: WorkerSessionToolSource = {
      agentId,
      sessionKey,
      sessionId: initial.sessionId,
      turnClaim: initial.claim,
      get entry() {
        return readSession();
      },
    };
    return { source, assertCurrent, release: prepared.release };
  } catch (error) {
    prepared.release();
    throw error;
  }
}

export async function prepareWorkerSessionToolTarget(params: {
  source: WorkerSessionToolSource;
  requestedSessionKey: string;
}) {
  const cfg = getRuntimeConfig();
  const prepare = (agentId: string, sessionKey: string) =>
    prepareSessionMutationFacts({ cfg, agentId, sessionKey, allowMissing: true });
  const reads: Array<Awaited<ReturnType<typeof prepare>>> = [];
  const parentReads: typeof reads = [];
  let targetRead: (typeof reads)[number] | undefined;
  const sourceEntry = params.source.entry;
  const parentKey = relationKey(sourceEntry.parentSessionKey) ?? relationKey(sourceEntry.spawnedBy);
  const parentSessionId = relationKey(sourceEntry.parentSessionId);
  const release = () => {
    for (const read of reads.splice(0).toReversed()) {
      read.release();
    }
  };
  const readParent = () => {
    const entry = params.source.entry;
    const currentKey = relationKey(entry.parentSessionKey) ?? relationKey(entry.spawnedBy);
    const id = relationKey(entry.parentSessionId);
    if (!parentKey || !parentSessionId || currentKey !== parentKey || id !== parentSessionId) {
      return undefined;
    }
    const matches = new Map<
      string,
      NonNullable<ReturnType<(typeof reads)[number]["readCurrent"]>["target"]>
    >();
    for (const read of parentReads) {
      const target = read.readCurrent(getRuntimeConfig()).target;
      if (target?.canonicalKey === parentKey && target.entry.sessionId === parentSessionId) {
        matches.set(`${target.agentId}\0${target.canonicalKey}`, target);
      }
    }
    const parent = matches.size === 1 ? matches.values().next().value : undefined;
    return parent?.entry.archivedAt === undefined ? parent : undefined;
  };
  const readCurrent = (): WorkerSessionToolTarget => {
    const parent = params.requestedSessionKey === parentKey ? readParent() : undefined;
    const loaded =
      params.requestedSessionKey === parentKey
        ? parent
        : targetRead?.readCurrent(getRuntimeConfig()).target;
    const entry = loaded?.entry;
    const targetSessionId = entry?.sessionId;
    if (
      loaded?.canonicalKey !== params.requestedSessionKey ||
      !targetSessionId ||
      !entry ||
      entry.archivedAt !== undefined ||
      targetSessionId === params.source.sessionId
    ) {
      throw new Error("Worker sessions_send target is not an exact live session");
    }
    const targetParent = relationKey(entry.parentSessionKey) ?? relationKey(entry.spawnedBy);
    const targetParentId = relationKey(entry.parentSessionId);
    const parentToChild =
      targetParent === params.source.sessionKey && targetParentId === params.source.sessionId;
    const childToParent = loaded === parent;
    const siblingParent =
      !parentToChild &&
      !childToParent &&
      targetParent === parentKey &&
      targetParentId === parentSessionId
        ? readParent()
        : undefined;
    if (!parentToChild && !childToParent && !siblingParent) {
      throw new Error("Worker sessions_send target is outside the authorized session tree");
    }
    // Session identity owns messaging authority. Target turn admission chooses
    // its execution placement, including Gateway-local or reclaimed workers.
    return {
      agentId: loaded.agentId,
      sessionKey: loaded.canonicalKey,
      sessionId: targetSessionId,
      ...(siblingParent
        ? {
            topologyParent: {
              agentId: siblingParent.agentId,
              sessionKey: siblingParent.canonicalKey,
              sessionId: siblingParent.entry.sessionId,
            },
          }
        : {}),
    };
  };
  try {
    if (params.requestedSessionKey !== parentKey) {
      const owner = resolveRequestedSessionAgentId(cfg, params.requestedSessionKey);
      if (!owner.ok) {
        throw new Error("Worker sessions_send target is not an exact live session");
      }
      targetRead = await prepare(owner.agentId, params.requestedSessionKey);
      reads.push(targetRead);
    }
    const target = targetRead?.readCurrent(getRuntimeConfig()).target;
    const directChild =
      target?.entry &&
      (relationKey(target.entry.parentSessionKey) ?? relationKey(target.entry.spawnedBy)) ===
        params.source.sessionKey &&
      relationKey(target.entry.parentSessionId) === params.source.sessionId;
    if (!directChild && parentKey && parentSessionId) {
      const keyAgentId = parseAgentSessionKey(parentKey)?.agentId;
      const owners = new Set<string>();
      for (const candidate of keyAgentId ? [keyAgentId] : listAgentIds(cfg)) {
        const owner = resolveRequestedSessionAgentId(cfg, parentKey, candidate);
        if (owner.ok) {
          owners.add(owner.agentId);
        }
      }
      for (const agentId of owners) {
        const read = await prepare(agentId, parentKey);
        reads.push(read);
        parentReads.push(read);
      }
    }
    readCurrent();
    return { readCurrent, release };
  } catch (error) {
    release();
    throw error;
  }
}

export function assertWorkerSessionToolChild(params: {
  childSessionKey: string;
  childSessionId: string;
  sourceSessionKey: string;
  sourceSessionId: string;
  targetAgentId: string;
}): void {
  const loaded = loadGatewaySessionEntryReadOnly(params.childSessionKey, {
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
