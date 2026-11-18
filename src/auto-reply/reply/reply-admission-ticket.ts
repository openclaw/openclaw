import { normalizeStringifiedEntries } from "@openclaw/normalization-core/string-coerce";
import {
  createKeyedFifoLeaseRegistry,
  type KeyedFifoLease,
} from "../../shared/keyed-fifo-lease.js";

export const REPLY_ADMISSION_TICKET = Symbol("openclaw.replyAdmissionTicket");
type ReplyAdmissionTicket = KeyedFifoLease & {
  /** Keep this source's existing place until its bounded settlement finishes. */
  holdUntil(settled: Promise<void>): void;
};
export type ReplyOptionsWithAdmissionTicket = {
  [REPLY_ADMISSION_TICKET]?: ReplyAdmissionTicket;
};

const replyAdmissionTickets = createKeyedFifoLeaseRegistry(
  Symbol.for("openclaw.replyAdmissionTickets"),
);

/** Briefly orders queue publication across a command's source and target sessions. */
export function reserveReplyAdmissionTicket(
  sessionKeys: ReadonlyArray<string | undefined>,
): ReplyAdmissionTicket | undefined {
  const lease = replyAdmissionTickets.reserve(normalizeStringifiedEntries(sessionKeys));
  if (!lease) {
    return undefined;
  }
  let hold: Promise<void> | undefined;
  let released = false;
  return {
    wait: (signal) => lease.wait(signal),
    holdUntil(settled) {
      if (!released) {
        hold ??= settled;
      }
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      if (hold) {
        const release = () => lease.release();
        void hold.then(release, release);
      } else {
        lease.release();
      }
    },
  };
}
