import type { UiSettings } from "./settings-contract.ts";

// The existing gateway-scoped browser record; profile snapshots contain references only.
export type ScopedSessionSelection = {
  sessionKey: string;
  lastActiveSessionKey: string;
  selectedAgentId?: string;
};

export type ProfileNavigation = Pick<UiSettings, "sidebarEntries" | "navigationScope">;
export type PersistedUiSettings = Omit<
  UiSettings,
  | "token"
  | "sessionKey"
  | "lastActiveSessionKey"
  | "selectedAgentId"
  | "navCollapsed"
  | "sidebarEntries"
  | "navigationScope"
  | "background"
> &
  Partial<ProfileNavigation> & {
    token?: never;
    sessionsByGateway?: Record<string, ScopedSessionSelection>;
    navigationByProfile?: Record<string, ProfileNavigation>;
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
