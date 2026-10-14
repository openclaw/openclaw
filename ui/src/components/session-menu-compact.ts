import "../styles/session-menu-compact.css";

export type CompactSessionMenuView =
  | "root"
  | "copy"
  | "open-in"
  | "assign-owner"
  | "icon"
  | "group"
  | "snooze"
  | "advanced"
  | "archive";

const COMPACT_SESSION_MENU_VIEW_BY_VALUE: Record<string, CompactSessionMenuView> = {
  "compact:back": "root",
  "compact:open-advanced": "advanced",
  "compact:back-advanced": "advanced",
  "compact:open-copy": "copy",
  "compact:open-archive": "archive",
  "compact:open-snooze": "snooze",
  "compact:open-assign-owner": "assign-owner",
  "compact:open-group": "group",
  "compact:open-icon": "icon",
  "compact:open-open-in": "open-in",
};

export function compactSessionMenuViewForValue(value: string): CompactSessionMenuView | null {
  return COMPACT_SESSION_MENU_VIEW_BY_VALUE[value] ?? null;
}
