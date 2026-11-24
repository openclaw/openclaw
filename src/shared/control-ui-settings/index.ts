import type { ControlUiSettingEntry, ControlUiSettingsPage } from "./define.js";
import { AGENT_OVERVIEW_SETTINGS } from "./pages/agents.js";
import { MCP_SETTINGS } from "./pages/mcp.js";
import { MODELS_SETTINGS } from "./pages/models.js";

/**
 * Every setting on the hand-built Settings pages, by page. Settings the generic config form
 * draws need no entry: their ID is their config path and their page follows from the
 * config section. `scripts/check-control-ui-setting-ids.mts` keeps this list, the rows and
 * `config/control-ui-setting-ids.txt` in step.
 */
export const CONTROL_UI_SETTINGS_PAGES = [
  MODELS_SETTINGS,
  AGENT_OVERVIEW_SETTINGS,
  MCP_SETTINGS,
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
