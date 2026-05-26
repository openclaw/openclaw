import { normalizeChatAutoScrollMode, type ChatAutoScrollMode } from "./storage.ts";

/** Distance (px) from the bottom within which we consider the user "near bottom". */
const NEAR_BOTTOM_THRESHOLD = 450;
const HEADER_HIDE_SCROLL_DELTA = 12;
const HEADER_SHOW_TOP_THRESHOLD = 24;
/** Small upward movement should stop auto-follow before the user fully leaves the old threshold. */
const MANUAL_SCROLL_RELEASE_THRESHOLD = 24;
/** Re-enable follow only once the user is effectively back at the bottom. */
const FOLLOW_REACQUIRE_THRESHOLD = 24;

type ScrollHost = {
  updateComplete: Promise<unknown>;
  querySelector: (selectors: string) => Element | null;
  style: CSSStyleDeclaration;
  chatScrollFrame: number | null;
  chatScrollTimeout: number | null;
  chatLastScrollTop: number;
  chatHasAutoScrolled: boolean;
  chatUserNearBottom: boolean;
  chatHeaderControlsHidden: boolean;
  chatFollowLocked: boolean;
  chatSmoothAutoScrolling: boolean;
  chatNewMessagesBelow: boolean;
  chatIsProgrammaticScroll: boolean;
  chatProgrammaticScrollTarget: number;
  settings?: {
    chatAutoScroll?: ChatAutoScrollMode;
    chatFocusMode?: boolean;
  };
  logsScrollFrame: number | null;
  logsAtBottom: boolean;
  activityScrollFrame?: number | null;
  activityAutoFollow?: boolean;
  activityAtBottom?: boolean;
  topbarObserver: ResizeObserver | null;
};

function queryHost(host: Partial<ScrollHost>, selectors: string): Element | null {
  return typeof host.querySelector === "function" ? host.querySelector(selectors) : null;
}

