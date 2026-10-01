import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import type { defineBrowserMeetingPlugin } from "./browser-plugin.js";

type BrowserMeetingPlugin = ReturnType<typeof defineBrowserMeetingPlugin>;

export async function loadBrowserMeetingPlugins() {
  const [{ zoomMeetingsPlugin }, { teamsMeetingsPlugin }, { slackHuddlesPlugin }] =
    await Promise.all([
      loadBundledPluginFacade<{ zoomMeetingsPlugin: BrowserMeetingPlugin }>({
        pluginId: "zoom-meetings",
        artifactBasename: "index.js",
      }),
      loadBundledPluginFacade<{ teamsMeetingsPlugin: BrowserMeetingPlugin }>({
        pluginId: "teams-meetings",
        artifactBasename: "index.js",
      }),
      loadBundledPluginFacade<{ slackHuddlesPlugin: BrowserMeetingPlugin }>({
        pluginId: "slack-huddles",
        artifactBasename: "index.js",
      }),
    ]);
  return { zoomMeetingsPlugin, teamsMeetingsPlugin, slackHuddlesPlugin };
}
