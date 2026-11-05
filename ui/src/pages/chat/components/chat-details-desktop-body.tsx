import type { JSX } from "@solidjs/web";
import { createEffect, onCleanup } from "solid-js";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import "../../../styles/chat/details-desktop.css";

/** One scroll owner around Session and Progress; mounted only by the desktop host. */
export function ChatDetailsDesktopBody(props: {
  presented: boolean;
  children: JSX.Element;
  onScrollPortRef?: (element: HTMLDivElement) => void;
  onContentChange?: (hasContent: boolean) => void;
}) {
  let scroll!: HTMLDivElement;
  let content!: HTMLDivElement;
  // Native bridges and lazy sections settle independently of the surrounding panel.
  // Observe the rendered section owners instead of duplicating their visibility policy.
  createEffect(
    () => props.onContentChange,
    (onContentChange) => {
      if (!onContentChange) {
        return;
      }
      const updateContent = () =>
        onContentChange?.(Boolean(content.querySelector("[data-details-group]")));
      const observer = new MutationObserver(updateContent);
      observer.observe(content, { childList: true, subtree: true });
      updateContent();
      onCleanup(() => {
        observer.disconnect();
        onContentChange?.(false);
      });
    },
  );
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
