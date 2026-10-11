import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionPendingInputAuthority } from "./session-pending-input-authority.js";
import type { SessionPendingInputState } from "./session-pending-input-receipt.types.js";
import type { SessionPendingInputWorkerFacts } from "./session-pending-input.types.js";

export type SessionPendingInputOwner = Omit<
  SessionPendingInputWorkerFacts,
  "preparedAuthority" | "sources"
> & {
  /** Captured physical locator, or native incognito locator, for comparisons and workers. */
  workerDatabasePath: string;
  config?: OpenClawConfig;
  assertCurrent: () => void;
  authority?: SessionPendingInputAuthority;
  /** Published only after the exact input was consumed by a committed transcript write. */
  consumed?: true;
  /** Prompt authority is revoked; this owner still holds terminal disposition custody. */
  settling?: true;
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => void;
  restartRecovered?: true;
  /** Aggregate authority is the exact source closures, never persisted source identifiers. */
  sources?: readonly SessionPendingInputOwner[];
};
