/** Package-local artwork contracts shared by discovery and package builders. */
export const PORTABLE_PLUGIN_ICON_PATH = "assets/icon.png";
export const PLUGIN_ACTIVITY_ICON_PATH = "assets/activity.svg";
export const PLUGIN_TOOL_ACTIVITY_ICON_DIR = "assets/activity";
export const MAX_PLUGIN_ACTIVITY_TOOL_ICONS = 128;
export const PLUGIN_ACTIVITY_ICON_MAX_BYTES = 32 * 1024;

export function isPluginActivityToolName(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(value);
}
