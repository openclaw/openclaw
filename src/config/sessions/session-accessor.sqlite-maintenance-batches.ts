import { groupPluginRecords as groupRecords } from "../../plugins/record-groups.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import type { SessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";

export const MAX_SESSION_MAINTENANCE_BATCH_ENTRIES = 64;
const MAX_SESSION_MAINTENANCE_BATCH_ARCHIVE_BYTES = 64 * 1024 * 1024;

type SessionMaintenanceBatch = {
  archiveBytes: number;
  entryRemovals: SessionEntryMaintenancePlan["entryRemovals"];
  stateDeletePlans: SessionStateDeletePlan[];
  workItems: number;
};

export function buildSessionMaintenanceBatches(params: {
  archiveBytesBySessionId: ReadonlyMap<string, number>;
  entryRemovals: SessionEntryMaintenancePlan["entryRemovals"];
  stateDeletePlans: readonly SessionStateDeletePlan[];
}): SessionMaintenanceBatch[] {
  const parent = params.entryRemovals.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root] ?? root;
    }
    let current = index;
    while (parent[current] !== current) {
      const next = parent[current] ?? root;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  const removalIndexBySessionId = new Map<string, number>();
  const removalIndexBySessionKey = new Map<string, number>();
  const addRemovalIndex = (sessionId: string, index: number): void => {
    const firstIndex = removalIndexBySessionId.get(sessionId);
    if (firstIndex === undefined) {
      removalIndexBySessionId.set(sessionId, index);
    } else {
      union(firstIndex, index);
    }
  };
  for (const [index, removal] of params.entryRemovals.entries()) {
    if (!removal.expectedEntry) {
      continue;
    }
    removalIndexBySessionKey.set(removal.sessionKey, index);
    for (const sessionId of collectSessionStateIdsForEntry(removal.expectedEntry)) {
      addRemovalIndex(sessionId, index);
    }
  }
  for (const plan of params.stateDeletePlans) {
    const ownerIndex = plan.snapshot.sessionKey
      ? removalIndexBySessionKey.get(plan.snapshot.sessionKey)
      : undefined;
    if (ownerIndex !== undefined) {
      addRemovalIndex(plan.sessionId, ownerIndex);
    }
  }

  const groupsByRoot = new Map<number, SessionMaintenanceBatch>();
  for (const [index, removal] of params.entryRemovals.entries()) {
    const root = find(index);
    const group = groupsByRoot.get(root) ?? {
      archiveBytes: 0,
      entryRemovals: [],
      stateDeletePlans: [],
      workItems: 0,
    };
    group.entryRemovals.push(removal);
    groupsByRoot.set(root, group);
  }

  const plansBySessionId = groupRecords(params.stateDeletePlans, (plan) => plan.sessionId);
  const standaloneGroups: SessionMaintenanceBatch[] = [];
  for (const [sessionId, plans] of plansBySessionId) {
    const removalIndex = removalIndexBySessionId.get(sessionId);
    const removalGroup =
      removalIndex === undefined ? undefined : groupsByRoot.get(find(removalIndex));
    const group = removalGroup ?? {
      archiveBytes: 0,
      entryRemovals: [],
      stateDeletePlans: [],
      workItems: 0,
    };
    group.stateDeletePlans.push(...plans);
    if (plans.some((plan) => plan.archiveTranscript)) {
      group.archiveBytes += params.archiveBytesBySessionId.get(sessionId) ?? 0;
    }
    if (!removalGroup) {
      standaloneGroups.push(group);
    }
  }

  const groups = [...groupsByRoot.values(), ...standaloneGroups];
  const batches: SessionMaintenanceBatch[] = [];
  let batch: SessionMaintenanceBatch = {
    archiveBytes: 0,
    entryRemovals: [],
    stateDeletePlans: [],
    workItems: 0,
  };
  const flush = (): void => {
    if (batch.workItems === 0) {
      return;
    }
    batches.push(batch);
    batch = { archiveBytes: 0, entryRemovals: [], stateDeletePlans: [], workItems: 0 };
  };
  // Limits apply between ownership groups. One inseparable group may exceed them so shared or
  // historical session state is never deleted in a different transaction from its last owner.
  for (const group of groups) {
    group.workItems = Math.max(
      group.entryRemovals.length,
      new Set(group.stateDeletePlans.map((plan) => plan.sessionId)).size,
    );
    const exceedsEntryLimit =
      batch.workItems > 0 &&
      batch.workItems + group.workItems > MAX_SESSION_MAINTENANCE_BATCH_ENTRIES;
    const exceedsByteLimit =
      batch.workItems > 0 &&
      batch.archiveBytes + group.archiveBytes > MAX_SESSION_MAINTENANCE_BATCH_ARCHIVE_BYTES;
    if (exceedsEntryLimit || exceedsByteLimit) {
      flush();
    }
    batch.archiveBytes += group.archiveBytes;
    batch.entryRemovals.push(...group.entryRemovals);
    batch.stateDeletePlans.push(...group.stateDeletePlans);
    batch.workItems += group.workItems;
  }
  flush();
  return batches;
}
