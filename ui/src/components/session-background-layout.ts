import { onSettled } from "solid-js";
import type { SessionBackgroundLayoutTarget } from "./session-background-layout-context.tsx";

/** Observe layout changes, never scrolling or animation frames. */
export function createBackgroundFadeLayout(host: HTMLElement) {
  let observer: ResizeObserver | null = null;
  let targets: Element[] = [];
  let layoutTargets: readonly SessionBackgroundLayoutTarget[] = [];
  onSettled(() => {
    observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    targets.forEach((node) => observer?.observe(node));
    return disconnect;
  });

  function findTarget(kind: SessionBackgroundLayoutTarget["kind"]) {
    let first: HTMLElement | undefined;
    for (const target of layoutTargets) {
      if (target.kind !== kind || !host.parentElement?.contains(target.element)) {
        continue;
      }
      if (
        !first ||
        first.compareDocumentPosition(target.element) & Node.DOCUMENT_POSITION_PRECEDING
      ) {
        first = target.element;
      }
    }
    return first;
  }

  function update(enabled: boolean, registered: readonly SessionBackgroundLayoutTarget[] = []) {
    layoutTargets = registered;
    if (!enabled) {
      disconnect();
      return;
    }
    const parent = host.parentElement;
    const composer = findTarget("composer");
    const welcome = findTarget("welcome");
    const next = [parent, composer, welcome].filter((node): node is HTMLElement => Boolean(node));
    if (next.length !== targets.length || next.some((node, index) => node !== targets[index])) {
      disconnect();
      targets = next;
      targets.forEach((node) => observer?.observe(node));
    }
    measure();
  }

  function measure() {
    const composer = findTarget("composer");
    const origin = host.getBoundingClientRect();
    const box = composer?.getBoundingClientRect();
    const scroll = findTarget("scroll")?.scrollTop ?? 0;
    const end = box
      ? Math.max(0, box.top - origin.top + scroll + box.height / 2)
      : origin.height * 0.55;
    const value = Math.round(end) + "px";
    if (host.style.getPropertyValue("--session-background-fade-end") !== value) {
      host.style.setProperty("--session-background-fade-end", value);
    }
  }

  function disconnect() {
    observer?.disconnect();
    targets = [];
  }
  return { update };
}