type ChatScrollOptions = {
  source?: "auto" | "manual";
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

function canConsumeVerticalWheelDelta(node: HTMLElement, deltaY: number) {
  const overflowY = getComputedStyle(node).overflowY;
  const hasVerticalScrollRange = node.scrollHeight - node.clientHeight > 1;
  const canScrollVertically =
    (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
    hasVerticalScrollRange;
  if (!canScrollVertically) {
    return false;
  }
  if (deltaY < 0) {
    return node.scrollTop > 1;
  }
  return node.scrollTop + node.clientHeight < node.scrollHeight - 1;
}

function hasNestedScrollableAncestor(
  target: EventTarget | null,
  container: HTMLElement,
  deltaY: number,
) {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== container) {
    if (canConsumeVerticalWheelDelta(node, deltaY)) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

export function scheduleChatScroll(
  host: ScrollHost,
  force = false,
  smooth = false,
  options: ChatScrollOptions = {},
) {
  cancelPendingChatScroll(host);
  const pickScrollTarget = () => {
    const container = queryHost(host, ".chat-thread") as HTMLElement | null;
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
      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      const autoScrollMode = normalizeChatAutoScrollMode(host.settings?.chatAutoScroll);
      const manualScroll = options.source === "manual";

      // force=true only overrides when we haven't auto-scrolled yet (initial load).
      // After initial load, respect the user's scroll position.
      const effectiveForce = force && !host.chatHasAutoScrolled;
      const hasVerticalScrollRange = target.scrollHeight - target.clientHeight > 1;
      const shouldStick =
        manualScroll ||
        autoScrollMode === "always" ||
        (autoScrollMode === "near-bottom" &&
          (effectiveForce ||
            (!host.chatFollowLocked &&
              (host.chatUserNearBottom ||
                distanceFromBottom < NEAR_BOTTOM_THRESHOLD ||
                !hasVerticalScrollRange))));

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
      host.chatProgrammaticScrollTarget = scrollTop;
      host.chatIsProgrammaticScroll = true;
      if (typeof target.scrollTo === "function") {
        target.scrollTo({ top: scrollTop, behavior: smoothEnabled ? "smooth" : "auto" });
      } else {
        target.scrollTop = scrollTop;
      }
      // Clear the flag after the scroll event has fired (sync or next microtask).
      requestAnimationFrame(() => {
        host.chatIsProgrammaticScroll = false;
      });
      host.chatUserNearBottom = true;
      host.chatFollowLocked = false;
      host.chatSmoothAutoScrolling = smoothEnabled;
      // Smooth scroll events compare against this baseline; repeated stream ticks reset it
      // to the latest in-flight position so only real upward movement releases follow.
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
        const latestDistanceFromBottom =
          latest.scrollHeight - latest.scrollTop - latest.clientHeight;
        const shouldStickRetry =
          manualScroll ||
          autoScrollMode === "always" ||
          (autoScrollMode === "near-bottom" &&
            (effectiveForce ||
              (!host.chatFollowLocked &&
                (host.chatUserNearBottom || latestDistanceFromBottom < NEAR_BOTTOM_THRESHOLD))));
        if (!shouldStickRetry) {
          return;
        }
        host.chatProgrammaticScrollTarget = latest.scrollHeight;
        host.chatIsProgrammaticScroll = true;
        latest.scrollTop = latest.scrollHeight;
        requestAnimationFrame(() => {
          host.chatIsProgrammaticScroll = false;
        });
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
      const container = queryHost(host, ".log-stream") as HTMLElement | null;
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

export function scheduleActivityScroll(host: ScrollHost, force = false) {
  if (host.activityScrollFrame) {
    cancelAnimationFrame(host.activityScrollFrame);
  }
  void host.updateComplete.then(() => {
    host.activityScrollFrame = requestAnimationFrame(() => {
      host.activityScrollFrame = null;
      const container = queryHost(host, ".activity-stream") as HTMLElement | null;
      if (!container) {
        return;
      }
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const shouldStick =
        force ||
        (host.activityAutoFollow !== false &&
          (host.activityAtBottom !== false || distanceFromBottom < 120));
      if (!shouldStick) {
        return;
      }
      container.scrollTop = container.scrollHeight;
      host.activityAtBottom = true;
    });
  });
}

export function handleChatScroll(host: ScrollHost, event: Event) {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const currentScrollTop = Math.max(0, container.scrollTop);
  const delta = currentScrollTop - host.chatLastScrollTop;
  // Ignore scroll events that we ourselves triggered — they must not flip
  // chatUserNearBottom to false while streaming content grows the page.
  // Only suppress if scrollTop is still at or above the position we scrolled to;
  // if it dropped below, the user scrolled up during the guard window and we must
  // process the event so streaming stops pinning them back to the bottom.
  if (
    host.chatIsProgrammaticScroll &&
    currentScrollTop >= host.chatProgrammaticScrollTarget - container.clientHeight
  ) {
    host.chatLastScrollTop = currentScrollTop;
    return;
  }
  const distanceFromBottom = container.scrollHeight - currentScrollTop - container.clientHeight;
  const nearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
  const scrollingUp = currentScrollTop < host.chatLastScrollTop;
  const backAtBottom = distanceFromBottom <= FOLLOW_REACQUIRE_THRESHOLD;
  const hasUsefulScroll = container.scrollHeight - container.clientHeight > NEAR_BOTTOM_THRESHOLD;

  if (!host.settings?.chatFocusMode) {
    if (!hasUsefulScroll || currentScrollTop <= HEADER_SHOW_TOP_THRESHOLD || nearBottom) {
      host.chatHeaderControlsHidden = false;
    } else if (delta > HEADER_HIDE_SCROLL_DELTA) {
      host.chatHeaderControlsHidden = true;
    } else if (delta < -HEADER_HIDE_SCROLL_DELTA) {
      host.chatHeaderControlsHidden = false;
    }
  }

  if (host.chatSmoothAutoScrolling) {
    if (scrollingUp && distanceFromBottom > MANUAL_SCROLL_RELEASE_THRESHOLD) {
      host.chatSmoothAutoScrolling = false;
      host.chatUserNearBottom = false;
      host.chatFollowLocked = true;
    } else if (backAtBottom || !scrollingUp) {
      host.chatSmoothAutoScrolling = false;
    }
  } else if (
    host.chatUserNearBottom &&
    scrollingUp &&
    distanceFromBottom > MANUAL_SCROLL_RELEASE_THRESHOLD
  ) {
    host.chatUserNearBottom = false;
    host.chatFollowLocked = true;
  } else if (backAtBottom && !scrollingUp) {
    host.chatUserNearBottom = true;
    host.chatFollowLocked = false;
  } else if (!host.chatFollowLocked && nearBottom && !scrollingUp) {
    host.chatUserNearBottom = true;
  } else if (!nearBottom && !host.chatFollowLocked) {
    host.chatUserNearBottom = false;
  }

  host.chatLastScrollTop = currentScrollTop;
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
  if (hasNestedScrollableAncestor(event.target, container, event.deltaY)) {
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

export function handleActivityScroll(host: ScrollHost, event: Event) {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  host.activityAtBottom = distanceFromBottom < 120;
}

export function resetChatScroll(host: ScrollHost) {
  host.chatHasAutoScrolled = false;
  host.chatUserNearBottom = true;
  host.chatHeaderControlsHidden = false;
  host.chatFollowLocked = false;
  host.chatSmoothAutoScrolling = false;
  host.chatLastScrollTop = 0;
  host.chatNewMessagesBelow = false;
  host.chatIsProgrammaticScroll = false;
  host.chatProgrammaticScrollTarget = 0;
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
  const topbar = queryHost(host, ".topbar");
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
