import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import type { SessionRowProjection } from "./session-row-projection.js";

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
  const publish = () => {
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
    const { withReadySessionRows } = await import("./session-row-prepared-read.js");
    await withReadySessionRows(projection, () => [query], publish, { includeAncestors: true });
  } else {
    publish();
  }
}
