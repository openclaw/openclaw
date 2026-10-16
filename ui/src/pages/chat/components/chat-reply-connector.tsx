import { createEffect, onCleanup, onSettled, useContext } from "solid-js";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";

/** One observer per connector; updates redraw without replacing the SVG. */
export function ReplyConnector() {
  const presented = useContext(ContentPresentation);
  let element: SVGSVGElement;
  let observer: ResizeObserver | undefined;
  let disposed = false;
  const draw = () => {
    const group = element.closest(".chat-message--reply, .chat-group");
    const row = group?.querySelector(".chat-reply-attribution--reply");
    const label = row?.querySelector(".chat-reply-attribution__label");
    const avatar = group?.querySelector(":scope > .chat-avatar, :scope > .chat-avatar-slot");
    if (!element.isConnected || !group || !row || !label || !avatar) {
      return;
    }
    const bounds = group.getBoundingClientRect();
    const identity = avatar.getBoundingClientRect();
    const text = label.getBoundingClientRect();
    const startX = identity.left + identity.width / 2 - bounds.left;
    const startY = identity.top - bounds.top;
    const direction = getComputedStyle(group).direction === "rtl" ? -1 : 1;
    const rowBounds = row.getBoundingClientRect();
    const endX = (direction === 1 ? rowBounds.left : rowBounds.right) - bounds.left - direction * 5;
    const endY = text.top + text.height / 2 - bounds.top;
    element.setAttribute("width", String(bounds.width));
    element.setAttribute("height", String(bounds.height));
    element.firstElementChild?.setAttribute(
      "d",
      `M ${startX} ${startY} V ${endY + 7} Q ${startX} ${endY} ${startX + direction * 7} ${endY} H ${endX}`,
    );
  };
  const disconnect = () => {
    observer?.disconnect();
    observer = undefined;
  };
  const connect = () => {
    const group = element.closest(".chat-message--reply, .chat-group");
    if (disposed || !presented() || !element.isConnected || !group) {
      return;
    }
    draw();
    if (!observer && typeof ResizeObserver === "function") {
      observer = new ResizeObserver(draw);
      observer.observe(group);
      const messages = group.querySelector(".chat-group-messages");
      if (messages) {
        observer.observe(messages);
      }
    }
  };
  onSettled(connect);
  createEffect(presented, (active) => {
    if (active) {
      queueMicrotask(connect);
    } else {
      disconnect();
    }
  });
  onCleanup(() => {
    disposed = true;
    disconnect();
  });
  return (
    <svg
      ref={(node) => {
        element = node;
      }}
      class="chat-reply-connector"
      aria-hidden="true"
    >
      <path fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
    </svg>
  );
}
