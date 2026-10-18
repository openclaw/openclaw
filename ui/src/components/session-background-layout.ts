import { onCleanup } from "solid-js";

/** Observe layout changes, never scrolling or animation frames. */
export function createBackgroundFadeLayout(host: HTMLElement) {
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
  let targets: Element[] = [];

  function update(enabled: boolean) {
    if (!enabled) {
      disconnect();
      return;
    }
    const parent = host.parentElement;
    const composer = parent?.querySelector<HTMLElement>(".agent-chat__input");
    const welcome = parent?.querySelector<HTMLElement>(".agent-chat__welcome");
    const next = [parent, composer, welcome].filter((node): node is HTMLElement => Boolean(node));
    if (next.length !== targets.length || next.some((node, index) => node !== targets[index])) {
      disconnect();
      targets = next;
      targets.forEach((node) => observer?.observe(node));
    }
    measure();
  }

  function measure() {
    const parent = host.parentElement;
    const composer = parent?.querySelector<HTMLElement>(".agent-chat__input");
    const origin = host.getBoundingClientRect();
    const box = composer?.getBoundingClientRect();
    const scroll = parent?.querySelector<HTMLElement>(".new-session-page__scroll")?.scrollTop ?? 0;
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
  onCleanup(disconnect);
  return { update };
}
