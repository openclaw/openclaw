import { listen } from "../../lib/reactive/listener.ts";
import type { MobileSheetScrollFadeConnection } from "./chat-mobile-scroll-fades.ts";

export function createMobileSheetScrollFadeConnection(
  ports: ReadonlySet<HTMLElement>,
  shell: HTMLElement,
): MobileSheetScrollFadeConnection {
  // Scroll boundaries belong to the host. These overlays never mask a scrollbar,
  // header, or the independently positioned action pills.
  const layer = document.createElement("div");
  layer.className = "chat-mobile-host__scroll-fades";
  layer.setAttribute("aria-hidden", "true");
  shell.append(layer);
  const edges = new Map<HTMLElement, { top: HTMLDivElement; bottom: HTMLDivElement }>();
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
  const remove = (port: HTMLElement) => {
    const pair = edges.get(port);
    if (pair) {
      resizeObserver.unobserve(port);
      pair.top.remove();
      pair.bottom.remove();
      edges.delete(port);
    }
  };
  const paint = () => {
    frame = 0;
    const active = [...ports]
      .filter((port) => port.isConnected && shell.contains(port))
      .toSorted((left, right) =>
        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
    for (const port of edges.keys()) {
      if (!active.includes(port)) {
        remove(port);
      }
    }
    const hostBounds = shell.getBoundingClientRect();
    let next = layer.firstChild;
    for (const port of active) {
      let pair = edges.get(port);
      if (!pair) {
        const top = document.createElement("div");
        const bottom = document.createElement("div");
        top.className = "chat-mobile-host__scroll-edge chat-mobile-host__scroll-edge--top";
        bottom.className = "chat-mobile-host__scroll-edge chat-mobile-host__scroll-edge--bottom";
        pair = { top, bottom };
        edges.set(port, pair);
        resizeObserver.observe(port);
      }
      // Ref order differs from document order for nested and lazily mounted ports.
      for (const edge of [pair.top, pair.bottom]) {
        if (edge === next) {
          next = next.nextSibling;
        } else {
          layer.insertBefore(edge, next);
        }
      }
      const visible = port.clientHeight > 0 && port.scrollHeight > port.clientHeight + 1;
      const style = getComputedStyle(port);
      const scrollable = visible && /auto|scroll/.test(style.overflowY);
      pair.top.hidden = !scrollable || port.scrollTop <= 1;
      pair.bottom.hidden =
        !scrollable || port.scrollTop + port.clientHeight >= port.scrollHeight - 1;
      if (!scrollable) {
        continue;
      }
      const bounds = port.getBoundingClientRect();
      const color = surface(port);
      const left = bounds.left - hostBounds.left + port.clientLeft;
      const top = bounds.top - hostBounds.top + port.clientTop;
      for (const edge of [pair.top, pair.bottom]) {
        edge.style.left = String(left) + "px";
        edge.style.width = String(port.clientWidth) + "px";
        edge.style.setProperty("--mobile-fade-surface", color);
      }
      pair.top.style.top = String(top) + "px";
      pair.bottom.style.top = String(top + port.clientHeight - 10) + "px";
    }
  };
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(paint);
    }
  };
  const resizeObserver = new ResizeObserver(schedule);
  const mutations = new MutationObserver((records) => {
    if (records.some((record) => !layer.contains(record.target) && record.target !== layer)) {
      schedule();
    }
  });
  mutations.observe(shell, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden"],
  });
  const stopScroll = listen(shell, "scroll", schedule, { capture: true, passive: true });
  const stopLoad = listen(shell, "load", schedule, true);
  resizeObserver.observe(shell);
  const current = {
    schedule,
    remove,
    dispose(this: void) {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resizeObserver.disconnect();
      stopScroll();
      stopLoad();
      layer.remove();
    },
  };
  return current;
}
