export function observeMobileSheetScrollFades(shell: HTMLElement): () => void {
  // Scroll boundaries belong to the host. These overlays never mask a scrollbar,
  // header, or the independently positioned action pills.
  const layer = document.createElement("div");
  layer.className = "chat-mobile-host__scroll-fades";
  layer.setAttribute("aria-hidden", "true");
  shell.append(layer);
  const ports = new Map<HTMLElement, { top: HTMLDivElement; bottom: HTMLDivElement }>();
  const selectors =
    ".chat-details-goal__body, .chat-details, .chat-mobile-host__page, .chat-mobile-details-page__body, .chat-workspace-mobile__scroll, .chat-panel-launcher-mobile, .chat-subagents-mobile, .chat-processes__list, .chat-processes__output, .session-diff-mobile__scroll, .session-automation-mobile__task, .sidebar-file-view .cm-scroller, .sidebar-file-view__markdown-scroll, .sidebar-file-view__markdown, .lr-content, .lr-diff, .chat-thread, .chat-thread-viewport";
  let frame = 0;
  const surface = (port: HTMLElement) => {
    let node: HTMLElement | null = port;
    while (node && node !== shell.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
        return color;
      }
      node = node.parentElement;
    }
    return getComputedStyle(shell).backgroundColor;
  };
  const paint = () => {
    frame = 0;
    const hostBounds = shell.getBoundingClientRect();
    for (const [port, edges] of ports) {
      const visible =
        port.isConnected && port.clientHeight > 0 && port.scrollHeight > port.clientHeight + 1;
      const style = getComputedStyle(port);
      const scrollable = visible && /auto|scroll/.test(style.overflowY);
      edges.top.hidden = !scrollable || port.scrollTop <= 1;
      edges.bottom.hidden =
        !scrollable || port.scrollTop + port.clientHeight >= port.scrollHeight - 1;
      if (!scrollable) {
        continue;
      }
      const bounds = port.getBoundingClientRect();
      const color = surface(port);
      const left = bounds.left - hostBounds.left + port.clientLeft;
      const top = bounds.top - hostBounds.top + port.clientTop;
      for (const edge of [edges.top, edges.bottom]) {
        edge.style.left = `${left}px`;
        edge.style.width = `${port.clientWidth}px`;
        edge.style.setProperty("--mobile-fade-surface", color);
      }
      edges.top.style.top = `${top}px`;
      edges.bottom.style.top = `${top + port.clientHeight - 10}px`;
    }
  };
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(paint);
    }
  };
  const resizeObserver = new ResizeObserver(schedule);
  const discover = () => {
    for (const [port, edges] of ports) {
      if (!port.isConnected) {
        resizeObserver.unobserve(port);
        edges.top.remove();
        edges.bottom.remove();
        ports.delete(port);
      }
    }
    shell.querySelectorAll<HTMLElement>(selectors).forEach((port) => {
      if (ports.has(port)) {
        return;
      }
      const top = document.createElement("div");
      const bottom = document.createElement("div");
      top.className = "chat-mobile-host__scroll-edge chat-mobile-host__scroll-edge--top";
      bottom.className = "chat-mobile-host__scroll-edge chat-mobile-host__scroll-edge--bottom";
      layer.append(top, bottom);
      ports.set(port, { top, bottom });
      resizeObserver.observe(port);
    });
    schedule();
  };
  const mutations = new MutationObserver((records) => {
    if (records.some((record) => !layer.contains(record.target) && record.target !== layer)) {
      discover();
    }
  });
  mutations.observe(shell, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden"],
  });
  shell.addEventListener("scroll", schedule, { capture: true, passive: true });
  shell.addEventListener("load", schedule, true);
  resizeObserver.observe(shell);
  discover();
  return () => {
    cancelAnimationFrame(frame);
    mutations.disconnect();
    resizeObserver.disconnect();
    shell.removeEventListener("scroll", schedule, true);
    shell.removeEventListener("load", schedule, true);
    layer.remove();
  };
}
