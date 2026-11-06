import type { StateLeaseProcessOwner } from "../../infra/state-lease-process-owner.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import type { WorktreeRegistryPredicate } from "./types.js";

export const WORKTREE_CREATE_LEASE_SCOPE = "core:managed-worktrees:create";
export const WORKTREE_MUTATION_LEASE_SCOPE = "core:managed-worktrees:mutation";
export const WORKTREE_CAPACITY_RESERVATION_SCOPE = "core:managed-worktrees:capacity-reservations";

export type WorktreeCapacityRequest = {
  key: string;
  owner: StateLeaseProcessOwner;
  demands: readonly { path: string; bytes: number }[];
  purpose: string;
  snapshot: boolean;
};

export type WorktreeCapacityResult =
  | { admitted: true }
  | { admitted: false; message: string; reservationKey?: string };

export type WorktreeCapacityWorkerInput = WorktreeCapacityRequest & {
  leases: readonly OpenClawStateLeaseIdentity[];
  predicates?: readonly WorktreeRegistryPredicate[];
};
