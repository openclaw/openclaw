import type { JSX } from "@solidjs/web";
import { createEffect, onCleanup, onSettled } from "solid-js";
import { DETAILS_SECTION_MOTION } from "../../../components/details-section-motion.ts";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import "../../../styles/chat/details-desktop-body.css";

/** One scroll owner around Session and Progress; mounted only by the desktop host. */
export function ChatDetailsDesktopBody(props: {
  presented: boolean;
  loading?: boolean;
  children: JSX.Element;
  onScrollPortRef?: (element: HTMLDivElement) => void;
}) {
  let scroll!: HTMLDivElement;
  let content!: HTMLDivElement;
  let loadingHeight = 0;
  let destination = 0;
  let deadline = 0;
  let animation: Animation | undefined;
  let mounted = false;
  const finish = () => {
    loadingHeight = 0;
    if (!animation) {
      return;
    }
    animation.cancel();
    animation = undefined;
    scroll.style.removeProperty("height");
  };
  const animate = (from: number, to: number, duration: number) => {
    destination = to;
    scroll.style.height = to + "px";
    animation = scroll.animate([{ height: from + "px" }, { height: to + "px" }], {
      ...DETAILS_SECTION_MOTION,
      duration,
    });
    animation.onfinish = finish;
  };
  // Only a mounted fallback arms the handoff. Cached opens and settled updates
  // keep the original frame-batched scrollbar/fade work, without height reads.
  const handoff = ([presented, loading]: readonly [boolean, boolean]) => {
    if (!mounted) {
      return;
    }
    if (!presented) {
      finish();
      return;
    }
    if (loading) {
      finish();
      loadingHeight = scroll.getBoundingClientRect().height;
      return;
    }
    if (!loadingHeight) {
      return;
    }
    const from = loadingHeight;
    loadingHeight = 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const to = scroll.getBoundingClientRect().height;
    if (from !== to) {
      deadline = performance.now() + DETAILS_SECTION_MOTION.duration;
      animate(from, to, DETAILS_SECTION_MOTION.duration);
    }
  };
  createEffect(() => [props.presented, props.loading === true] as const, handoff);
  onSettled(() => {
    mounted = true;
    handoff([props.presented, props.loading === true]);
  });
  const measure = () => {
    if (props.presented && props.loading) {
      loadingHeight = scroll.getBoundingClientRect().height;
    }
    const nextHeight = animation ? content.getBoundingClientRect().height : destination;
    const resize = Boolean(animation) && nextHeight !== destination;
    const from = resize ? scroll.getBoundingClientRect().height : 0;
    const fadeTop = scroll.scrollTop > 1;
    const fadeBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1;
    return () => {
      if (resize && animation) {
        const duration = deadline - performance.now();
        finish();
        if (duration > 0) {
          animate(from, nextHeight, duration);
        }
      }
      scroll.toggleAttribute("data-fade-top", fadeTop);
      scroll.toggleAttribute("data-fade-bottom", fadeBottom);
    };
  };
  const update = createLayoutMeasurement(() => props.presented, measure, {
    targets: () => [scroll, content],
  });
  onCleanup(() => {
    mounted = false;
    finish();
  });
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
