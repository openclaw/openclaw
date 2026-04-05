import type { GatewayBroadcastFn } from "../gateway/server-broadcast.js";
import type { ClawControlState, ClawMissionDetailSnapshot } from "../shared/claw-types.js";

export function broadcastClawControl(
  broadcast: GatewayBroadcastFn | null,
  control: ClawControlState,
): void {
  if (!broadcast) {
    return;
  }
  broadcast("claw.control.changed", { control }, { dropIfSlow: true });
}

export function broadcastClawMissionSnapshot(
  broadcast: GatewayBroadcastFn | null,
  params: {
    previousStatus?: string | null;
    snapshot: ClawMissionDetailSnapshot;
    created?: boolean;
    decisionResolved?: boolean;
  },
): void {
  if (!broadcast) {
    return;
  }
  const mission = params.snapshot.mission;
  if (!mission) {
    return;
  }
  if (params.created) {
    broadcast("claw.mission.created", { mission }, { dropIfSlow: true });
    broadcast(
      "claw.decision.requested",
      {
        missionId: mission.id,
        decisions: mission.decisions.filter((decision) => decision.status === "pending"),
      },
      { dropIfSlow: true },
    );
  }
  broadcast("claw.mission.updated", { mission }, { dropIfSlow: true });
  if (params.previousStatus && params.previousStatus !== mission.status) {
    broadcast(
      "claw.mission.stateChanged",
      {
        missionId: mission.id,
        previousStatus: params.previousStatus,
        status: mission.status,
      },
      { dropIfSlow: true },
    );
  }
  if (params.decisionResolved) {
    broadcast(
      "claw.decision.resolved",
      { missionId: mission.id, decisions: mission.decisions },
      { dropIfSlow: true },
    );
  }
  broadcast(
    "claw.audit.appended",
    { missionId: mission.id, auditCount: mission.auditCount },
    { dropIfSlow: true },
  );
  broadcast("claw.inbox.updated", { inbox: params.snapshot.inbox }, { dropIfSlow: true });
}
