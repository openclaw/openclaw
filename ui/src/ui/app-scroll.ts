/** Small epsilon for bottom detection to avoid subpixel drift. */
const BOTTOM_EPSILON = 0.5;

export type ChatAutoScrollMode = "bottom" | "clamp";

type ScrollHost = {
  updateComplete: Promise<unknown>;
  querySelector: (selectors: string) => Element | null;
  style: CSSStyleDeclaration;
  chatScrollFrame: number | null;
  chatScrollTimeout: number | null;
  chatHasAutoScrolled: boolean;
  chatLastScrollTop: number | null;
  chatAutoScrollBlockId: string | null;
  chatAutoScrollMode: ChatAutoScrollMode;
  chatSuppressedBlockId: string | null;
  chatUserNearBottom: boolean;
  chatNewMessagesBelow: boolean;
  logsScrollFrame: number | null;
  logsAtBottom: boolean;
  topbarObserver: ResizeObserver | null;
};

type LatestChatBlock = {
  element: HTMLElement;
  id: string | null;
  defaultMode: ChatAutoScrollMode;
};

function pickLatestChatBlock(host: ScrollHost): LatestChatBlock | null {
  const threadInner = host.querySelector(".chat-thread-inner") as HTMLElement | null;
  if (!threadInner) {
    return null;
  }
  const blocks = threadInner.querySelectorAll<HTMLElement>("[data-chat-block]");
  const latest = blocks.length > 0 ? blocks[blocks.length - 1] : null;
  if (!latest) {
    return null;
  }
  return {
    element: latest,
    id: latest.dataset.chatBlockId?.trim() || null,
    defaultMode: latest.hasAttribute("data-chat-streaming") ? "clamp" : "bottom",
  };
}

function computeBottomScrollTop(target: HTMLElement): number {
  return Math.max(0, target.scrollHeight - target.clientHeight);
}

function computeChatScrollTop(
  target: HTMLElement,
  latestBlock: LatestChatBlock | null,
  mode: ChatAutoScrollMode,
): number {
  const bottomScrollTop = computeBottomScrollTop(target);
  if (!latestBlock || mode === "bottom") {
    return bottomScrollTop;
  }
  // Keep following only while the beginning of the newest block stays visible.
  return Math.min(bottomScrollTop, latestBlock.element.offsetTop);
}

function hasReachedBlockClamp(target: HTMLElement, latestBlock: LatestChatBlock | null): boolean {
  if (!latestBlock) {
    return false;
  }
  return computeBottomScrollTop(target) > latestBlock.element.offsetTop;
}

function measureDistanceFromBottom(target: HTMLElement): number {
  return target.scrollHeight - target.scrollTop - target.clientHeight;
}

function applyScrollTop(target: HTMLElement, scrollTop: number, smoothEnabled: boolean) {
  if (typeof target.scrollTo === "function") {
    target.scrollTo({ top: scrollTop, behavior: smoothEnabled ? "smooth" : "auto" });
  } else {
    target.scrollTop = scrollTop;
  }
}

function shouldStickToLatestBlock(
  host: ScrollHost,
  latestBlockId: string | null,
  effectiveForce: boolean,
) {
  const canFollow = effectiveForce || host.chatUserNearBottom;
  const trackingCurrentBlock = Boolean(
    latestBlockId && host.chatAutoScrollBlockId === latestBlockId,
  );
  const suppressedCurrentBlock = Boolean(
    latestBlockId && host.chatSuppressedBlockId === latestBlockId,
  );
  return (
    effectiveForce ||
    (trackingCurrentBlock && !suppressedCurrentBlock) ||
    (!latestBlockId && canFollow)
  );
}

