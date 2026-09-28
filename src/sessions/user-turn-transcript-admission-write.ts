import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import type { UserTurnTranscriptAdmissionReceipt } from "./user-turn-transcript.types.js";

type AdmissionHandler = (admission: UserTurnTranscriptAdmissionReceipt) => void | Promise<void>;

/**
 * Tracks the durable write a recorder's admission handler starts, so persistence
 * and runtime waits settle it instead of leaving it running beside the turn.
 */
export function createUserTurnAdmissionWrite() {
  let handler: AdmissionHandler | undefined;
  let write: Promise<void> | undefined;
  return {
    setHandler(next: AdmissionHandler): void {
      handler = next;
    },
    /**
     * An unawaited write reported from inside a session write lane is started
     * detached, so it queues behind that lane instead of reentering it.
     */
    start(admission: UserTurnTranscriptAdmissionReceipt, detached: boolean): Promise<void> {
      const run = async () => {
        await handler?.(admission);
      };
      const started = detached ? runInDetachedAsyncContext(run) : run();
      // Awaiting callers observe a failure; this only prevents an unobserved rejection.
      started.catch(() => undefined);
      write = started;
      return started;
    },
    get pending(): Promise<void> | undefined {
      return write;
    },
  };
}
