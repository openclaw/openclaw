import { createSignal, lazy } from "solid-js";
import type { MenuHandle } from "../../../components/solid/menu.tsx";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { loadChatDetailsDesktopComposition } from "./chat-details-desktop-loader.ts";
import { ChatDetailsDesktopLoading } from "./chat-details-loading.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import "../../../styles/chat/details-desktop-body.css";

const ChatDetailsDesktopComposition = lazy(loadChatDetailsDesktopComposition, {
  export: "ChatDetailsDesktopComposition",
});

export function ChatDetailsDesktopContent(props: {
  chat?: ChatDetailsProps;
  presented: boolean;
  dismissed: boolean;
  cachedReady: boolean;
  progressMenuRef: (menu: MenuHandle | undefined) => void;
  onHideProgress: () => void;
}) {
  const [scrollport, setScrollport] = createSignal<HTMLDivElement>();
  let scroll!: HTMLDivElement;
  let content!: HTMLDivElement;
  const update = createLayoutMeasurement(
    () => props.presented,
    () => {
      const fadeTop = scroll.scrollTop > 1;
      const fadeBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1;
      return () => {
        scroll.toggleAttribute("data-fade-top", fadeTop);
        scroll.toggleAttribute("data-fade-bottom", fadeBottom);
      };
    },
    { targets: () => [scroll, content] },
  );
  return (
    <div
      ref={(element) => {
        scroll = element;
        setScrollport(element);
      }}
      class="chat-details-desktop-body"
      onScroll={update}
    >
      <div ref={(element) => (content = element)} class="chat-details-desktop-body__content">
        <ChatLazyBoundary fallback={!props.cachedReady && <ChatDetailsDesktopLoading />}>
          <ChatDetailsDesktopComposition
            scrollport={scrollport()}
            props={props.chat}
            presented={props.presented}
            dismissed={props.dismissed}
            progressMenuRef={props.progressMenuRef}
            onHideProgress={props.onHideProgress}
          />
        </ChatLazyBoundary>
      </div>
    </div>
  );
}
