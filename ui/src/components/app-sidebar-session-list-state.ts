import {
  normalizeSidebarSessionsGrouping,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

export const SIDEBAR_SESSION_GROUPING_STORAGE_KEY = "openclaw:sidebar:sessions:grouping";
export const SIDEBAR_SESSION_SHOW_CRON_STORAGE_KEY = "openclaw:sidebar:sessions:show-cron";
export const SIDEBAR_AGENT_SESSION_LIST_LIMIT = 60;
export const SIDEBAR_SESSION_PAGE_SIZE = 10;
export const SIDEBAR_SESSION_SEE_LESS_THRESHOLD = 30;
export const SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY =
  "openclaw:sidebar:sessions:collapsed-sections";

export function limitSidebarSessionRows<T extends { active: boolean; pinned: boolean }>(
  rows: T[],
  limit: number,
): T[] {
  const requiredCount = rows.filter((row) => row.active || row.pinned).length;
  let optionalSlots = Math.max(0, limit - requiredCount);
  return rows.filter((row) => {
    if (row.active || row.pinned) {
      return true;
    }
    if (optionalSlots === 0) {
      return false;
    }
    optionalSlots -= 1;
    return true;
  });
}

export function loadStoredSidebarSessionsGrouping(): SidebarSessionsGrouping {
  return normalizeSidebarSessionsGrouping(
    getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_GROUPING_STORAGE_KEY),
  );
}

export function loadStoredSidebarSessionsShowCron(): boolean {
  return getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_SHOW_CRON_STORAGE_KEY) === "true";
}

export function loadStoredCollapsedSessionSections(): ReadonlySet<string> {
  try {
    const raw = getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.flatMap((value) => (typeof value === "string" && value ? [value] : []))
        : [],
    );
  } catch {
    return new Set();
  }
}
