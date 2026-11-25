import type { SessionActivitySummary } from "../config/sessions/activity-summary.js";
import type { SessionEntry } from "../config/sessions/types.js";

export type SessionActivitySummaryCompletion = {
  take(): SessionActivitySummary | undefined;
  committed(entry: SessionEntry): void;
  release(): void;
};

export type PendingSessionActivitySummaryCompletion = SessionActivitySummaryCompletion & {
  markTerminal(): void;
  offer(summary: SessionActivitySummary): Promise<SessionEntry | undefined> | undefined;
};

/** A ready terminal recap borrows the turn's existing commit; late recaps write normally. */
export function beginActivitySummaryCompletion(owner: {
  completion?: PendingSessionActivitySummaryCompletion;
}): SessionActivitySummaryCompletion {
  owner.completion?.release();
  let summary: SessionActivitySummary | undefined;
  let settle: ((entry: SessionEntry | undefined) => void) | undefined;
  let closed = false;
  let terminal = false;
  const completion: PendingSessionActivitySummaryCompletion = {
    markTerminal() {
      terminal = true;
    },
    offer(value) {
      if (closed || !terminal) {
        return undefined;
      }
      summary = value;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    take() {
      // Completion takes only an already-ready recap; it never waits for the model.
      closed = true;
      return summary;
    },
    committed(entry) {
      settle?.(entry);
      settle = undefined;
    },
    release() {
      closed = true;
      if (owner.completion === completion) {
        owner.completion = undefined;
      }
      settle?.(undefined);
      settle = undefined;
    },
  };
  owner.completion = completion;
  return completion;
}
