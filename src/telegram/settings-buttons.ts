/**
 * Telegram inline button utilities for the /settings control panel.
 *
 * Callback data patterns (max 64 bytes for Telegram):
 * - cfg_menu                  → main settings menu
 * - cfg_s_{setting}           → submenu (dmpol, grppol, stream, allow)
 * - cfg_v_{setting}_{value}   → set value (e.g. cfg_v_dmpol_open)
 */

import type { ButtonRow } from "./model-buttons.js";

export type ParsedSettingsCallback =
  | { type: "menu" }
  | { type: "submenu"; setting: SettingKey | "allow" }
  | { type: "set"; setting: SettingKey; value: string };

export type SettingKey = "dmpol" | "grppol" | "stream";

const SETTINGS_PREFIX = "cfg_";

const VALID_SETTING_KEYS = new Set<string>(["dmpol", "grppol", "stream"]);
const VALID_SUBMENU_KEYS = new Set<string>(["dmpol", "grppol", "stream", "allow"]);

const SETTING_VALUES: Record<SettingKey, readonly string[]> = {
  dmpol: ["pairing", "allowlist", "open", "disabled"],
  grppol: ["open", "allowlist", "disabled"],
  stream: ["off", "partial", "block"],
};

const SETTING_LABELS: Record<SettingKey, string> = {
  dmpol: "DM Policy",
  grppol: "Group Policy",
  stream: "Streaming",
};

const SETTING_DESCRIPTIONS: Record<SettingKey, Record<string, string>> = {
  dmpol: {
    pairing: "Unknown senders get a pairing code",
    allowlist: "Only allow senders in allowFrom",
    open: "Allow all inbound DMs",
    disabled: "Ignore all inbound DMs",
  },
  grppol: {
    open: "Groups bypass allowFrom",
    allowlist: "Only allowed groups/senders",
    disabled: "Block all group messages",
  },
  stream: {
    off: "No streaming preview",
    partial: "Edit a single preview message",
    block: "Stream in chunked updates",
  },
};

function isSettingKey(value: string): value is SettingKey {
  return VALID_SETTING_KEYS.has(value);
}

/**
 * Parse a settings callback_data string into a structured object.
 * Returns null if the data doesn't match a known cfg_ pattern.
 */
export function parseSettingsCallbackData(data: string): ParsedSettingsCallback | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith(SETTINGS_PREFIX)) {
    return null;
  }

  if (trimmed === "cfg_menu") {
    return { type: "menu" };
  }

  // cfg_s_{setting} — submenu (includes "allow" for read-only allowlist view)
  const submenuMatch = trimmed.match(/^cfg_s_([a-z]+)$/);
  if (submenuMatch) {
    const setting = submenuMatch[1];
    if (setting && VALID_SUBMENU_KEYS.has(setting)) {
      return { type: "submenu", setting: setting as SettingKey | "allow" };
    }
    return null;
  }

  // cfg_v_{setting}_{value} — set value
  const setMatch = trimmed.match(/^cfg_v_([a-z]+)_([a-z]+)$/);
  if (setMatch) {
    const setting = setMatch[1];
    const value = setMatch[2];
    if (setting && value && isSettingKey(setting)) {
      const validValues = SETTING_VALUES[setting];
      if (validValues.includes(value)) {
        return { type: "set", setting, value };
      }
    }
    return null;
  }

  return null;
}

export type SettingsMenuState = {
  dmPolicy?: string;
  groupPolicy?: string;
  streaming?: string;
};

/**
 * Build the main settings menu text and buttons.
 */
export function buildSettingsMainMenu(current: SettingsMenuState): {
  text: string;
  buttons: ButtonRow[];
} {
  const dmPol = current.dmPolicy ?? "pairing";
  const grpPol = current.groupPolicy ?? "open";
  const stream = normalizeStreamingDisplay(current.streaming);

  const text = [
    "Settings",
    "",
    `DM Policy: ${dmPol}`,
    `Group Policy: ${grpPol}`,
    `Streaming: ${stream}`,
  ].join("\n");

  const buttons: ButtonRow[] = [
    [
      { text: "DM Policy", callback_data: "cfg_s_dmpol" },
      { text: "Group Policy", callback_data: "cfg_s_grppol" },
    ],
    [
      { text: "Streaming", callback_data: "cfg_s_stream" },
      { text: "Allowlist", callback_data: "cfg_s_allow" },
    ],
  ];

  return { text, buttons };
}

/**
 * Build a submenu for a specific setting, showing options with a checkmark on
 * the current value plus a back button.
 */
export function buildSettingSubmenu(
  setting: SettingKey,
  currentValue: string | undefined,
): { text: string; buttons: ButtonRow[] } {
  const label = SETTING_LABELS[setting];
  const values = SETTING_VALUES[setting];
  const descriptions = SETTING_DESCRIPTIONS[setting];
  const effective = setting === "stream" ? normalizeStreamingDisplay(currentValue) : currentValue;

  const lines = [label, ""];
  for (const value of values) {
    const check = value === effective ? " \u2713" : "";
    const desc = descriptions[value] ?? "";
    lines.push(`${value}${check} \u2014 ${desc}`);
  }

  const buttons: ButtonRow[] = [];
  // One value per row for clarity
  for (const value of values) {
    const check = value === effective ? " \u2713" : "";
    buttons.push([{ text: `${value}${check}`, callback_data: `cfg_v_${setting}_${value}` }]);
  }
  buttons.push([{ text: "<< Back", callback_data: "cfg_menu" }]);

  return { text: lines.join("\n"), buttons };
}

/**
 * Build a read-only allowlist view showing current DM and group allowlist entries.
 */
export function buildAllowlistView(
  dmEntries: readonly string[],
  groupEntries: readonly string[],
): { text: string; buttons: ButtonRow[] } {
  const MAX_DISPLAY = 10;
  const lines = ["Allowlist"];

  lines.push("");
  lines.push("DM allowlist:");
  if (dmEntries.length === 0) {
    lines.push("  (none)");
  } else {
    const display = dmEntries.slice(0, MAX_DISPLAY);
    for (const entry of display) {
      lines.push(`  ${entry}`);
    }
    if (dmEntries.length > MAX_DISPLAY) {
      lines.push(`  ...and ${dmEntries.length - MAX_DISPLAY} more`);
    }
  }

  lines.push("");
  lines.push("Group allowlist:");
  if (groupEntries.length === 0) {
    lines.push("  (none)");
  } else {
    const display = groupEntries.slice(0, MAX_DISPLAY);
    for (const entry of display) {
      lines.push(`  ${entry}`);
    }
    if (groupEntries.length > MAX_DISPLAY) {
      lines.push(`  ...and ${groupEntries.length - MAX_DISPLAY} more`);
    }
  }

  lines.push("");
  lines.push("Use /allowlist to add or remove entries.");

  const buttons: ButtonRow[] = [[{ text: "<< Back", callback_data: "cfg_menu" }]];

  return { text: lines.join("\n"), buttons };
}

/** Map streaming config values (including legacy booleans) to display values. */
function normalizeStreamingDisplay(value: string | boolean | undefined): string {
  if (value === true || value === "progress") {
    return "partial";
  }
  if (value === false) {
    return "off";
  }
  if (typeof value === "string" && ["off", "partial", "block"].includes(value)) {
    return value;
  }
  return "partial"; // default
}

export { SETTING_VALUES, SETTING_LABELS, normalizeStreamingDisplay };
