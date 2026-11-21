import type { GatewaySessionRow } from "../api/types.ts";

export function createTeamScaleChildActivity(parent: GatewaySessionRow, now: number, count = 0) {
  if (!count) {
    return [];
  }
  const children = Array.from({ length: count }, (_, index) => ({
    key: `agent:main:chat:cd000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    sessionId: `details-child-${index}`,
    kind: "direct" as const,
    label: `Synthetic child review ${index + 1}`,
    parentSessionKey: parent.key,
    spawnedBy: parent.key,
    childOwnerSessionKeys: [parent.key],
    owner: parent.owner,
    participants: parent.participants,
    createdAt: now - 60_000 + index,
    startedAt: now - 60_000 + index,
    endedAt: now - 30_000 + index,
    updatedAt: now - 30_000 + index,
    status: "done" as const,
  }));
  parent.childSessions = [...(parent.childSessions ?? []), ...children.map((row) => row.key)];
  return children;
}
