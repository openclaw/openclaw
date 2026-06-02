import { randomUUID } from "node:crypto";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";

const NODE_PENDING_WORK_TYPES = ["status.request", "location.request"] as const;
export type NodePendingWorkType = (typeof NODE_PENDING_WORK_TYPES)[number];

const NODE_PENDING_WORK_PRIORITIES = ["default", "normal", "high"] as const;
export type NodePendingWorkPriority = (typeof NODE_PENDING_WORK_PRIORITIES)[number];

type NodePendingWorkItem = {
  id: string;
  type: NodePendingWorkType;
  priority: NodePendingWorkPriority;
  createdAtMs: number;
  expiresAtMs: number | null;
  payload?: Record<string, unknown>;
};

type NodePendingWorkState = {
  revision: number;
  itemsById: Map<string, NodePendingWorkItem>;
};

type DrainOptions = {
  maxItems?: number;
  includeDefaultStatus?: boolean;
  nowMs?: number;
};

type DrainResult = {
  revision: number;
  items: NodePendingWorkItem[];
  hasMore: boolean;
};

const DEFAULT_STATUS_ITEM_ID = "baseline-status";
const DEFAULT_STATUS_PRIORITY: NodePendingWorkPriority = "default";
const DEFAULT_PRIORITY: NodePendingWorkPriority = "normal";
const DEFAULT_MAX_ITEMS = 4;
const MAX_ITEMS = 10;
const PRIORITY_RANK: Record<NodePendingWorkPriority, number> = {
  high: 3,
  normal: 2,
  default: 1,
};

const stateByNodeId = new Map<string, NodePendingWorkState>();

/** Returns the mutable in-memory queue state for a node, creating it on first enqueue. */
function getOrCreateState(nodeId: string): NodePendingWorkState {
  let state = stateByNodeId.get(nodeId);
  if (!state) {
    state = {
      revision: 0,
      itemsById: new Map(),
    };
    stateByNodeId.set(nodeId, state);
  }
  return state;
}

/** Removes expired explicit items and bumps the revision only when the queue changed. */
function pruneExpired(state: NodePendingWorkState, nowMs: number): boolean {
  const validNowMs = asDateTimestampMs(nowMs);
  if (validNowMs === undefined) {
    return false;
  }
  let changed = false;
  for (const [id, item] of state.itemsById) {
    if (
      item.expiresAtMs !== null &&
      !isFutureDateTimestampMs(item.expiresAtMs, { nowMs: validNowMs })
    ) {
      state.itemsById.delete(id);
      changed = true;
    }
  }
  if (changed) {
    state.revision += 1;
  }
  return changed;
}

/** Drops empty node queues so baseline-only drains do not accumulate state. */
function pruneStateIfEmpty(nodeId: string, state: NodePendingWorkState) {
  if (state.itemsById.size === 0) {
    stateByNodeId.delete(nodeId);
  }
}

/** Orders explicit work before drain, with high-priority work first and stable ties. */
function sortedItems(state: NodePendingWorkState): NodePendingWorkItem[] {
  return [...state.itemsById.values()].toSorted((a, b) => {
    const priorityDelta = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    if (a.createdAtMs !== b.createdAtMs) {
      return a.createdAtMs - b.createdAtMs;
    }
    return a.id.localeCompare(b.id);
  });
}

/** Synthesizes the always-available status refresh item without storing it. */
function makeBaselineStatusItem(nowMs: number): NodePendingWorkItem {
  return {
    id: DEFAULT_STATUS_ITEM_ID,
    type: "status.request",
    priority: DEFAULT_STATUS_PRIORITY,
    createdAtMs: resolveDateTimestampMs(nowMs),
    expiresAtMs: null,
  };
}

/** Converts optional relative expiry into a bounded absolute timestamp. */
function resolvePendingWorkExpiresAtMs(expiresInMs: unknown, nowMs: number): number | null {
  if (typeof expiresInMs !== "number" || !Number.isFinite(expiresInMs)) {
    return null;
  }
  return resolveExpiresAtMsFromDurationMs(Math.max(1_000, Math.trunc(expiresInMs)), { nowMs }) ?? 0;
}

