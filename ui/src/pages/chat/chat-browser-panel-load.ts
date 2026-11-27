import { lazy, lazyModule } from "solid-js";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import type { SidebarPanelDefinitionParams } from "./chat-pane-embedded-types.ts";

const loadSessionTabList = lazyModule(
  () => import("../../components/browser/browser-session-tab-list.ts"),
);

export const Browser = lazy(
  async () => {
    const [panel] = await Promise.all([
      import("../../components/browser/browser-panel.ts"),
      loadSessionTabList(),
    ]);
    return panel;
  },
  { export: "BrowserPanelHost" },
);

export function prepareChatBrowserPanel(props: SidebarPanelDefinitionParams) {
  const { state } = props;
  if (!state.browserPanelAvailable) {
    return;
  }
  const { client, sessionKey } = state;
  if (client && state.connected && sessionKey.trim()) {
    const generation = client.connectionGeneration;
    const prepare = ({ sessionBrowserTabList }: Awaited<ReturnType<typeof loadSessionTabList>>) => {
      if (
        state.client === client &&
        state.sessionKey === sessionKey &&
        client.connectionGeneration === generation &&
        state.connected &&
        isBrowserPanelAvailable({ phase: "connected", hello: state.hello })
      ) {
        void sessionBrowserTabList(
          "prepare",
          client,
          sessionKey,
          props.preferredBrowserTab?.tab,
          props.sessionBrowserTabs ?? [],
        );
      }
    };
    const loaded = loadSessionTabList.peek();
    if (loaded) {
      prepare(loaded);
    } else {
      void loadSessionTabList()
        .then(prepare)
        .catch(() => {});
    }
  }
  void Browser.preload().catch(() => {});
}
