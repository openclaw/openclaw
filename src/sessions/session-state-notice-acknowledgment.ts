import { captureSystemEventStoreCurrentCheck } from "../infra/system-event-ownership.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { SessionStateNotice } from "./session-state-events.kernel.js";
import type { SessionStateWatchAddress } from "./session-state-events.worker-contract.js";
import {
  runSessionWatchOperation,
  type SessionWatchOptions,
} from "./session-state-watch-operation.js";

const log = createSubsystemLogger("sessions/state-events");

/** Publish committed followups while their original worker and watcher authority remains current. */
export async function acknowledgeSessionStateNoticesInWorker(
  watcherSessionKey: string,
  notices: readonly SessionStateWatchAddress[],
  publishNotice: (notice: SessionStateNotice) => void,
  options: SessionWatchOptions = {},
): Promise<void> {
  try {
    const context = captureOpenClawStateWorkerContext(options);
    const now = options.now ?? Date.now();
    const isStoreCurrent = captureSystemEventStoreCurrentCheck(watcherSessionKey);
    const cursors = [
      ...new Map(
        notices
          .filter((notice) => isStoreCurrent(notice.watcherStorePath))
          .map((notice) => [notice.targetSessionKey, { ...notice }]),
      ).values(),
    ];
    const assertCurrent = () => {
      options.assertCurrent?.();
      for (const cursor of cursors) {
        if (!isStoreCurrent(cursor.watcherStorePath)) {
          throw new Error("Session watch acknowledgment lost its system-event store");
        }
      }
    };
    await runSessionWatchOperation(
      context,
      async (scope) => {
        if (cursors.length === 0) {
          return;
        }
        const followups = await scope.execute({
          type: "sessionState.acknowledge",
          input: {
            watcherSessionKey,
            cursors,
            now,
            sessionEntryCurrentSources: options.sessionEntriesCurrent?.sources,
          },
        });
        context.admission.assertCurrent();
        assertCurrent();
        for (const followup of followups) {
          publishNotice(followup);
        }
      },
      assertCurrent,
      options.sessionEntriesCurrent,
    );
  } catch (error) {
    log.warn(`failed to acknowledge session state notices: ${String(error)}`);
  }
}
