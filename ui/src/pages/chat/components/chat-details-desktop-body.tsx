import type { JSX } from "@solidjs/web";
import { onSettled } from "solid-js";
import { DETAILS_SECTION_MOTION } from "../../../components/details-section-motion.ts";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { createMediaQuery } from "../../../lib/reactive/platform.ts";
import "../../../styles/chat/details-desktop.css";

/** One scroll owner around Session and Progress; mounted only by the desktop host. */
export function ChatDetailsDesktopBody(props: {
  presented: boolean;
  ready?: boolean;
  children: JSX.Element;
  onScrollPortRef?: (element: HTMLDivElement) => void;
}) {
  let scroll!: HTMLDivElement;
  let content!: HTMLDivElement;
  const reduced = createMediaQuery("(prefers-reduced-motion: reduce)");
  let ready: boolean | undefined;
  let height = 0;
  let destination = 0;
  let deadline = 0;
  let animation: Animation | undefined;
  const finish = () => {
    animation?.cancel();
    animation = undefined;
    scroll.style.height = "";
  };
  const measure = (state: readonly [boolean, boolean, boolean] | undefined) => {
    if (!state) {
      return undefined;
    }
    const [presented, contentReady, reducedMotion] = state;
    const nextHeight = content.getBoundingClientRect().height;
    const handoff = ready === false && contentReady && height > 0;
    const from = animation ? scroll.getBoundingClientRect().height : height;
    const resize = Boolean(animation) && nextHeight !== destination;
    ready = contentReady;
    height = nextHeight;
    // Overlay scrollbars reserve no width; classic scrollbars reserve both gutters.
    const reserve = Math.max(0, (scroll.offsetWidth - scroll.clientWidth) / 2);
    const fadeTop = scroll.scrollTop > 1;
    const fadeBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1;
    return () => {
      if (!presented || reducedMotion) {
        finish();
      } else if (handoff || resize) {
        if (handoff) {
          deadline = performance.now() + DETAILS_SECTION_MOTION.duration;
        }
        const duration = deadline - performance.now();
        finish();
        if (duration > 0 && from !== nextHeight) {
          destination = nextHeight;
          scroll.style.height = `${nextHeight}px`;
          animation = scroll.animate([{ height: `${from}px` }, { height: `${nextHeight}px` }], {
            ...DETAILS_SECTION_MOTION,
            duration,
          });
          animation.onfinish = finish;
        }
      }
      scroll.style.setProperty("--details-scrollbar-reserve", `${reserve}px`);
      scroll.toggleAttribute("data-fade-top", fadeTop);
      scroll.toggleAttribute("data-fade-bottom", fadeBottom);
    };
  };
  // Retain one measured shell across the lazy handoff. Later section animations
  // keep their own geometry; the shell releases its height when this handoff ends.
  const update = createLayoutMeasurement(
    () => [props.presented, props.ready ?? true, reduced()] as const,
    measure,
    { targets: () => [scroll, content], changeTiming: "sync" },
  );
  onSettled(() => finish);
  return (
    <div
      ref={(element) => {
        scroll = element;
        props.onScrollPortRef?.(element);
      }}
      class="chat-details-desktop-body"
      onScroll={update}
      onFocusIn={finish}
    >
      <div ref={(element) => (content = element)} class="chat-details-desktop-body__content">
        {props.children}
      </div>
    </div>
  );
}
