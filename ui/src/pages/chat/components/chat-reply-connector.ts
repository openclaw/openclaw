import { html } from "lit";
import { ref } from "lit/directives/ref.js";

function replyConnectorRef() {
  let observer: ResizeObserver | undefined;
  let current: Element | undefined;
  return (element: Element | undefined) => {
    observer?.disconnect();
    observer = undefined;
    current = element;
    if (!element) {
      return;
    }
    // Lit refs can run before the SVG is inserted into its message group.
    queueMicrotask(() => {
      const group = element.parentElement;
      if (current !== element || !element.isConnected || !group) {
        return;
      }
      const update = () => {
        const row = group.querySelector(".chat-reply-attribution--reply");
        const label = row?.querySelector(".chat-reply-attribution__label");
        const avatar = group.querySelector(":scope > .chat-avatar, :scope > .chat-avatar-slot");
        if (!element.isConnected || !row || !label || !avatar) {
          return;
        }
        const bounds = group.getBoundingClientRect();
        const identity = avatar.getBoundingClientRect();
        const text = label.getBoundingClientRect();
        const startX = identity.left + identity.width / 2 - bounds.left;
        const startY = identity.top - bounds.top;
        const direction = getComputedStyle(group).direction === "rtl" ? -1 : 1;
        const rowBounds = row.getBoundingClientRect();
        const endX =
          (direction === 1 ? rowBounds.left : rowBounds.right) - bounds.left - direction * 5;
        const endY = text.top + text.height / 2 - bounds.top;
        element.setAttribute("width", String(bounds.width));
        element.setAttribute("height", String(bounds.height));
        element.firstElementChild?.setAttribute(
          "d",
          `M ${startX} ${startY} V ${endY + 7} Q ${startX} ${endY} ${startX + direction * 7} ${endY} H ${endX}`,
        );
      };
      update();
      if (typeof ResizeObserver === "function") {
        observer = new ResizeObserver(update);
        observer.observe(group);
        const messages = group.querySelector(".chat-group-messages");
        if (messages) {
          observer.observe(messages);
        }
      }
    });
  };
}

export function renderReplyConnector() {
  return html`<svg class="chat-reply-connector" aria-hidden="true" ${ref(replyConnectorRef())}>
    <path fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"></path>
  </svg>`;
}
