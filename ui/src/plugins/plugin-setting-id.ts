import type { PluginManifestControlUiSettingsView } from "../../../src/plugins/manifest-types.ts";

type DeclaredSettings = PluginManifestControlUiSettingsView["settings"];

/** A setting ID its plugin declared for the view that draws it; only the host makes one. */
export type PluginSettingId = string & { readonly pluginSettingId: true };

/** The declared entry for an ID; a `<prefix>.*` key stands for each of its items. */
function declaredEntry(settings: DeclaredSettings, id: string) {
  const item = `${id.slice(0, id.lastIndexOf("."))}.*`;
  return Object.hasOwn(settings, id)
    ? settings[id]
    : Object.hasOwn(settings, item)
      ? settings[item]
      : undefined;
}

/**
 * Admits a row's setting ID only when the plugin's manifest declares it for this view, so a
 * plugin cannot draw a core setting or one it never declared.
 */
export function declaredPluginSetting(settings: DeclaredSettings, id: string): PluginSettingId {
  if (!declaredEntry(settings, id)) {
    throw new Error(
      `Setting ID "${id}" is not declared for this Settings view. Declare it in openclaw.plugin.json controlUi.settingsViews[].settings.`,
    );
  }
  // SAFETY: the view's manifest declares this ID, which is what the brand names.
  return id as PluginSettingId;
}
