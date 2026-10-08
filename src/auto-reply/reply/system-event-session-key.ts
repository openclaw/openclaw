import type { ExecRequestOwner } from "../../infra/exec-request-context.js";
import type { SystemEvent } from "../../infra/system-events.js";

const REPLY_SYSTEM_EVENT_CONTEXT = Symbol("openclaw.reply.systemEventContext");

type ReplySystemEventContext = {
  sessionKey: string;
  events?: readonly SystemEvent[];
  /** Captured occurrences whose delivery owner, not prompt admission, settles them. */
  deferredEventIds?: readonly string[];
  execRequestOwners?: readonly ExecRequestOwner[];
  /** Records the exact prompt-admitted occurrences for the deferred settlement owner. */
  onEventsAdmitted?: (events: readonly SystemEvent[]) => void;
};

/** Carry the queue and its optional prepared selection through internal option spreads. */
export function withReplySystemEventContext<T extends object>(
  options: T,
  context: ReplySystemEventContext,
): T {
  return { ...options, [REPLY_SYSTEM_EVENT_CONTEXT]: context };
}

/** An absent selection means an ordinary turn may inspect the current queue. */
export function getReplySystemEventContext(
  options: object | undefined,
): ReplySystemEventContext | undefined {
  // SAFETY: only this module-private symbol and its typed producer establish the value.
  return (options as { [REPLY_SYSTEM_EVENT_CONTEXT]?: ReplySystemEventContext } | undefined)?.[
    REPLY_SYSTEM_EVENT_CONTEXT
  ];
}
