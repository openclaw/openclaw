import { onCleanup } from "solid-js";

const CHAT_ATTACHMENT_VIEWPORT_MARGIN = "240px 0px";

export function createChatAttachmentViewportRef(onVisible: () => void) {
  let element: Element | undefined;
  let stopObserving: (() => void) | undefined;
  onCleanup(() => stopObserving?.());
  return (target: Element | undefined): void => {
    if (element === target) {
      return;
    }
    stopObserving?.();
    element = target;
    stopObserving = target ? observeChatAttachmentViewport(target, onVisible) : undefined;
  };
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
  const observer = new IntersectionObserver(
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
        observer.disconnect();
      }
      onVisible();
    },
    { rootMargin: CHAT_ATTACHMENT_VIEWPORT_MARGIN },
  );
  observer.observe(element);
  return () => observer.disconnect();
}
