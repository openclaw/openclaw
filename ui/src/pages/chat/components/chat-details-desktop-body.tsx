import type { JSX } from "@solidjs/web";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import "../../../styles/chat/details-desktop.css";

/** One scroll owner around Session and Progress; mounted only by the desktop host. */
export function ChatDetailsDesktopBody(props: {
  presented: boolean;
  children: JSX.Element;
  onScrollPortRef?: (element: HTMLDivElement) => void;
}) {
  let scroll!: HTMLDivElement;
  let content!: HTMLDivElement;
  const measure = () => {
    const fadeTop = scroll.scrollTop > 1;
    const fadeBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1;
    return () => {
      scroll.toggleAttribute("data-fade-top", fadeTop);
      scroll.toggleAttribute("data-fade-bottom", fadeBottom);
    };
  };
  const update = createLayoutMeasurement(() => props.presented, measure, {
    targets: () => [scroll, content],
  });
  return (
    <div
      ref={(element) => {
        scroll = element;
        props.onScrollPortRef?.(element);
      }}
      class="chat-details-desktop-body"
      onScroll={update}
    >
      <div ref={(element) => (content = element)} class="chat-details-desktop-body__content">
        {props.children}
      </div>
    </div>
  );
}
