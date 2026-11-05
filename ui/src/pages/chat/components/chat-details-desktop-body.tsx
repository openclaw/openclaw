import type { JSX } from "@solidjs/web";
import { Show, createMemo, onSettled } from "solid-js";
import { DETAILS_SECTION_MOTION } from "../../../components/details-section-motion-options.ts";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import "../../../styles/chat/details-desktop-body.css";

export type ChatDetailsHandoff = {
  onLoading: (loading: boolean) => void;
  onReady: () => void;
};

/** One scroll owner around Session and Progress; mounted only by the desktop host. */
export function ChatDetailsDesktopBody(props: {
  presented: boolean;
  children: (handoff: ChatDetailsHandoff) => JSX.Element;
  onScrollPortRef?: (element: HTMLDivElement) => void;
}) {
  // Lifecycle callbacks must not initialize a lazy prop inside their effect scope.
  const isPresented = createMemo(() => props.presented);
  let scroll!: HTMLDivElement;
  let content!: HTMLDivElement;
  let pending = false;
  let loadingHeight = 0;
  let destination = 0;
  let deadline = 0;
  let animation: Animation | undefined;
  const finish = () => {
    loadingHeight = 0;
    animation?.cancel();
    animation = undefined;
  };
  const animate = (from: number, to: number, duration: number) => {
    destination = to;
    animation = scroll.animate([{ height: from + "px" }, { height: to + "px" }], {
      ...DETAILS_SECTION_MOTION,
      duration,
      fill: "both",
    });
    animation.onfinish = finish;
  };
  // The actual fallback and loaded composition own these lifecycle events.
  // Cached content never arms the handoff or adds geometry work to scrolling.
  const onLoading = (loading: boolean) => {
    pending = loading;
    if (loading) {
      finish();
      if (isPresented()) {
        loadingHeight = scroll.getBoundingClientRect().height;
      }
    }
  };
  const onReady = () => {
    pending = false;
    if (!isPresented()) {
      finish();
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
  const measure = () => {
    const presented = isPresented();
    if (presented && pending) {
      loadingHeight = scroll.getBoundingClientRect().height;
    }
    const nextHeight =
      presented && animation ? content.getBoundingClientRect().height : destination;
    const resize = presented && Boolean(animation) && nextHeight !== destination;
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
  const update = createLayoutMeasurement(() => isPresented(), measure, {
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
      onFocusIn={finish}
    >
      <Show when={isPresented() ? finish : undefined} keyed>
        {(cancel) => {
          onSettled(() => cancel);
          return null;
        }}
      </Show>
      <div ref={(element) => (content = element)} class="chat-details-desktop-body__content">
        {props.children({ onLoading, onReady })}
      </div>
    </div>
  );
}
