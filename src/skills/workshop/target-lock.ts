import { withOpenClawStateLeaseAsync } from "../../state/openclaw-state-lease.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import { captureSkillWorkshopStoreOptions, ensureSkillWorkshopStore } from "./store-client.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import type { SkillProposalRecord } from "./types.js";

const TARGET_LEASE_MS = 60_000;
const TARGET_LEASE_WAIT_MS = 5_000;
const COLLECTION_LEASE_MS = 10 * 60_000;

type CapturedStore = ReturnType<typeof captureSkillWorkshopStoreOptions>;

function requireAgentId(options: SkillWorkshopStoreOptions): string {
  if (!options.agentId) {
    throw new Error("Skill Workshop requires an agent id for storage ownership.");
  }
  return options.agentId;
}

/** Each agent owns one collection lease; writers for different agents do not contend. */
export async function withSkillCollectionLock<T>(
  fn: (store: CapturedStore) => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  const store = captureSkillWorkshopStoreOptions(options);
  const key = requireAgentId(store);
  await ensureSkillWorkshopStore(store);
  return withOpenClawStateLeaseAsync(
    {
      scope: "skill-collection",
      key,
      leaseMs: COLLECTION_LEASE_MS,
      waitMs: TARGET_LEASE_WAIT_MS,
      leaseLabel: "skill collection lease",
      operationLabel: "skill-collection.commit",
    },
    store.execution.context,
    (lease) =>
      fn({
        ...store,
        execution: { ...store.execution, leases: [...store.execution.leases, lease] },
      }),
  );
}

export async function withSkillProposalTargetLock<T>(
  record: SkillProposalRecord,
  fn: (store: CapturedStore) => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  const store = captureSkillWorkshopStoreOptions(options);
  const key = `${requireAgentId(store)}:${hashSkillProposalContent(record.target.skillFile)}`;
  await ensureSkillWorkshopStore(store);
  return withOpenClawStateLeaseAsync(
    {
      scope: "skill-workshop-target",
      key,
      leaseMs: TARGET_LEASE_MS,
      waitMs: TARGET_LEASE_WAIT_MS,
      leaseLabel: "Skill Workshop target lease",
      operationLabel: "skill-workshop.target-lease",
    },
    store.execution.context,
    (lease) =>
      fn({
        ...store,
        execution: { ...store.execution, leases: [...store.execution.leases, lease] },
      }),
  );
}

export function withSkillProposalCommitLock<T>(
  record: SkillProposalRecord,
  fn: (store: CapturedStore) => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  return withSkillCollectionLock(
    (store) => withSkillProposalTargetLock(record, fn, store),
    options,
  );
}
