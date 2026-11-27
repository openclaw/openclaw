import { lazy } from "solid-js";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import { sessionBrowserTabList } from "../../components/browser/browser-session-tab-list.ts";
import type { SidebarPanelDefinitionParams } from "./chat-pane-embedded-types.ts";

export const Browser = lazy(() => import("../../components/browser/browser-panel.ts"), {
  export: "BrowserPanelHost",
});

export function prepareChatBrowserPanel(props: SidebarPanelDefinitionParams) {
  const { state } = props;
  if (!state.browserPanelAvailable) {
    return;
  }
  void Browser.preload().catch(() => {});
  if (
    state.client &&
    state.connected &&
    state.sessionKey.trim() &&
    isBrowserPanelAvailable({ phase: "connected", hello: state.hello })
  ) {
    sessionBrowserTabList(
      "prepare",
      state.client,
      state.sessionKey,
      props.preferredBrowserTab?.tab,
      props.sessionBrowserTabs ?? [],
    );
  }
}
