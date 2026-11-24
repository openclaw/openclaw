import { onCleanup } from "solid-js";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { sessionViewerPresenceForGateway } from "../../lib/session-viewer-presence.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { visiblePanesOf } from "./split-layout.ts";

/** Moves a mounted chat page's viewer declaration between gateway lifecycles. */
export function createChatViewerPresence() {
  const owner = {};
  let current: ApplicationGateway | undefined;
  function clear() {
    if (current) {
      sessionViewerPresenceForGateway(current).unwatch(owner);
      current = undefined;
    }
  }
  onCleanup(clear);
  return {
    clear,
    sync(
      gateway: ApplicationGateway | undefined,
      layout: ChatSplitLayout,
      narrow: boolean,
      unboundPaneIds: ReadonlySet<string>,
    ) {
      if (current !== gateway) {
        clear();
        current = gateway;
      }
      if (gateway) {
        sessionViewerPresenceForGateway(gateway).watch(
          owner,
          visiblePanesOf(layout, narrow)
            .filter((pane) => !unboundPaneIds.has(pane.id))
            .map((pane) => pane.sessionKey),
        );
      }
    },
  };
}
