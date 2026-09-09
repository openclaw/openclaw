const CHAT_ATTACHMENT_VIEWPORT_MARGIN = "240px 0px";

// Start bounded media work just before its card or image enters view so decoding
// stays offscreen until the operator is likely to need it.
export function observeChatAttachmentViewport(element: Element, onVisible: () => void): () => void {
  if (typeof IntersectionObserver !== "function") {
    onVisible();
    return () => undefined;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      observer.disconnect();
      onVisible();
    },
    { rootMargin: CHAT_ATTACHMENT_VIEWPORT_MARGIN },
  );
  observer.observe(element);
  return () => observer.disconnect();
}
