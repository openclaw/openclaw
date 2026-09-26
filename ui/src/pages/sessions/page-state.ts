import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeSessionsGroupBy,
  SESSION_GROUP_MODES,
  type SessionsGroupBy,
} from "../../lib/sessions/grouping.ts";
import type { SessionArchivedFilter } from "../../lib/sessions/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const LEGACY_GROUP_BY_STORAGE_KEY = "openclaw:sessions:group-by";
const SESSIONS_PAGE_PREFERENCES_STORAGE_KEY = "openclaw:sessions:preferences:v1";
const SORT_COLUMNS = ["key", "kind", "updated", "tokens"] as const;
const SORT_DIRECTIONS = ["asc", "desc"] as const;
const STATUS_FILTERS = ["active", "archived", "all"] as const;
const PAGE_SIZES = [10, 25, 50, 100] as const;
type SessionsSortColumn = (typeof SORT_COLUMNS)[number];
type SessionsSortDirection = (typeof SORT_DIRECTIONS)[number];

export type SessionsPagePreferences = {
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  statusFilter: SessionArchivedFilter;
  searchQuery: string;
  sortColumn: SessionsSortColumn;
  sortDir: SessionsSortDirection;
  groupBy: SessionsGroupBy;
  pageSize: number;
};

type SessionsPageListFilters = Pick<
  SessionsPagePreferences,
  "activeMinutes" | "limit" | "includeGlobal" | "includeUnknown"
>;

const DEFAULT_SESSIONS_PAGE_PREFERENCES: SessionsPagePreferences = {
  activeMinutes: "",
  limit: "50",
  includeGlobal: true,
  includeUnknown: false,
  statusFilter: "active",
  searchQuery: "",
  sortColumn: "updated",
  sortDir: "desc",
  groupBy: "none",
  pageSize: 25,
};

const RESET_SESSIONS_PAGE_FILTERS: SessionsPageListFilters &
  Pick<SessionsPagePreferences, "searchQuery"> = {
  activeMinutes: DEFAULT_SESSIONS_PAGE_PREFERENCES.activeMinutes,
  limit: DEFAULT_SESSIONS_PAGE_PREFERENCES.limit,
  includeGlobal: DEFAULT_SESSIONS_PAGE_PREFERENCES.includeGlobal,
  includeUnknown: DEFAULT_SESSIONS_PAGE_PREFERENCES.includeUnknown,
  searchQuery: DEFAULT_SESSIONS_PAGE_PREFERENCES.searchQuery,
};

function isPreferenceValue<T extends string | number>(
  value: unknown,
  values: readonly T[],
): value is T {
  return values.some((candidate) => candidate === value);
}

function positiveIntegerString(value: unknown, fallback: string, allowEmpty = false): string {
  if (allowEmpty && value === "") {
    return "";
  }
  return typeof value === "string" && parseStrictPositiveInteger(value) !== undefined
    ? value
    : fallback;
}

function readStorageValue(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function storedLegacyGroupBy(storage: Storage): SessionsGroupBy | undefined {
  const raw = readStorageValue(storage, LEGACY_GROUP_BY_STORAGE_KEY);
  return isPreferenceValue(raw, SESSION_GROUP_MODES) ? normalizeSessionsGroupBy(raw) : undefined;
}

export function loadSessionsPagePreferences(): SessionsPagePreferences {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return { ...DEFAULT_SESSIONS_PAGE_PREFERENCES };
  }
  const legacyGroupBy = storedLegacyGroupBy(storage);
  const fallbackPreferences = {
    ...DEFAULT_SESSIONS_PAGE_PREFERENCES,
    groupBy: legacyGroupBy ?? DEFAULT_SESSIONS_PAGE_PREFERENCES.groupBy,
  };
  const raw = readStorageValue(storage, SESSIONS_PAGE_PREFERENCES_STORAGE_KEY);
  if (!raw) {
    return fallbackPreferences;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) {
      return fallbackPreferences;
    }
    return {
      activeMinutes: positiveIntegerString(parsed.activeMinutes, "", true),
      limit: positiveIntegerString(parsed.limit, DEFAULT_SESSIONS_PAGE_PREFERENCES.limit),
      includeGlobal:
        typeof parsed.includeGlobal === "boolean"
          ? parsed.includeGlobal
          : DEFAULT_SESSIONS_PAGE_PREFERENCES.includeGlobal,
      includeUnknown:
        typeof parsed.includeUnknown === "boolean"
          ? parsed.includeUnknown
          : DEFAULT_SESSIONS_PAGE_PREFERENCES.includeUnknown,
      statusFilter: isPreferenceValue(parsed.statusFilter, STATUS_FILTERS)
        ? parsed.statusFilter
        : DEFAULT_SESSIONS_PAGE_PREFERENCES.statusFilter,
      searchQuery:
        typeof parsed.searchQuery === "string"
          ? parsed.searchQuery
          : DEFAULT_SESSIONS_PAGE_PREFERENCES.searchQuery,
      sortColumn: isPreferenceValue(parsed.sortColumn, SORT_COLUMNS)
        ? parsed.sortColumn
        : DEFAULT_SESSIONS_PAGE_PREFERENCES.sortColumn,
      sortDir: isPreferenceValue(parsed.sortDir, SORT_DIRECTIONS)
        ? parsed.sortDir
        : DEFAULT_SESSIONS_PAGE_PREFERENCES.sortDir,
      // The legacy key stays authoritative while both releases can write it.
      // A differing value means the user changed grouping after rolling back.
      groupBy:
        legacyGroupBy ??
        (isPreferenceValue(parsed.groupBy, SESSION_GROUP_MODES)
          ? parsed.groupBy
          : fallbackPreferences.groupBy),
      pageSize: isPreferenceValue(parsed.pageSize, PAGE_SIZES)
        ? parsed.pageSize
        : DEFAULT_SESSIONS_PAGE_PREFERENCES.pageSize,
    };
  } catch {
    return fallbackPreferences;
  }
}

function saveSessionsPagePreferences(changes: Partial<SessionsPagePreferences>): void {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    const preferences = { ...loadSessionsPagePreferences(), ...changes };
    // Keep the previous release's grouping key current during the transition so
    // rollback edits remain authoritative when this release is restored.
    storage.setItem(LEGACY_GROUP_BY_STORAGE_KEY, preferences.groupBy);
    storage.setItem(
      SESSIONS_PAGE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, ...preferences }),
    );
  } catch {
    // Storage may be unavailable or full; current in-memory preferences still apply.
  }
}

export class SessionsPagePreferencesState {
  private value = loadSessionsPagePreferences();

  get current(): Readonly<SessionsPagePreferences> {
    return this.value;
  }

  update(changes: Partial<SessionsPagePreferences>): void {
    this.value = { ...this.value, ...changes };
    saveSessionsPagePreferences(changes);
  }

  updateListFilters(
    next: SessionsPageListFilters,
    wasEdited: (key: keyof SessionsPageListFilters) => boolean,
  ): void {
    const changes: Partial<SessionsPageListFilters> = {};
    for (const key of ["activeMinutes", "limit", "includeGlobal", "includeUnknown"] as const) {
      if (wasEdited(key)) {
        Object.assign(changes, { [key]: next[key] });
      }
    }
    this.update(changes);
  }

  resetFilters(): SessionsPageListFilters & Pick<SessionsPagePreferences, "searchQuery"> {
    this.update(RESET_SESSIONS_PAGE_FILTERS);
    return RESET_SESSIONS_PAGE_FILTERS;
  }
}
