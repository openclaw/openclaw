const CHAT_ATTACHMENT_VIEWPORT_MARGIN = "240px 0px";

export class ChatAttachmentViewportRef {
  private element: HTMLElement | null = null;
  private stopObserving: (() => void) | undefined;

  constructor(private readonly onVisible: () => void) {}

  readonly setElement = (element: Element | undefined): void => {
    const target = element instanceof HTMLElement ? element : null;
    if (this.element === target) {
      return;
    }
    this.disconnect();
    this.element = target;
    if (target) {
      this.stopObserving = observeChatAttachmentViewport(target, this.onVisible);
    }
  };

  disconnect(): void {
    this.stopObserving?.();
    this.stopObserving = undefined;
    this.element = null;
  }
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
