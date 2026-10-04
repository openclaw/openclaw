import { html, nothing, type ElementPart } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";

// One observer per connector element: re-renders redraw without recreating it.
class ReplyConnectorDirective extends AsyncDirective {
  private element?: Element;
  private observer?: ResizeObserver;

  render() {
    return nothing;
  }

  override update(part: ElementPart) {
    this.element = part.element;
    // Lit updates the SVG before it is inserted into its message group.
    queueMicrotask(this.connect);
    return nothing;
  }

  private readonly draw = () => {
    const element = this.element!;
    const group = element.parentElement;
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

  private readonly connect = () => {
    const group = this.element?.parentElement;
    if (!this.isConnected || !this.element?.isConnected || !group) {
      return;
    }
    this.draw();
    if (!this.observer && typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(this.draw);
      this.observer.observe(group);
      const messages = group.querySelector(".chat-group-messages");
      if (messages) {
        this.observer.observe(messages);
      }
    }
  };

  protected override disconnected() {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  protected override reconnected() {
    queueMicrotask(this.connect);
  }
}

const replyConnector = directive(ReplyConnectorDirective);

export function renderReplyConnector() {
  return html`<svg class="chat-reply-connector" aria-hidden="true" ${replyConnector()}>
    <path fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"></path>
  </svg>`;
}
