/** Distance (px) from the bottom within which we consider the user "near bottom". */
const NEAR_BOTTOM_THRESHOLD = 450;
/** Small escape hatch so slight upward manual scroll cancels auto-follow quickly. */
const MANUAL_SCROLL_RELEASE_THRESHOLD = 24;
/** Once the user takes over scroll, only re-enable follow when they are back at bottom. */
const FOLLOW_REACQUIRE_THRESHOLD = 24;

type ScrollHost = {
  updateComplete: Promise<unknown>;
  querySelector: (selectors: string) => Element | null;
  style: CSSStyleDeclaration;
  chatScrollFrame: number | null;
  chatScrollTimeout: number | null;
  chatHasAutoScrolled: boolean;
  chatUserNearBottom: boolean;
  chatFollowLocked: boolean;
  chatSmoothAutoScrolling: boolean;
  chatLastScrollTop: number;
  chatNewMessagesBelow: boolean;
  logsScrollFrame: number | null;
  logsAtBottom: boolean;
  topbarObserver: ResizeObserver | null;
};

function cancelPendingChatScroll(host: ScrollHost) {
  if (host.chatScrollFrame) {
    cancelAnimationFrame(host.chatScrollFrame);
    host.chatScrollFrame = null;
  }
  if (host.chatScrollTimeout != null) {
    clearTimeout(host.chatScrollTimeout);
    host.chatScrollTimeout = null;
  }
}

