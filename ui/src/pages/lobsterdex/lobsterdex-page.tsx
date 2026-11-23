import { registerPreferencesEnglish } from "../../i18n/locales/en-preferences.ts";
import { registerRouteSubtitlesEnglish } from "../../i18n/locales/en-route-subtitles.ts";
import { PluginPage } from "../plugin/plugin-page.tsx";

registerPreferencesEnglish();
registerRouteSubtitlesEnglish();

/** Retain the shipped Settings URL; the enabled plugin owns its native view. */
export function LobsterdexPage() {
  return <PluginPage pluginId="lobsterdex" tabId="collection" />;
}
