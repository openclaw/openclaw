import type { StateLeaseProcessOwner } from "../infra/state-lease-process-owner.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";
import type { OpenClawStateWorkerErrorPayload } from "./openclaw-state-worker-error.js";

// Allow headroom over observed 38 s cold Gateway boots under load; committed lease expiry still bounds startup.
export const LEASE_HEARTBEAT_START_TIMEOUT_MS = 60_000;
export const LEASE_CONTENTION_RETRY_MS = 25;
export const LEASE_CONTENTION_RETRY_TIMEOUT_MS = 2_000;

export const leaseHeartbeatState = {
  status: 0,
  request: 1,
  ack: 2,
  expiresAt: 3,
  lastRenewedAt: 4,
  startupPhase: 5,
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
  /** Odd while native renewal is in flight; progress is never lease authority. */
  renewalProgress: SharedArrayBuffer;
  /** Latest completed asynchronous request; completion is never lease authority. */
  completedRequest: SharedArrayBuffer;
};

export type LeaseHeartbeatRequest = {
  id: number;
  operation: "verify" | "renew";
};

export type LeaseHeartbeatParentMessage = LeaseHeartbeatRequest | { startup: "activate" } | null;

export type LeaseHeartbeatReply =
  | LeaseHeartbeatRenewalFailure
  | { loss: LeaseHeartbeatLoss }
  | { startup: "prepared" }
  | { id: number; ok: true; expiresAt: number }
  | { id: number; ok: false; message: string; payload?: OpenClawStateWorkerErrorPayload };