/** Queues one pending work item per node/type and returns the queue revision. */
export function enqueueNodePendingWork(params: {
  nodeId: string;
  type: NodePendingWorkType;
  priority?: NodePendingWorkPriority;
  expiresInMs?: number;
  payload?: Record<string, unknown>;
}): { revision: number; item: NodePendingWorkItem; deduped: boolean } {
  const nodeId = params.nodeId.trim();
  if (!nodeId) {
    throw new Error("nodeId required");
  }
  const rawNowMs = Date.now();
  const nowMs = resolveDateTimestampMs(rawNowMs);
  const state = getOrCreateState(nodeId);
  pruneExpired(state, nowMs);
  const existing = [...state.itemsById.values()].find((item) => item.type === params.type);
  if (existing) {
    // Work is type-deduped so repeated wake requests do not create unbounded
    // queues while the node is offline.
    return { revision: state.revision, item: existing, deduped: true };
  }
  const item: NodePendingWorkItem = {
    id: randomUUID(),
    type: params.type,
    priority: params.priority ?? DEFAULT_PRIORITY,
    createdAtMs: nowMs,
    expiresAtMs: resolvePendingWorkExpiresAtMs(params.expiresInMs, rawNowMs),
    ...(params.payload ? { payload: params.payload } : {}),
  };
  state.itemsById.set(item.id, item);
  state.revision += 1;
  return { revision: state.revision, item, deduped: false };
}

/** Drains explicit work plus an optional synthetic baseline status item. */
export function drainNodePendingWork(nodeId: string, opts: DrainOptions = {}): DrainResult {
  const normalizedNodeId = nodeId.trim();
  if (!normalizedNodeId) {
    return { revision: 0, items: [], hasMore: false };
  }
  const nowMs = resolveDateTimestampMs(opts.nowMs ?? Date.now());
  const state = stateByNodeId.get(normalizedNodeId);
  if (state) {
    pruneExpired(state, nowMs);
    pruneStateIfEmpty(normalizedNodeId, state);
  }
  const revision = state?.revision ?? 0;
  const maxItems = Math.min(MAX_ITEMS, Math.max(1, Math.trunc(opts.maxItems ?? DEFAULT_MAX_ITEMS)));
  const explicitItems = state ? sortedItems(state) : [];
  const items = explicitItems.slice(0, maxItems);
  const hasExplicitStatus = explicitItems.some((item) => item.type === "status.request");
  const includeBaseline = opts.includeDefaultStatus !== false && !hasExplicitStatus;
  if (includeBaseline && items.length < maxItems) {
    // Baseline status keeps reconnecting nodes polling their current state even
    // when no explicit queued work exists.
    items.push(makeBaselineStatusItem(nowMs));
  }
  const explicitReturnedCount = items.filter((item) => item.id !== DEFAULT_STATUS_ITEM_ID).length;
  const baselineIncluded = items.some((item) => item.id === DEFAULT_STATUS_ITEM_ID);
  return {
    revision,
    items,
    hasMore: explicitItems.length > explicitReturnedCount || (includeBaseline && !baselineIncluded),
  };
}

/** Acknowledges explicit queue items; the synthetic baseline item is never removed. */
export function acknowledgeNodePendingWork(params: { nodeId: string; itemIds: string[] }): {
  revision: number;
  removedItemIds: string[];
} {
  const nodeId = params.nodeId.trim();
  if (!nodeId) {
    return { revision: 0, removedItemIds: [] };
  }
  const state = stateByNodeId.get(nodeId);
  if (!state) {
    return { revision: 0, removedItemIds: [] };
  }
  const removedItemIds: string[] = [];
  for (const itemId of params.itemIds) {
    const trimmedId = itemId.trim();
    if (!trimmedId || trimmedId === DEFAULT_STATUS_ITEM_ID) {
      continue;
    }
    if (state.itemsById.delete(trimmedId)) {
      removedItemIds.push(trimmedId);
    }
  }
  if (removedItemIds.length > 0) {
    state.revision += 1;
  }
  pruneStateIfEmpty(nodeId, state);
  return { revision: state.revision, removedItemIds };
}

export function resetNodePendingWorkForTests() {
  stateByNodeId.clear();
}

export function getNodePendingWorkStateCountForTests(): number {
  return stateByNodeId.size;
}
