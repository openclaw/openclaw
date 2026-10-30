import { onTestFinished } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import type { SessionListScope } from "./session-capability.ts";
import { createSessionDeletionHarness as createHarness } from "./session-deletion.test-support.ts";

export const allSessions = { archivedFilter: "all" as const };
type ReadKind = "primary" | "managed" | "enumeration";

export function createDeletionHarness(...args: Parameters<typeof createHarness>) {
  const h = createHarness(...args);
  onTestFinished(() => {
    h.responses.forEach((response) => response.resolve({ deleted: false }));
    h.sessions.dispose();
  });
  return {
    ...h,
    rows: () => h.sessions.state.result?.sessions,
    keys: () => h.sessions.state.result?.sessions.map(({ key }) => key),
    refresh: (rows?: SessionsListResult["sessions"]) => {
      if (rows) {
        h.setRows(rows);
      }
      return h.sessions.refresh({ force: true });
    },
    hold: (
      scope: Parameters<typeof h.sessions.subscribeList>[0] = allSessions,
      listener: Parameters<typeof h.sessions.subscribeList>[1] = () => {},
    ) => {
      const stop = h.sessions.subscribeList(scope, listener);
      onTestFinished(stop);
      return stop;
    },
    deferredList: () => {
      const deferred = createDeferred<SessionsListResult>();
      onTestFinished(() => deferred.resolve(sessionsResult([], 1)));
      return deferred;
    },
    read: (kind: ReadKind, scope?: SessionListScope, force = kind === "primary") => {
      if (kind === "enumeration") {
        return h.sessions.list(scope);
      }
      const query = kind === "managed" ? (scope ?? allSessions) : {};
      return h.sessions
        .refreshList({ ...query, ...(force ? { force: true } : {}) })
        .then(() => h.sessions.listSnapshot(query).result);
    },
    changed: (payload: unknown) =>
      h.emitEvent({ type: "event", event: "sessions.changed", payload }),
    message: (payload: unknown) =>
      h.emitEvent({ type: "event", event: "session.message", payload }),
    finish: async <T>(operation: Promise<T>, key = h.alpha.key, deleted = false) => {
      const response = await h.waitForDeleteRequest(key);
      response.resolve({ deleted });
      return operation;
    },
  };
}
