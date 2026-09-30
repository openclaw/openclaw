/** Package-local artwork contracts shared by discovery and package builders. */
export const PORTABLE_PLUGIN_ICON_PATH = "assets/icon.png";
export const PORTABLE_PLUGIN_THEME_ICON_PATHS = {
  light: "assets/icon-light.png",
  dark: "assets/icon-dark.png",
} as const;
export type PluginIconTheme = keyof typeof PORTABLE_PLUGIN_THEME_ICON_PATHS;
export const PORTABLE_PLUGIN_ICON_PATHS = [
  PORTABLE_PLUGIN_ICON_PATH,
  ...Object.values(PORTABLE_PLUGIN_THEME_ICON_PATHS),
];
export const PLUGIN_ACTIVITY_ICON_PATH = "assets/activity.svg";
export const PLUGIN_TOOL_ACTIVITY_ICON_DIR = "assets/activity";
export const MAX_PLUGIN_ACTIVITY_TOOL_ICONS = 128;
export const PLUGIN_ACTIVITY_ICON_MAX_BYTES = 32 * 1024;

export function isPluginActivityToolName(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(value);
}
