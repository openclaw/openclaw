export type TabsActivation = "auto" | "manual";

export type TabsOptions = {
  /** Omit for local selection; null deliberately leaves every tab unselected. */
  active?: string | null;
  defaultActive?: string | null;
  activation?: TabsActivation;
  orientation?: "horizontal" | "vertical";
  onSelect?: (value: string, tab: HTMLElement, event: MouseEvent | KeyboardEvent) => boolean | void;
  /** Returning false consumes direct activation without changing selection. */
  onActivate?: (
    value: string,
    tab: HTMLElement,
    event: MouseEvent | KeyboardEvent,
  ) => boolean | void;
};

export function createTabsController(element: HTMLElement, read: () => TabsOptions) {
  let localActive = read().defaultActive ?? null;
  let defaultActive = read().defaultActive;
  let focused: HTMLElement | undefined;
  let previousActive: string | null | undefined;

  const tabs = () =>
    [...element.querySelectorAll<HTMLElement>('[role="tab"]')].filter(
      (tab) => tab.closest('[role="tablist"]') === element,
    );
  const value = (tab: HTMLElement) => tab.dataset.tabValue;
  const enabled = (tab: HTMLElement) =>
    !tab.matches(":disabled") && tab.getAttribute("aria-disabled") !== "true";
  const active = () => (read().active === undefined ? localActive : read().active);

  function sync() {
    const options = read();
    if (defaultActive !== options.defaultActive) {
      defaultActive = options.defaultActive;
      localActive = defaultActive ?? null;
    }
    const items = tabs();
    const selected = items.find((tab) => value(tab) === active());
    if (!focused || !items.includes(focused) || !enabled(focused) || previousActive !== active()) {
      focused = selected && enabled(selected) ? selected : items.find(enabled);
    }
    previousActive = active();
    element.setAttribute("aria-orientation", options.orientation ?? "horizontal");
    for (const tab of items) {
      const isSelected = tab === selected;
      tab.setAttribute("aria-selected", String(isSelected));
      tab.toggleAttribute("active", isSelected);
      tab.tabIndex = tab === focused ? 0 : -1;
    }
  }

  function select(tab: HTMLElement, event: MouseEvent | KeyboardEvent, direct: boolean) {
    const next = value(tab);
    if (next === undefined || !enabled(tab)) {
      return;
    }
    focused = tab;
    if (direct && read().onActivate?.(next, tab, event) === false) {
      sync();
      return;
    }
    if (next !== active() && read().onSelect?.(next, tab, event) !== false) {
      if (read().active === undefined) {
        localActive = next;
      }
    }
    sync();
  }

  function eventTab(event: Event) {
    if (!(event.target instanceof Element)) {
      return undefined;
    }
    const tab = event.target.closest<HTMLElement>('[role="tab"]');
    return tab?.closest('[role="tablist"]') === element ? tab : undefined;
  }

  function onClick(event: MouseEvent) {
    const tab = eventTab(event);
    if (!event.defaultPrevented && event.button === 0 && tab) {
      select(tab, event, true);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    const tab = eventTab(event);
    if (
      event.defaultPrevented ||
      !tab ||
      !enabled(tab) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!event.repeat) {
        select(tab, event, true);
      }
      return;
    }
    const vertical = read().orientation === "vertical";
    const rtl = getComputedStyle(element).direction === "rtl";
    const nextKey = vertical ? "ArrowDown" : rtl ? "ArrowLeft" : "ArrowRight";
    const previousKey = vertical ? "ArrowUp" : rtl ? "ArrowRight" : "ArrowLeft";
    if (![nextKey, previousKey, "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const items = tabs().filter(enabled);
    const current = items.indexOf(tab);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === nextKey ? 1 : -1) + items.length) % items.length;
    const target = items[index];
    if (!target) {
      return;
    }
    focused = target;
    if (read().activation !== "manual") {
      select(target, event, false);
    } else {
      sync();
    }
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  element.addEventListener("click", onClick);
  element.addEventListener("keydown", onKeyDown);
  sync();
  return {
    sync,
    dispose() {
      element.removeEventListener("click", onClick);
      element.removeEventListener("keydown", onKeyDown);
    },
  };
}
