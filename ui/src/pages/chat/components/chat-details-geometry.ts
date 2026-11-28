export type ChatDetailsElements = {
  pane?: HTMLElement;
  header?: HTMLElement;
  frame?: HTMLElement;
  footer?: HTMLElement;
  getComposerInput?: () => HTMLElement | null;
  focusComposer?: () => void;
};

export const DETAILS_WIDTH = 300;
export const DETAILS_DESKTOP_INLINE_INSET = 13;
// Reserve the default 48rem reading measure and its usual 30px side insets.
// Classic scrollbars can use a little of that measure without forcing an overlay.
export const DETAILS_DOCK_MIN_WIDTH = 768 + 2 * 30 + DETAILS_WIDTH + DETAILS_DESKTOP_INLINE_INSET;

export function measureChatDetailsDockingWidth(
  bounds: DOMRect,
  isDesktop: boolean,
  pane?: HTMLElement,
  frame?: HTMLElement,
) {
  // Dock against the layout destination, not an intermediate animation frame.
  // Otherwise the inspector releases its column halfway through a side-panel
  // opening and makes the transcript shrink past its destination, then return.
  let dockingWidth = bounds.width;
  // The chat frame still needs its destination width when Details anchors to main.
  if (isDesktop && pane && frame) {
    const style = getComputedStyle(pane);
    const sideWidth = Number.parseFloat(style.getPropertyValue("--desktop-side-reserve"));
    const dividerWidth = Number.parseFloat(style.getPropertyValue("--desktop-divider-reserve"));
    const conversationIsSide =
      frame.closest("[data-region]")?.getAttribute("data-region") === "side";
    // The pane uses border-box sizing; route-entry transforms must not
    // become the retained conversation width.
    dockingWidth = Number.parseFloat(style.width);
    if (
      !pane.classList.contains("sidebar-region--bottom") &&
      !pane.classList.contains("sidebar-region--expanded")
    ) {
      dockingWidth = conversationIsSide ? sideWidth : dockingWidth - sideWidth - dividerWidth;
    }
  }
  return dockingWidth;
}

export function positionChatDetails(
  panel: HTMLElement,
  bounds: DOMRect,
  isDesktop: boolean,
  mobile: boolean,
  conversationVisible: boolean,
  elements: ChatDetailsElements | undefined,
  footerBounds: DOMRect | undefined,
  docked: () => boolean,
  source: () => HTMLElement | undefined,
) {
  if (!isDesktop && panel.classList.contains("chat-details--docked")) {
    return;
  }
  // Measure the conversation owner, never the moving Details surface. Its
  // reservation changes the composer width, but not this frame's width.
  const composer =
    isDesktop && conversationVisible
      ? elements?.getComposerInput?.()?.getBoundingClientRect()
      : undefined;
  const viewport = window.visualViewport;
  const header = (mobile || !conversationVisible) && elements?.header?.getBoundingClientRect();
  const minimumTop = Math.max(
    (header ? header.bottom : bounds.top) + 8,
    (viewport?.offsetTop ?? 0) + 8,
  );
  const viewportRight = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth);
  const viewportBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
  const footerTop = footerBounds && footerBounds.height > 0 ? footerBounds.top : bounds.bottom;
  let top = minimumTop;
  let left: number;
  let width: number;
  let bottom: number;
  if (isDesktop) {
    // The header occupies the main grid column, excluding any visible side panel.
    const horizontalBounds = header || bounds;
    const right = Math.min(horizontalBounds.right, viewportRight) - DETAILS_DESKTOP_INLINE_INSET;
    width = Math.min(DETAILS_WIDTH, right - horizontalBounds.left - 8);
    left = right - Math.max(0, width) - (conversationVisible ? bounds.left : 0);
    bottom = Math.min(
      docked() && composer && composer.height > 0 ? composer.bottom : footerTop - 8,
      bounds.bottom - 8,
      viewportBottom - 8,
    );
  } else {
    const minimumLeft = Math.max(bounds.left, viewport?.offsetLeft ?? 0) + 8;
    const right = Math.min(bounds.right, viewportRight) - 8;
    bottom = Math.min(footerTop, bounds.bottom, viewportBottom) - 8;
    // Keep one gap below the trigger without counting the header height twice.
    const triggerBottom = source()?.getBoundingClientRect().bottom ?? minimumTop;
    top = Math.max(minimumTop, Math.min(triggerBottom + 6, bottom - 120));
    width = mobile ? right - minimumLeft : Math.min(DETAILS_WIDTH, right - minimumLeft);
    left = Math.max(minimumLeft, right - width);
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top - (isDesktop && conversationVisible ? bounds.top : 0)}px`;
  panel.style.width = `${Math.max(0, width)}px`;
  panel.style.maxHeight = `${Math.max(0, bottom - top)}px`;
  if (isDesktop) {
    panel.style.height = "auto";
  }
}

export function registerChatDetailsElement(
  elements: ChatDetailsElements,
  name: "pane" | "header" | "frame" | "footer",
  element: HTMLElement,
) {
  elements[name] = element;
  return () => {
    if (elements[name] === element) {
      delete elements[name];
    }
  };
}
