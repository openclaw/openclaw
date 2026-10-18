import type { JSX } from "@solidjs/web";
import { createEffect, onSettled } from "solid-js";
import "../../../styles/chat/details-desktop.css";

/** One scroll owner around Session and Progress; mounted only by the desktop host. */
export function ChatDetailsDesktopBody(props: { presented: boolean; children: JSX.Element }) {
  let scroll!: HTMLDivElement;
  let content!: HTMLDivElement;
  const update = () => {
    // Overlay scrollbars reserve no width; classic scrollbars reserve both gutters.
    scroll.style.setProperty(
      "--details-scrollbar-reserve",
      `${Math.max(0, (scroll.offsetWidth - scroll.clientWidth) / 2)}px`,
    );
    scroll.toggleAttribute("data-fade-top", scroll.scrollTop > 1);
    scroll.toggleAttribute(
      "data-fade-bottom",
      scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1,
    );
  };
  createEffect(() => props.presented, update);
  onSettled(() => {
    const resize = new ResizeObserver(update);
    resize.observe(scroll);
    resize.observe(content);
    update();
    return () => resize.disconnect();
  });
  return (
    <div ref={(element) => (scroll = element)} class="chat-details-desktop-body" onScroll={update}>
      <div ref={(element) => (content = element)} class="chat-details-desktop-body__content">
        {props.children}
      </div>
    </div>
  );
}
