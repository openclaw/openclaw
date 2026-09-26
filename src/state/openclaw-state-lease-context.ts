import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawStateLeaseAcquisition,
  OpenClawStateLeaseIdentity,
} from "./openclaw-state-lease-store.js";

export type OpenClawStateLeaseContext = {
  signal: AbortSignal;
  /** Renew before a blocking phase, carrying this caller's authority into timer renewal.
   * Renew again after a temporary authority scope ends to restore the caller's context. */
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
      schemaPolicy?: "existing";
    };
    output: OpenClawStateLeaseAcquisition;
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
    input: {
      identity: OpenClawStateLeaseIdentity;
      operationLabel: string;
      databaseIdentity: string;
    };
    output: void;
  };
};
