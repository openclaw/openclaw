import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import type { SessionEntryCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { preparePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import {
  captureSystemEventStoreCurrentCheck,
  prepareSystemEventStorePath,
} from "../infra/system-event-ownership.js";
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
    const checks: SessionEntryCurrentCheck[] = [];
    const assertWatchersCurrent: Array<() => void> = [];
    const assertCurrent = () => {
      context.admission.assertCurrent();
      for (const check of assertWatchersCurrent) {
        check();
      }
    };
    for (const [sessionKey, addresses] of watchers) {
      const isStoreCurrent = captureSystemEventStoreCurrentCheck(sessionKey);
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
      const loaded = await withSessionEntryReadOnlyInWorker(
        input,
        assertCurrent,
        async (read, owner) =>
          read.ok && read.value
            ? {
                sessionId: read.value.sessionId,
                current: captureSessionEntryCurrentRead(input, owner),
              }
            : undefined,
      );
      if (!loaded) {
        continue;
      }
      const { sessionId, current } = loaded;
      const check = () => {
        current.assertSourceCurrent();
        if (
          (storePath !== undefined && !isStoreCurrent(storePath)) ||
          (current.kind !== "file" && current.readCurrent()?.sessionId !== sessionId)
        ) {
          throw new Error("Session notice sweep lost its watcher");
        }
      };
      check();
      assertWatchersCurrent.push(check);
      if (current.source) {
        checks.push({
          source: current.source,
          assertCurrent(entry) {
            if (entry?.sessionId !== sessionId) {
              throw new Error("Session notice sweep watcher changed before commit");
            }
          },
        });
      }
      cursors.push(...addresses);
    }
    if (cursors.length > 0) {
      await runSessionWatchOperation(
        context,
        async (scope) => {
          const notices = await scope.execute({
            type: "sessionState.sweep",
            input: {
              cursors,
              now,
              sessionEntryCurrentSources: checks.map((check) => check.source),
            },
          });
          assertCurrent();
          for (const notice of notices) {
            enqueueSessionStateNotice(notice);
          }
        },
        assertCurrent,
        {
          sources: checks.map((check) => check.source),
          assertCurrent: (entries) =>
            checks.forEach((check, index) => check.assertCurrent(entries[index])),
        },
      );
    }
    await pruneSessionStateEvents({ context, now, force: true });
  } catch (error) {
    log.warn(`failed to sweep session state notices: ${String(error)}`);
  }
}
