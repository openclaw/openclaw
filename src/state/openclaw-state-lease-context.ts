import type { DatabaseSync } from "node:sqlite";

export type OpenClawStateLeaseContext = {
  signal: AbortSignal;
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
