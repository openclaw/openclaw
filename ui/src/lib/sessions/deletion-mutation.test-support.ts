import { onTestFinished } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import { createSessionDeletionHarness as createHarness } from "./session-deletion.test-support.ts";

export const allSessions = { archivedFilter: "all" as const };

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
    read: (
      kind: "primary" | "managed" | "enumeration",
      scope: Parameters<typeof h.sessions.list>[0] = allSessions,
      enumerationScope?: Parameters<typeof h.sessions.list>[0],
      force = kind === "primary",
    ) => {
      if (kind === "enumeration") {
        return h.sessions.list(enumerationScope);
      }
      const query = kind === "managed" ? scope : {};
      return h.sessions
        .refreshList({ ...query, ...(force ? { force: true } : {}) })
        .then(() => h.sessions.listSnapshot(query).result);
    },
    changed: (payload: unknown) =>
      h.emitEvent({ type: "event", event: "sessions.changed", payload }),
    finish: <T>(operation: Promise<T>, key = h.alpha.key, deleted = false) => {
      h.responses.get(key)!.resolve({ deleted });
      return operation;
    },
  };
}
