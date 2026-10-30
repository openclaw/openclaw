import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../api/types.ts";
import type { SessionMenuData } from "./session-menu-actions.ts";
import { sessionPlacementAction } from "./session-placement-action.ts";

export function sessionMenuDataFromRow(
  row: GatewaySessionRow,
  presentation: Pick<SessionMenuData, "label" | "isChild" | "pinned" | "pinnable" | "archiving">,
): SessionMenuData {
  return {
    ...presentation,
    placementAction: sessionPlacementAction(row),
    target: { key: row.key, agentId: row.agentId },
    sessionId: row.sessionId ?? null,
    snoozedUntil: row.snoozedUntil ?? null,
    unread: row.unread === true,
    hiddenFromInvolvingMe: row.hiddenFromInvolvingMe,
    communication: row.communication,
    effectiveCommunication: row.effectiveCommunication,
    archived: row.archived === true,
    category: normalizeOptionalString(row.category) ?? null,
    icon: normalizeOptionalString(row.icon) ?? null,
    color: normalizeOptionalString(row.color) ?? null,
    categoryClearReturnsToGroups: false,
  };
}

export const EMPTY_SESSION_MENU_DATA: SessionMenuData = {
  label: "",
  sessionId: null,
  pinned: false,
  unread: false,
  archived: false,
  snoozedUntil: null,
  category: null,
  icon: null,
  color: null,
  categoryClearReturnsToGroups: false,
};
