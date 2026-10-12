import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { preparePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { prepareSystemEventStorePath } from "../infra/system-event-ownership.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runSessionWatchOperation } from "./session-state-events.operation.js";
import { pruneSessionStateEvents } from "./session-state-events.prune.js";
import type { SessionStateSweepAddress } from "./session-state-events.types.js";
import { enqueueSessionStateNotice } from "./session-state-notices.js";

const log = createSubsystemLogger("sessions/state-events");

/** Re-materialize pending notices after the in-memory queue is lost on restart. */
export async function sweepSessionStateWatchNotices(
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): Promise<void> {
  try {
    const context = captureOpenClawStateWorkerContext(options);
    const now = options.now ?? Date.now();
    const result = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.initializationEnvironment },
      { type: "sessionState.pendingNotices", input: undefined },
      { context },
    );
    context.admission.assertCurrent();
    if (result && !result.ok) {
      throw new Error(result.message);
    }
    const watchers = new Map<string, SessionStateSweepAddress[]>();
    for (const cursor of result?.type === "sessionState.pendingNotices" ? result.cursors : []) {
      const cursors = watchers.get(cursor.watcherSessionKey) ?? [];
      cursors.push(cursor);
      watchers.set(cursor.watcherSessionKey, cursors);
    }
    const cursors: SessionStateSweepAddress[] = [];
    for (const [sessionKey, addresses] of watchers) {
      const storePath = await prepareSystemEventStorePath(sessionKey);
      const input = {
        sessionKey,
        env: context.initializationEnvironment,
        storePath:
          storePath ??
          (await preparePhysicalSessionStorePath({
            sessionKey,
            env: context.initializationEnvironment,
          })),
      };
      const exists = await withSessionEntryReadOnlyInWorker(
        input,
        () => context.admission.assertCurrent(),
        async (read) => read.ok && Boolean(read.value),
      );
      if (exists) {
        cursors.push(...addresses);
      }
    }
    if (cursors.length > 0) {
      await runSessionWatchOperation(
        context,
        async (scope) => {
          const notices = await scope.execute({
            type: "sessionState.sweep",
            input: { cursors, now },
          });
          // Sweeping is best effort; delivery still checks its current target and store.
          for (const notice of notices) {
            enqueueSessionStateNotice(notice);
          }
        },
        () => context.admission.assertCurrent(),
      );
    }
    await pruneSessionStateEvents({ context, now, force: true });
  } catch (error) {
    log.warn(`failed to sweep session state notices: ${String(error)}`);
  }
}
