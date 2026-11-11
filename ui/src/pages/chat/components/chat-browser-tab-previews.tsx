import { For, lazy } from "solid-js";
import { browserTabKey } from "../../../components/browser/browser-target.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { BrowserTabPreview } from "./chat-tool-cards.ts";
import "./browser-tab-card.css";

const BrowserTabCardHost = lazy(() => import("./browser-tab-card.tsx"), {
  export: "BrowserTabCardHost",
});

export function BrowserTabPreviews(props: {
  previews: readonly BrowserTabPreview[] | undefined;
  mediaReadAllowed?: boolean;
}) {
  return (
    <For
      each={props.mediaReadAllowed === false ? undefined : props.previews}
      keyed={(item) => browserTabKey(item.preview)}
    >
      {(item) => (
        <ChatLazyBoundary>
          <BrowserTabCardHost
            preview={item().preview}
            revision={item().revision}
            latest={item().latest}
          />
        </ChatLazyBoundary>
      )}
    </For>
  );
}