export function scheduleChatScroll(host: ScrollHost, force = false, smooth = false) {
  if (host.chatScrollFrame) {
    cancelAnimationFrame(host.chatScrollFrame);
  }
  if (host.chatScrollTimeout != null) {
    clearTimeout(host.chatScrollTimeout);
    host.chatScrollTimeout = null;
  }
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
      const latestBlock = pickLatestChatBlock(host);
      const latestBlockId = latestBlock?.id ?? null;

      // force=true only overrides when we haven't auto-scrolled yet (initial load).
      // After initial load, respect the user's scroll position.
      const effectiveForce = force && !host.chatHasAutoScrolled;
      const canStartFollowing = effectiveForce || host.chatUserNearBottom;
      const isNewBlock = Boolean(latestBlockId && latestBlockId !== host.chatAutoScrollBlockId);
      if (isNewBlock) {
        if (!canStartFollowing) {
          host.chatNewMessagesBelow = true;
          return;
        }
        host.chatAutoScrollBlockId = latestBlockId;
        host.chatAutoScrollMode = effectiveForce
          ? "bottom"
          : (latestBlock?.defaultMode ?? "bottom");
      }
      const shouldStick = shouldStickToLatestBlock(host, latestBlockId, effectiveForce);

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
      const scrollTop =
        effectiveForce && !latestBlock
          ? computeBottomScrollTop(target)
          : computeChatScrollTop(target, latestBlock, host.chatAutoScrollMode);
      applyScrollTop(target, scrollTop, smoothEnabled);
      if (
        !effectiveForce &&
        latestBlockId &&
        host.chatAutoScrollMode === "clamp" &&
        hasReachedBlockClamp(target, latestBlock)
      ) {
        // Once the newest block grows beyond the viewport, stop auto-following that block.
        host.chatSuppressedBlockId = latestBlockId;
      }
      host.chatLastScrollTop = scrollTop;
      host.chatUserNearBottom = measureDistanceFromBottom(target) <= BOTTOM_EPSILON;
      host.chatNewMessagesBelow = false;
      const retryDelay = effectiveForce ? 150 : 120;
      host.chatScrollTimeout = window.setTimeout(() => {
        host.chatScrollTimeout = null;
        const latest = pickScrollTarget();
        if (!latest) {
          return;
        }
        const latestBlockRetry = pickLatestChatBlock(host);
        const latestBlockRetryId = latestBlockRetry?.id ?? null;
        const shouldStickRetry = shouldStickToLatestBlock(host, latestBlockRetryId, effectiveForce);
        if (!shouldStickRetry) {
          return;
        }
        const retryScrollTop =
          effectiveForce && !latestBlockRetry
            ? computeBottomScrollTop(latest)
            : computeChatScrollTop(latest, latestBlockRetry, host.chatAutoScrollMode);
        latest.scrollTop = retryScrollTop;
        if (
          !effectiveForce &&
          latestBlockRetryId &&
          host.chatAutoScrollMode === "clamp" &&
          hasReachedBlockClamp(latest, latestBlockRetry)
        ) {
          host.chatSuppressedBlockId = latestBlockRetryId;
        }
        host.chatLastScrollTop = retryScrollTop;
        host.chatUserNearBottom = measureDistanceFromBottom(latest) <= BOTTOM_EPSILON;
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
  const latestBlock = pickLatestChatBlock(host);
  const latestBlockId = latestBlock?.id ?? null;
  const previousScrollTop = host.chatLastScrollTop;
  if (
    latestBlockId &&
    previousScrollTop != null &&
    host.chatAutoScrollBlockId === latestBlockId &&
    container.scrollTop < previousScrollTop
  ) {
    host.chatSuppressedBlockId = latestBlockId;
  }
  host.chatLastScrollTop = container.scrollTop;
  const distanceFromBottom = measureDistanceFromBottom(container);
  host.chatUserNearBottom = distanceFromBottom <= BOTTOM_EPSILON;
  // Clear the "new messages below" indicator when user scrolls back to bottom.
  if (distanceFromBottom <= BOTTOM_EPSILON) {
    host.chatAutoScrollBlockId = latestBlockId;
    host.chatAutoScrollMode = "bottom";
    host.chatSuppressedBlockId = null;
    host.chatNewMessagesBelow = false;
  }
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
  host.chatLastScrollTop = null;
  host.chatAutoScrollBlockId = null;
  host.chatAutoScrollMode = "bottom";
  host.chatSuppressedBlockId = null;
  host.chatUserNearBottom = true;
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
