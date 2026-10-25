import { sidebarBootSnapshot } from "../test-helpers/sidebar-boot-snapshot.test-support.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { sessionAttentionIconName } from "./session-attention-presentation.ts";
import { sessionLeadingRun } from "./session-leading-indicator.ts";
import {
  parseSidebarSnapshot,
  createSidebarSnapshotRows,
  type SidebarSnapshotModel,
} from "./sidebar-snapshot-model.ts";
import { summarizeTeamSessionSlots } from "./solid/session-presentation.tsx";

export const sidebarSnapshot: SidebarSnapshotModel = {
  ...sidebarBootSnapshot(null),
  footer: { id: "operator", name: "Riley" },
  brand: { name: "Harbor", avatar: null, icon: "claw", environment: null },
};

export function sidebarSnapshotWithRows(
  rows: readonly SidebarRecentSession[],
  presentation?: Parameters<typeof createSidebarSnapshotRows>[0],
  roster?: SidebarSnapshotModel["roster"],
): SidebarSnapshotModel {
  const snapshot = createSidebarSnapshotRows((source) => {
    const row = { ...source, snapshot: undefined };
    const slots = summarizeTeamSessionSlots([row], true);
    const run = sessionLeadingRun(row, true);
    return {
      attention:
        row.attention.kind === "none"
          ? undefined
          : [row.attention.kind, sessionAttentionIconName(row.attention)],
      tone: row.attention.kind === "none" ? undefined : row.attention.kind,
      run: run === "none" ? undefined : run,
      slotAttention:
        slots.attention.kind === "none"
          ? undefined
          : [slots.attention.kind, sessionAttentionIconName(slots.attention)],
      slotActive: slots.active || undefined,
      slotQueued: slots.queued || undefined,
      slotUnread: slots.unread || undefined,
      slotFailed: slots.failed || undefined,
      ...presentation?.(row),
    };
  }, roster);
  const sessions = snapshot.capture(rows);
  const model = parseSidebarSnapshot({
    ...sidebarSnapshot,
    roster: roster ?? null,
    rows: snapshot.rows,
    sessions,
  });
  if (!model) {
    throw new Error("Invalid sidebar test snapshot");
  }
  return model;
}