export function scheduleChatScroll(host: ScrollHost, force = false, smooth = false) {
  cancelPendingChatScroll(host);
  const pickScrollTarget = () => {
    const container = host.querySelector(".chat-thread") as HTMLElement | null;
    if (container) {
      const overflowY = getComputedStyle(container).overflowY;
      const canScroll =
        overflowY === "auto" ||
        overflowY === "scroll" ||
        container.scrollHeight - container.clientHeight > 1;
      if (canScroll) {
        return container;
      }
    }
    return (document.scrollingElement ?? document.documentElement) as HTMLElement | null;
  };
  // Wait for Lit render to complete, then scroll
  void host.updateComplete.then(() => {
    host.chatScrollFrame = requestAnimationFrame(() => {
      host.chatScrollFrame = null;
      const target = pickScrollTarget();
      if (!target) {
        return;
      }
      // force=true only overrides when we haven't auto-scrolled yet (initial load).
      // After initial load, respect the user's scroll position.
      const effectiveForce = force && !host.chatHasAutoScrolled;
      const shouldStick = effectiveForce || (host.chatUserNearBottom && !host.chatFollowLocked);

      if (!shouldStick) {
        // User is scrolled up — flag that new content arrived below.
        host.chatNewMessagesBelow = true;
        return;
      }
      if (effectiveForce) {
        host.chatHasAutoScrolled = true;
      }
      const smoothEnabled =
        smooth &&
        (typeof window === "undefined" ||
          typeof window.matchMedia !== "function" ||
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      const scrollTop = target.scrollHeight;
      if (typeof target.scrollTo === "function") {
        target.scrollTo({ top: scrollTop, behavior: smoothEnabled ? "smooth" : "auto" });
      } else {
        target.scrollTop = scrollTop;
      }
      host.chatUserNearBottom = true;
      host.chatFollowLocked = false;
      host.chatSmoothAutoScrolling = smoothEnabled;
      host.chatLastScrollTop = smoothEnabled
        ? Math.max(target.scrollTop, 0)
        : Math.max(0, target.scrollHeight - target.clientHeight);
      host.chatNewMessagesBelow = false;
      const retryDelay = effectiveForce ? 150 : 120;
      host.chatScrollTimeout = window.setTimeout(() => {
        host.chatScrollTimeout = null;
        const latest = pickScrollTarget();
        if (!latest) {
          return;
        }
        const shouldStickRetry =
          effectiveForce || (host.chatUserNearBottom && !host.chatFollowLocked);
        if (!shouldStickRetry) {
          return;
        }
        latest.scrollTop = latest.scrollHeight;
        host.chatUserNearBottom = true;
        host.chatFollowLocked = false;
        host.chatSmoothAutoScrolling = false;
        host.chatLastScrollTop = Math.max(0, latest.scrollHeight - latest.clientHeight);
      }, retryDelay);
    });
  });
}

export function scheduleLogsScroll(host: ScrollHost, force = false) {
  if (host.logsScrollFrame) {
    cancelAnimationFrame(host.logsScrollFrame);
  }
  void host.updateComplete.then(() => {
    host.logsScrollFrame = requestAnimationFrame(() => {
      host.logsScrollFrame = null;
      const container = host.querySelector(".log-stream") as HTMLElement | null;
      if (!container) {
        return;
      }
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const shouldStick = force || distanceFromBottom < 80;
      if (!shouldStick) {
        return;
      }
      container.scrollTop = container.scrollHeight;
    });
  });
}

export function handleChatScroll(host: ScrollHost, event: Event) {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const currentScrollTop = container.scrollTop;
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  const nearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
  const scrollingUp = currentScrollTop < host.chatLastScrollTop;
  const backAtBottom = distanceFromBottom <= FOLLOW_REACQUIRE_THRESHOLD;

  if (host.chatSmoothAutoScrolling) {
    if (backAtBottom || !scrollingUp) {
      host.chatSmoothAutoScrolling = false;
    }
  } else if (
    host.chatUserNearBottom &&
    scrollingUp &&
    distanceFromBottom > MANUAL_SCROLL_RELEASE_THRESHOLD
  ) {
    host.chatUserNearBottom = false;
    host.chatFollowLocked = true;
  } else if (backAtBottom) {
    host.chatUserNearBottom = true;
    host.chatFollowLocked = false;
  } else if (!host.chatFollowLocked && nearBottom) {
    host.chatUserNearBottom = true;
  }

  host.chatLastScrollTop = Math.max(currentScrollTop, 0);
  // Clear the "new messages below" indicator when user scrolls back to bottom.
  if (host.chatUserNearBottom && !host.chatFollowLocked) {
    host.chatNewMessagesBelow = false;
  }
}

export function handleChatWheelIntent(host: ScrollHost, event: WheelEvent) {
  if (event.deltaY >= 0) {
    return;
  }
  const container = event.currentTarget as HTMLElement | null;
  if (!container || container.scrollHeight - container.clientHeight <= 1) {
    return;
  }
  if (!host.chatUserNearBottom && host.chatFollowLocked) {
    return;
  }
  cancelPendingChatScroll(host);
  host.chatSmoothAutoScrolling = false;
  host.chatUserNearBottom = false;
  host.chatFollowLocked = true;
}

export function handleLogsScroll(host: ScrollHost, event: Event) {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  host.logsAtBottom = distanceFromBottom < 80;
}

export function resetChatScroll(host: ScrollHost) {
  host.chatHasAutoScrolled = false;
  host.chatUserNearBottom = true;
  host.chatFollowLocked = false;
  host.chatSmoothAutoScrolling = false;
  host.chatLastScrollTop = 0;
  host.chatNewMessagesBelow = false;
}

export function exportLogs(lines: string[], label: string) {
  if (lines.length === 0) {
    return;
  }
  const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  anchor.href = url;
  anchor.download = `openclaw-logs-${label}-${stamp}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function observeTopbar(host: ScrollHost) {
  if (typeof ResizeObserver === "undefined") {
    return;
  }
  const topbar = host.querySelector(".topbar");
  if (!topbar) {
    return;
  }
  const update = () => {
    const { height } = topbar.getBoundingClientRect();
    host.style.setProperty("--topbar-height", `${height}px`);
  };
  update();
  host.topbarObserver = new ResizeObserver(() => update());
  host.topbarObserver.observe(topbar);
}
