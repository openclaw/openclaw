import type { JSX } from "@solidjs/web";
import { onSettled } from "solid-js";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import "../../../styles/chat/details-desktop.css";

/** One scroll owner around Session and Progress; mounted only by the desktop host. */
export function ChatDetailsDesktopBody(props: { presented: boolean; children: JSX.Element }) {
  let scroll!: HTMLDivElement;
  let content!: HTMLDivElement;
  const measure = () => {
    // Overlay scrollbars reserve no width; classic scrollbars reserve both gutters.
    const reserve = Math.max(0, (scroll.offsetWidth - scroll.clientWidth) / 2);
    const fadeTop = scroll.scrollTop > 1;
    const fadeBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1;
    return () => {
      scroll.style.setProperty("--details-scrollbar-reserve", `${reserve}px`);
      scroll.toggleAttribute("data-fade-top", fadeTop);
      scroll.toggleAttribute("data-fade-bottom", fadeBottom);
    };
  };
  const update = createLayoutMeasurement(() => props.presented, measure, {
    targets: () => [scroll, content],
  });
  // Reserve the initial gutters before interaction; later size/scroll work is coalesced.
  onSettled(() => {
    measure()();
  });
  return (
    <div ref={(element) => (scroll = element)} class="chat-details-desktop-body" onScroll={update}>
      <div ref={(element) => (content = element)} class="chat-details-desktop-body__content">
        {props.children}
      </div>
    </div>
  );
}
