import type { SessionCapability } from "../sessions/session-capability.ts";
import { sessionProgressTargetQuery } from "../sessions/session-requests.ts";
import { createSharedSourceProjection } from "./shared-owner-projection.ts";

type ProgressRosterSource = {
  sessions: SessionCapability;
  query: ReturnType<typeof sessionProgressTargetQuery>;
};

const sources = new WeakMap<SessionCapability, Map<string, ProgressRosterSource>>();
const projectRoster = createSharedSourceProjection({
  // Widgets read the owner's current rows; a shared observer must not retain retired rosters.
  read: () => undefined,
  subscribe: ({ sessions, query }: ProgressRosterSource, notify) => {
    const release = sessions.subscribeList(query, notify);
    const snapshot = sessions.listSnapshot(query);
    if (
      !snapshot.result &&
      !snapshot.loading &&
      !snapshot.error &&
      sessions.captureConnectionScope()
    ) {
      void sessions.refreshList(query);
    }
    return release;
  },
});

/** The capability owns membership and refresh admission; active widgets share its observation. */
export function projectSessionProgressRoster(sessions: SessionCapability, agentId?: string | null) {
  const query = sessionProgressTargetQuery(agentId);
  const key = query.agentId ?? "";
  let scoped = sources.get(sessions);
  if (!scoped) {
    scoped = new Map();
    sources.set(sessions, scoped);
  }
  let source = scoped.get(key);
  if (!source) {
    source = { sessions, query };
    scoped.set(key, source);
  }
  return projectRoster(source);
}
