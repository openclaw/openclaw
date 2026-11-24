import type { ControlUiSettingEntry, ControlUiSettingsPage } from "./define.js";
import { ADVANCED_SETTINGS } from "./pages/advanced.js";
import { AGENT_DEFAULTS_SETTINGS } from "./pages/agent-defaults.js";
import {
  AGENT_MEMORY_SETTINGS,
  AGENT_OVERVIEW_SETTINGS,
  AGENT_SKILLS_SETTINGS,
  AGENT_TOOLS_SETTINGS,
} from "./pages/agents.js";
import { APPEARANCE_SETTINGS } from "./pages/appearance.js";
import { CHANNELS_SETTINGS } from "./pages/channels.js";
import { CLOUD_WORKERS_SETTINGS } from "./pages/cloud-workers.js";
import { COMMUNICATIONS_SETTINGS } from "./pages/communications.js";
import { CONNECTION_SETTINGS } from "./pages/connection.js";
import { DEVICE_PERMISSIONS_SETTINGS, DEVICE_SETTINGS } from "./pages/device.js";
import { DEVICES_SETTINGS } from "./pages/devices.js";
import { INFRASTRUCTURE_SETTINGS } from "./pages/infrastructure.js";
import { LABS_SETTINGS } from "./pages/labs.js";
import { MCP_SETTINGS } from "./pages/mcp.js";
import { MEMORY_SETTINGS } from "./pages/memory.js";
import { MODELS_SETTINGS } from "./pages/models.js";
import { NOTIFICATIONS_SETTINGS } from "./pages/notifications.js";
import { PLUGINS_SETTINGS } from "./pages/plugins.js";
import { PROFILE_SETTINGS } from "./pages/profile.js";
import { SEARCH_SETTINGS } from "./pages/search.js";
import { SECRETS_SETTINGS } from "./pages/secrets.js";
import { SECURITY_SETTINGS } from "./pages/security.js";
import { SKILLS_SETTINGS } from "./pages/skills.js";
import { TALK_SETTINGS } from "./pages/talk.js";
import { UPDATES_SETTINGS } from "./pages/updates.js";

/**
 * Every setting on the hand-built Settings pages, by page. Settings the generic config form
 * draws need no entry: their ID is their config path and their page follows from the
 * config section. `scripts/check-control-ui-setting-ids.mts` keeps this list, the rows and
 * `config/control-ui-setting-ids.txt` in step.
 */
export const CONTROL_UI_SETTINGS_PAGES = [
  MODELS_SETTINGS,
  AGENT_OVERVIEW_SETTINGS,
  AGENT_TOOLS_SETTINGS,
  AGENT_SKILLS_SETTINGS,
  AGENT_MEMORY_SETTINGS,
  MCP_SETTINGS,
  APPEARANCE_SETTINGS,
  NOTIFICATIONS_SETTINGS,
  PROFILE_SETTINGS,
  CHANNELS_SETTINGS,
  CONNECTION_SETTINGS,
  CLOUD_WORKERS_SETTINGS,
  SEARCH_SETTINGS,
  PLUGINS_SETTINGS,
  SKILLS_SETTINGS,
  SECRETS_SETTINGS,
  LABS_SETTINGS,
  COMMUNICATIONS_SETTINGS,
  TALK_SETTINGS,
  DEVICES_SETTINGS,
  MEMORY_SETTINGS,
  AGENT_DEFAULTS_SETTINGS,
  SECURITY_SETTINGS,
  INFRASTRUCTURE_SETTINGS,
  UPDATES_SETTINGS,
  ADVANCED_SETTINGS,
  DEVICE_SETTINGS,
  DEVICE_PERMISSIONS_SETTINGS,
] as const;

type PageIds<Page> = Page extends ControlUiSettingsPage<infer Ids> ? Ids : never;
type ItemId<Id> = Id extends `${infer Prefix}.*` ? `${Prefix}.${string}` : Id;

/** A setting ID a hand-built row can carry, with `.*` keys filled in by the row. */
export type ControlUiSettingId = ItemId<PageIds<(typeof CONTROL_UI_SETTINGS_PAGES)[number]>>;

/**
 * Former IDs and the setting each one now names, so links written before a rename still
 * land. Removing an ID from the list without an alias fails the setting ID check.
 */
export const CONTROL_UI_SETTING_ID_ALIASES: Readonly<Record<string, ControlUiSettingId>> = {};

export type ControlUiSettingPlace = {
  readonly page: ControlUiSettingsPage;
  readonly id: string;
  readonly entry: ControlUiSettingEntry;
};

/** The page and entry that own a setting ID or a former one; undefined for other anchors. */
export function findControlUiSetting(id: string): ControlUiSettingPlace | undefined {
  const current = CONTROL_UI_SETTING_ID_ALIASES[id] ?? id;
  for (const page of CONTROL_UI_SETTINGS_PAGES) {
    const settings: Readonly<Record<string, ControlUiSettingEntry>> = page.settings;
    const entry = settings[current] ?? settings[`${current.slice(0, current.lastIndexOf("."))}.*`];
    if (entry) {
      return { page, id: current, entry };
    }
  }
  return undefined;
}
