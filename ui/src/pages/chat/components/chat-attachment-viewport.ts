import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { observeIntersection } from "../../../lib/reactive/observers.ts";

const CHAT_ATTACHMENT_VIEWPORT_MARGIN = "240px 0px";

export function createChatAttachmentViewportRef(onVisible: () => void) {
  return elementRef((element: Element) => observeChatAttachmentViewport(element, onVisible));
}

// Start bounded media work just before its card or image enters view so decoding
// stays offscreen until the operator is likely to need it.
export function observeChatAttachmentViewport(
  element: Element,
  onVisible: () => void,
  onHidden?: () => void,
): () => void {
  if (typeof IntersectionObserver !== "function") {
    onVisible();
    return () => undefined;
  }
  const stop = observeIntersection(
    [element],
    (entries) => {
      const entry = entries.at(-1);
      if (!entry) {
        return;
      }
      const visible = onHidden ? entry.isIntersecting : entries.some((item) => item.isIntersecting);
      if (!visible) {
        onHidden?.();
        return;
      }
      if (!onHidden) {
        stop();
      }
      onVisible();
    },
    { rootMargin: CHAT_ATTACHMENT_VIEWPORT_MARGIN },
  );
  return stop;
}
