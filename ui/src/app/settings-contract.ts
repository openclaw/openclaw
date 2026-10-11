import type { BackgroundPreference } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import {
  normalizeUiAppearancePreference,
  type TabIconPreference,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import type { BoardSessionViews } from "../lib/board/settings.ts";
import type {
  SidebarSessionActivePanels,
  SidebarSessionLayouts,
} from "../pages/chat/sidebar-layout-persistence.ts";
import type { ChatSplitLayout } from "../pages/chat/split-layout-types.ts";
import type { ImportedCustomTheme } from "./custom-theme.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";
import type { TypefaceId } from "./typography.ts";

// Shared settings shape and primitive normalization never depend on storage or profile ownership.
export const TEXT_SCALE_STOPS = [90, 100, 110, 125, 140] as const;
export type TextScaleStop = (typeof TEXT_SCALE_STOPS)[number];

const CHAT_SEND_SHORTCUTS = ["enter", "modifier-enter"] as const;
export type ChatSendShortcut = (typeof CHAT_SEND_SHORTCUTS)[number];

function normalizeChoice<T extends string>(
  values: readonly T[],
  fallback: T,
): (value: unknown) => T {
  return (value) => values.find((candidate) => candidate === value) ?? fallback;
}

export const normalizeChatSendShortcut = normalizeChoice(CHAT_SEND_SHORTCUTS, "enter");

const CHAT_FOLLOW_UP_MODES = ["queue", "steer"] as const;
export type ChatFollowUpMode = (typeof CHAT_FOLLOW_UP_MODES)[number];

export const normalizeChatFollowUpMode = normalizeChoice(CHAT_FOLLOW_UP_MODES, "steer");

export function normalizeChatFollowUpModeOverride(value: unknown): ChatFollowUpMode | undefined {
  return CHAT_FOLLOW_UP_MODES.find((mode) => mode === value);
}

const CATALOG_OPEN_TARGETS = ["viewer", "terminal"] as const;
export type CatalogOpenTarget = (typeof CATALOG_OPEN_TARGETS)[number];

export const normalizeCatalogOpenTarget = normalizeChoice(CATALOG_OPEN_TARGETS, "viewer");

const CHAT_WORKSPACE_DOCKS = ["right", "bottom"] as const;
type ChatWorkspaceDock = (typeof CHAT_WORKSPACE_DOCKS)[number];

export const normalizeChatWorkspaceDock = normalizeChoice(CHAT_WORKSPACE_DOCKS, "right");

export function normalizeAccentColor(value: unknown): string | undefined {
  return normalizeUiAppearancePreference("ui.accent", value);
}

export function normalizeTextScale(value: unknown): TextScaleStop {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 100;
  }
  return TEXT_SCALE_STOPS.reduce((best, stop) =>
    Math.abs(value - stop) < Math.abs(value - best) ? stop : best,
  );
}

export const UI_APPEARANCE_DEFAULTS = {
  theme: "claw",
  themeMode: "system",
  textScale: 100,
  sidebarLiveActivity: true,
  chatMessageMaxWidth: "48rem",
  chatShowTaskProgress: true,
  chatCollapseTaskProgress: false,
  chatSendShortcut: "enter",
  catalogOpenTarget: "viewer",
  composerHoldToRecord: true,
  lobsterPetVisits: true,
  lobsterPetSounds: false,
  sessionDeleteConfirm: true,
} as const;

export type UiSettings = {
  gatewayUrl: string;
  // In-memory Gateway secret; only token-mode hello may persist it.
  token: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  selectedAgentId?: string;
  theme: ThemeName;
  themeMode: ThemeMode;
  accent?: string;
  // Browser typeface overrides; undefined = theme default.
  fontUi?: TypefaceId;
  fontChat?: TypefaceId;
  tabIcon?: TabIconPreference;
  // Device-local: custom terminal faces must be installed on the browser computer.
  terminalFontFamily?: string;
  // Personal metadata uses its identity-scoped mirror, never the general settings record.
  background?: BackgroundPreference;
  chatShowThinking: boolean;
  chatShowToolCalls: boolean;
  chatPersistCommentary?: boolean;
  // Browser-local composer visibility; saved progress and other placements are unchanged.
  chatShowTaskProgress?: boolean;
  // Browser-local presentation preference; false preserves active-card auto-expand.
  chatCollapseTaskProgress?: boolean;
  chatSendShortcut?: ChatSendShortcut;
  chatFollowUpMode?: ChatFollowUpMode; // Default handling for messages sent while a run is active
  catalogOpenTarget?: CatalogOpenTarget;
  realtimeTalkInputDeviceId?: string;
  realtimeTalkVideoDeviceId?: string;
  composerHoldToRecord?: boolean;
  // Camera intent is device-local, not per-agent or synced through config ui.prefs.
  talkCameraAutoEnable?: boolean;
  chatSplitLayout?: ChatSplitLayout;
  chatWorkspaceDock?: ChatWorkspaceDock; // Session workspace rail dock edge (default "right")
  boardSessionViews?: BoardSessionViews; // Per-device active dashboard tab and dock state
  sidebarSessionLayouts?: SidebarSessionLayouts; // Sidebar columns and widths per session
  sidebarSessionActivePanels?: SidebarSessionActivePanels; // Collapsed active panel per session
  navCollapsed: boolean; // Collapsible sidebar state
  navWidth: number; // Sidebar width when expanded (240–400px)
  sidebarAgentsMode?: "chip" | "roster";
  sidebarPreTeamScope?: string | null; // null remembers All agents; undefined means unset.
  sidebarCollapsedAgentIds?: string[];
  sidebarEntries: string[]; // Ordered personal navigation references
  sidebarLiveActivity?: boolean; // Latest activity under running sidebar sessions (default true)
  chatMessageMaxWidth?: string; // Browser-local centered chat transcript max width
  chatBubbleSessionKeys?: string[]; // Browser-local speech bubbles per canonical session, scoped to this Gateway
  showAdvancedSettings?: boolean; // Expand advanced schema settings (default false)
  pinnedAgentIds?: string[]; // Agents surfaced first in the agent-chip quick switcher
  textScale?: TextScaleStop; // Browser-local text scale percentage
  customTheme?: ImportedCustomTheme;
  locale?: string;
  lobsterPetVisits?: boolean; // Whether critters visit the new composer (default true)
  lobsterPetSounds?: boolean; // Opt-in poke/pet chirps from the lobster (default false)
  // Confirm before deleting sessions (default true). Device-local on purpose:
  // opting out on one browser must not lower the bar on the operator's others,
  // so this stays out of the synced ui.prefs set in server-prefs-state.ts.
  sessionDeleteConfirm?: boolean;
  // Device-local opt-in: route eligible external links into the Gateway browser panel.
  openLinksInControlUiBrowser?: boolean;
  // Browser-local opt-in; absence preserves native panels and plugin readers.
  openLinksExternally?: boolean;
};

export type UiPreferences = Omit<UiSettings, "token">;
