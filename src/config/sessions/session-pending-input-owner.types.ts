import type { RequesterOrigin } from "../../agents/requester-origin.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionActorStorageBinding } from "./session-actor-storage-binding.js";
import type { SessionPendingInputAuthority } from "./session-pending-input-authority.js";
import type { SessionPendingInputEndCause } from "./session-pending-input-end-cause.types.js";
import type { SessionPendingInputState } from "./session-pending-input-receipt.types.js";
import type { SessionPendingInputWorkerFacts } from "./session-pending-input.types.js";

export type SessionPendingInputOwner = Omit<
  SessionPendingInputWorkerFacts,
  "preparedAuthority" | "sources"
> & {
  sessionActor?: SessionActorStorageBinding;
  /** Immutable facts decoded from this owner's accepted bytes before projections escape. */
  requesterOrigin?: RequesterOrigin;
  /** Captured physical locator, or native incognito locator, for comparisons and workers. */
  workerDatabasePath: string;
  config?: OpenClawConfig;
  assertCurrent: () => void;
  /** Foreign sampling retains each source locator and file generation through worker validation. */
  assertReadCurrent: () => void | Promise<void>;
  assertMentionInvitationCurrent?: () => void;
  authority?: SessionPendingInputAuthority;
  /** Published only after the exact input was consumed by a committed transcript write. */
  consumed?: true;
  /** Host-only link published with committed aggregate consumption. */
  promotedOwner?: SessionPendingInputOwner;
  /** Prompt authority is revoked; this owner still holds terminal disposition custody. */
  settling?: true;
  finish: (
    disposition: Exclude<SessionPendingInputState, "queued">,
    endCause: SessionPendingInputEndCause,
  ) => void;
  /** Release process custody without changing the durable input disposition. */
  release: () => void;
  /** Host-only staged retry custody; inbound dedupe spends it once. */
  dedupeRetryAvailable?: true;
  /** Graceful shutdown leaves this accepted input for the session's ordinary FIFO. */
  preserveQueuedForRestart?: true;
  /** Aggregate authority is the exact source closures, never persisted source identifiers. */
  sources?: readonly SessionPendingInputOwner[];
};
