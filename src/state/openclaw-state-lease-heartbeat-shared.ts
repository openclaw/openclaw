import type { MessagePort } from "node:worker_threads";
import type { DatabaseEngineSelection } from "../infra/database-engine/context.js";
import type { StateLeaseProcessOwner } from "../infra/state-lease-process-owner.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";
import type { OpenClawStateWorkerErrorPayload } from "./openclaw-state-worker-error.js";

// Allow headroom over observed 38 s cold Gateway boots under load; committed lease expiry still bounds startup.
export const LEASE_HEARTBEAT_START_TIMEOUT_MS = 60_000;
export const LEASE_CONTENTION_RETRY_MS = 25;
export const LEASE_CONTENTION_RETRY_TIMEOUT_MS = 2_000;

export const leaseHeartbeatState = {
  status: 0,
  expiresAt: 3,
  lastRenewedAt: 4,
  startupPhase: 5,
  ownerFence: 6,
  starting: 0n,
  ready: 1n,
  closed: 2n,
  lost: 3n,
} as const;

// Startup observations never grant readiness or lease authority.
export const leaseHeartbeatStartupPhase = {
  "entry-not-observed": 0n,
  "body-entry": 1n,
  "open-complete": 2n,
  "initial-renew-start": 3n,
  "initial-renew-returned": 4n,
} as const;

export type LeaseHeartbeatRenewalFailure = {
  name: string;
  message: string;
  code?: string;
  errcode?: number;
  attempt: number;
  elapsedMs: number;
};

export type LeaseHeartbeatLoss = {
  path: "automatic-renewal" | "activation" | "explicit-verify" | "explicit-renew";
  outcome: "no-current-owned-unexpired-row" | "operation-error";
};

export type LeaseHeartbeatWorkerData = {
  databaseEngineSelection?: DatabaseEngineSelection;
  databaseAdmissionPort: MessagePort;
  path: string;
  expectedIdentity: string;
  /** The actor's startup operations settle before this worker begins renewal. */
  deferActivation?: true;
  identity: OpenClawStateLeaseIdentity;
  leaseMs: number;
  acquiredAt: number;
  heartbeatMs: number;
  processOwner?: { identity: StateLeaseProcessOwner; env: NodeJS.ProcessEnv };
  shared: SharedArrayBuffer;
  /** Odd while a native renewal must settle before worker termination. */
  renewalProgress: SharedArrayBuffer;
};

export type LeaseHeartbeatRequest = {
  id: number;
  operation: "verify" | "renew";
};

export type LeaseHeartbeatParentMessage = LeaseHeartbeatRequest | { startup: "activate" };

export type LeaseHeartbeatReply =
  | LeaseHeartbeatRenewalFailure
  | { loss: LeaseHeartbeatLoss }
  | { startup: "prepared" }
  | { id: number; ok: true; expiresAt: number }
  | { id: number; ok: false; message: string; payload?: OpenClawStateWorkerErrorPayload };
