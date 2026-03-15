type MobileViewportHost = {
  updateComplete: Promise<unknown>;
};

type MobileViewportController = {
  cleanup: () => void;
  setShellLocked: (locked: boolean) => void;
};

function isIosDevice(): boolean {
  const { userAgent, platform, maxTouchPoints } = navigator;
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

function isTextEntryElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return target.type !== "checkbox" && target.type !== "radio" && target.type !== "button";
  }
  return target.isContentEditable;
}

export function attachMobileViewportFixes(
  host: MobileViewportHost & HTMLElement,
): MobileViewportController {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { cleanup: () => {}, setShellLocked: () => {} };
  }
  const viewport = window.visualViewport;
  if (!viewport || !isIosDevice()) {
    return { cleanup: () => {}, setShellLocked: () => {} };
  }

  const root = document.documentElement;
  const body = document.body;
  let restoreTimer: number | null = null;
  let focusTimer: number | null = null;
  let inputObserver: ResizeObserver | null = null;
  let observedInput: HTMLElement | null = null;
  let maxViewportHeight = Math.round(viewport.height);

  const setShellLocked = (locked: boolean) => {
    root.toggleAttribute("data-ios-shell-lock", locked);
    body.toggleAttribute("data-ios-shell-lock", locked);
    host.toggleAttribute("data-ios-shell-lock", locked);
  };

  const setKeyboardOpen = (open: boolean) => {
    root.toggleAttribute("data-ios-keyboard-open", open);
    body.toggleAttribute("data-ios-keyboard-open", open);
    host.toggleAttribute("data-ios-keyboard-open", open);
  };

  const updateViewportHeight = () => {
    const height = Math.round(viewport.height);
    maxViewportHeight = Math.max(maxViewportHeight, height);
    root.style.setProperty("--mobile-viewport-height", `${height}px`);
    root.style.setProperty("--mobile-layout-height", `${maxViewportHeight}px`);
    setKeyboardOpen(maxViewportHeight - height > 120);
  };

  const syncChatInputMetrics = () => {
    const input = host.querySelector(".content--chat .agent-chat__input");
    if (!input) {
      inputObserver?.disconnect();
      inputObserver = null;
      observedInput = null;
      root.style.removeProperty("--mobile-chat-input-height");
      return;
    }
    const measure = () => {
      root.style.setProperty(
        "--mobile-chat-input-height",
        `${Math.ceil(input.getBoundingClientRect().height)}px`,
      );
    };
    measure();
    if (observedInput === input) {
      return;
    }
    inputObserver?.disconnect();
    observedInput = input;
    if (typeof ResizeObserver !== "undefined") {
      inputObserver = new ResizeObserver(() => measure());
      inputObserver.observe(input);
    }
  };

  const restoreDocumentScroll = () => {
    if (restoreTimer != null) {
      clearTimeout(restoreTimer);
    }
    restoreTimer = window.setTimeout(() => {
      restoreTimer = null;
      if (isTextEntryElement(document.activeElement)) {
        return;
      }
      void host.updateComplete.then(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.scrollTo({ top: 0, left: 0, behavior: "auto" });
            const scrollingElement = document.scrollingElement ?? document.documentElement;
            scrollingElement.scrollTop = 0;
            updateViewportHeight();
            syncChatInputMetrics();
          });
        });
      });
    }, 120);
  };

  const handleViewportChange = () => {
    updateViewportHeight();
    restoreDocumentScroll();
  };

  const handleFocusIn = (event: FocusEvent) => {
    if (!isTextEntryElement(event.target)) {
      return;
    }
    if (focusTimer != null) {
      clearTimeout(focusTimer);
    }
    focusTimer = window.setTimeout(() => {
      focusTimer = null;
      updateViewportHeight();
      syncChatInputMetrics();
      restoreDocumentScroll();
    }, 80);
  };

  const handleFocusOut = () => {
    restoreDocumentScroll();
  };

  updateViewportHeight();
  void host.updateComplete.then(() => syncChatInputMetrics());
  viewport.addEventListener("resize", handleViewportChange);
  viewport.addEventListener("scroll", handleViewportChange);
  window.addEventListener("orientationchange", handleViewportChange);
  document.addEventListener("focusin", handleFocusIn, true);
  document.addEventListener("focusout", handleFocusOut, true);

  return {
    setShellLocked,
    cleanup: () => {
      if (restoreTimer != null) {
        clearTimeout(restoreTimer);
      }
      if (focusTimer != null) {
        clearTimeout(focusTimer);
      }
      inputObserver?.disconnect();
      inputObserver = null;
      observedInput = null;
      viewport.removeEventListener("resize", handleViewportChange);
      viewport.removeEventListener("scroll", handleViewportChange);
      window.removeEventListener("orientationchange", handleViewportChange);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      setShellLocked(false);
      setKeyboardOpen(false);
      root.style.removeProperty("--mobile-layout-height");
      root.style.removeProperty("--mobile-viewport-height");
      root.style.removeProperty("--mobile-chat-input-height");
    },
  };
}
