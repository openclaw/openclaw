import type { DatabaseSync } from "node:sqlite";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";

export type OpenClawStateMutationOperation<T, R> = {
  /** Fresh executor authority. Checked by every coordinated canonical write. */
  assertCurrent: () => void;
  mutate: (assertCurrent: () => void) => Promise<T>;
  capture: (mutated: T, assertCurrent: () => void) => Promise<R>;
  bind: (captured: R, assertCurrent: () => void) => undefined;
};

export type OpenClawStateLeaseContext = {
  signal: AbortSignal;
  /** Asynchronous canonical mutation under physical exclusion, followed by
   * owner-held capture and synchronous binding before writers resume. */
  withDatabaseFileMutation?<T, R>(
    this: void,
    operation: OpenClawStateMutationOperation<T, R>,
  ): Promise<R>;
  /** Drain the heartbeat and capture while the original durable lease remains live. */
  withDatabaseFileExclusion?<T>(
    this: void,
    operation: (assertCurrent: () => void) => Promise<T>,
    bindCaptured?: (captured: T, assertCurrent: () => void) => undefined,
  ): Promise<T>;
  /** Renew or verify independent renewal before another blocking phase. */
  renew?(): void;
  /** Verify that this exact owner holds a non-expired lease at this instant. */
  assertOwned(): void;
  /** Verify ownership using the caller's active write transaction. */
  assertOwnedInTransaction(database: DatabaseSync): void;
};

/** Ordinary runtime leases whose durable checks and renewal are awaited. */
export type OpenClawStateAsyncLeaseContext = {
  signal: AbortSignal;
  assertOwned(): Promise<void>;
  renew(): Promise<void>;
};

export type OpenClawStateWorkerLeaseContext =
  | OpenClawStateLeaseContext
  | OpenClawStateAsyncLeaseContext;

export type OpenClawStateLeaseLifecycleOperations = {
  "stateLease.acquire": {
    input: {
      identity: OpenClawStateLeaseIdentity;
      leaseMs: number;
      operationLabel: string;
      observeExpiry?: true;
    };
    output: number | undefined;
  };
  "stateLease.verify": {
    input: { identity: OpenClawStateLeaseIdentity };
    output: number;
  };
  "stateLease.renew": {
    input: {
      identity: OpenClawStateLeaseIdentity;
      leaseMs: number;
      operationLabel: string;
    };
    output: number;
  };
  "stateLease.release": {
    input: { identity: OpenClawStateLeaseIdentity; operationLabel: string };
    output: void;
  };
};
