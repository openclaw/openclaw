type ScrollHost = {
  updateComplete: Promise<unknown>;
  querySelector: (selectors: string) => Element | null;
  style: CSSStyleDeclaration;
  chatScrollFrame: number | null;
  chatScrollObserver: IntersectionObserver | null;
  chatHasAutoScrolled: boolean;
  chatUserNearBottom: boolean;
  chatNewMessagesBelow: boolean;
  logsScrollFrame: number | null;
  logsAtBottom: boolean;
  topbarObserver: ResizeObserver | null;
};

function pickScrollTarget(host: ScrollHost) {
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
}

function isSmoothAllowed(smooth: boolean): boolean {
  return (
    smooth &&
    (typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
}

function scrollToBottom(target: HTMLElement, smooth: boolean) {
  const top = target.scrollHeight;
  if (typeof target.scrollTo === "function") {
    target.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
  } else {
    target.scrollTop = top;
  }
}

export function initChatScrollObserver(host: ScrollHost) {
  teardownChatScrollObserver(host);
  const sentinel = host.querySelector(".chat-scroll-anchor") as HTMLElement | null;
  const container = host.querySelector(".chat-thread") as HTMLElement | null;
  if (!sentinel || !container) {
    return;
  }

  host.chatScrollObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        host.chatUserNearBottom = entry.isIntersecting;
        if (entry.isIntersecting) {
          host.chatNewMessagesBelow = false;
        }
      }
    },
    { root: container, threshold: 0 },
  );
  host.chatScrollObserver.observe(sentinel);
}

export function teardownChatScrollObserver(host: ScrollHost) {
  if (host.chatScrollObserver) {
    host.chatScrollObserver.disconnect();
    host.chatScrollObserver = null;
  }
}

export function scheduleChatScroll(host: ScrollHost, force = false, smooth = false) {
  if (host.chatScrollFrame) {
    cancelAnimationFrame(host.chatScrollFrame);
  }

  void host.updateComplete.then(() => {
    host.chatScrollFrame = requestAnimationFrame(() => {
      host.chatScrollFrame = null;
      const target = pickScrollTarget(host);
      if (!target) {
        return;
      }

      const effectiveForce = force && !host.chatHasAutoScrolled;
      const shouldStick = effectiveForce || host.chatUserNearBottom;

      if (!shouldStick) {
        host.chatNewMessagesBelow = true;
        return;
      }
      if (effectiveForce) {
        host.chatHasAutoScrolled = true;
      }
      scrollToBottom(target, isSmoothAllowed(smooth));
      host.chatUserNearBottom = true;
      host.chatNewMessagesBelow = false;
    });
  });
}

export function handleChatScroll(host: ScrollHost, _event: Event) {
  if (host.chatUserNearBottom) {
    host.chatNewMessagesBelow = false;
  }
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
