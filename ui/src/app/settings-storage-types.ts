import type { UiSettings } from "./settings-contract.ts";

// The existing gateway-scoped browser record; profile snapshots contain references only.
export type ScopedSessionSelection = {
  sessionKey: string;
  lastActiveSessionKey: string;
  selectedAgentId?: string;
};

export type ProfileNavigation = { railShortcuts: string[] };
export type PersistedUiSettings = Omit<
  UiSettings,
  | "token"
  | "sessionKey"
  | "lastActiveSessionKey"
  | "selectedAgentId"
  | "navCollapsed"
  | "sidebarEntries"
  | "background"
> &
  Partial<ProfileNavigation> & {
    token?: never;
    sessionsByGateway?: Record<string, ScopedSessionSelection>;
    navigationByProfile?: Record<string, Partial<ProfileNavigation> & Record<string, unknown>>;
    // Retired sidebar order is preserved as opaque data, never used as rail shortcuts.
    sidebarEntries?: unknown;
    sidebarPinnedRoutes?: unknown;
  };

export type PersistedSettingsSource = {
  gatewayUrl: string;
  parsed: PersistedUiSettings;
  available: boolean;
};

export type SettingsStorageFallback = {
  key: string;
  record: PersistedUiSettings;
  pendingNavigation: Record<string, ProfileNavigation> | null;
};
