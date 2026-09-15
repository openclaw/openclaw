import type { StateDatabaseCoordinatorRuntime } from "../infra/state-database-coordinator.js";
import type { StateLeaseProcessOwner } from "../infra/state-lease-process-owner.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";
import type { OpenClawStateWorkerErrorPayload } from "./openclaw-state-worker-error.js";

export const LEASE_HEARTBEAT_START_TIMEOUT_MS = 5_000;

export const leaseHeartbeatState = {
  status: 0,
  request: 1,
  ack: 2,
  expiresAt: 3,
  starting: 0n,
  ready: 1n,
  closed: 2n,
  lost: 3n,
} as const;

export type LeaseHeartbeatWorkerData = {
  path: string;
  existingOnly?: boolean;
  /** Private parent retains the actual lifecycle coordinator until native worker exit. */
  parentCoordinatorRetained?: true;
  retainedStartup?: {
    expectedIdentity: string;
    coordinatorRuntime: StateDatabaseCoordinatorRuntime;
  };
  identity: OpenClawStateLeaseIdentity;
  leaseMs: number;
  expiresAt: number;
  heartbeatMs: number;
  processOwner?: { identity: StateLeaseProcessOwner; env: NodeJS.ProcessEnv };
  shared: SharedArrayBuffer;
};

export type LeaseHeartbeatRequest = {
  id: number;
  operation: "verify" | "renew";
};

export type LeaseHeartbeatReply =
  | { id: number; ok: true; expiresAt: number }
  | { id: number; ok: false; message: string; payload?: OpenClawStateWorkerErrorPayload };
