import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { sessionEventPublicationRows } from "./session-event-prepared-row.js";
import { identity, type Row } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";

type PendingSummary = { captured: Row; work: Promise<void> };
const pendingSummaries = new WeakMap<SessionRowProjection, Map<string, PendingSummary>>();

export async function broadcastSessionActivitySummary(
  target: { key: string; agentId: string; storePath: string },
  params: {
    getSessionRowProjection?: () => SessionRowProjection | undefined;
    broadcast: GatewayBroadcastFn;
  },
): Promise<void> {
  const projection = params.getSessionRowProjection?.();
  const query = { key: target.key, agentId: target.agentId, storePath: target.storePath };
  const captured = projection?.capture(query);
  const key = captured ? identity(captured) : undefined;
  const previous = projection && key ? pendingSummaries.get(projection)?.get(key) : undefined;
  if (previous && projection?.isCurrent(previous.captured)) {
    return previous.work;
  }
  let release: (() => void) | undefined;
  const publish = () => {
    // A new summary during delivery must not join the snapshot already being sent.
    release?.();
    if (projection && (!captured || !projection.isCurrent(captured))) {
      return;
    }
    const row = projection?.snapshot(query).row;
    params.broadcast(
      "sessions.changed",
      {
        sessionKey: target.key,
        agentId: target.agentId,
        reason: "activity-summary",
        ...buildGatewaySessionSnapshot({
          sessionRow: row,
          agentId: target.agentId,
          includeSession: true,
        }),
      },
      { sessionKeys: [target.key], agentId: target.agentId, dropIfSlow: true },
    );
  };
  if (projection) {
    const publications = sessionEventPublicationRows(projection);
    const work = publications.track(
      Promise.resolve().then(() =>
        publications.withReadyRows(() => [query], publish, { includeAncestors: true }),
      ),
    );
    if (captured && key) {
      const owner = pendingSummaries.get(projection) ?? new Map<string, PendingSummary>();
      pendingSummaries.set(projection, owner);
      const pending = { captured, work };
      owner.set(key, pending);
      release = () => {
        if (owner.get(key) === pending) {
          owner.delete(key);
        }
      };
    }
    try {
      await work;
    } finally {
      release?.();
    }
  } else {
    publish();
  }
}
