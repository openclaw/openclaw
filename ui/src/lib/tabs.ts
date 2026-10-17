import { createMemo, createSignal, onCleanup } from "solid-js";

type TabsActivation = "auto" | "manual";

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

export function createTabList(
  read: () => TabsOptions,
  items: () => readonly { value: string; disabled?: boolean }[],
  root: () => HTMLElement,
) {
  const nodes = new Map<string, HTMLElement>();
  // Local selection resets only when the caller changes its default.
  const [localActive, setLocalActive] = createSignal(() => read().defaultActive ?? null);
  const active = createMemo(() => (read().active === undefined ? localActive() : read().active));
  const enabled = createMemo(() =>
    items()
      .filter((item) => !item.disabled)
      .map((item) => item.value),
  );
  // Preserve keyboard focus until selection changes or the focused tab disappears.
  const [focus, setFocus] = createSignal(
    (previous?: { active: string | null | undefined; value?: string }) => {
      const selected = active();
      const values = enabled();
      return {
        active: selected,
        value:
          previous &&
          previous.active === selected &&
          previous.value !== undefined &&
          values.includes(previous.value)
            ? previous.value
            : selected != null && values.includes(selected)
              ? selected
              : values[0],
      };
    },
  );

  function select(tab: HTMLElement, event: MouseEvent | KeyboardEvent, direct: boolean) {
    const next = tab.dataset.tabValue;
    if (next === undefined || nodes.get(next) !== tab || !enabled().includes(next)) {
      return;
    }
    setFocus({ active: active(), value: next });
    if (direct && read().onActivate?.(next, tab, event) === false) {
      return;
    }
    if (next !== active() && read().onSelect?.(next, tab, event) !== false) {
      if (read().active === undefined) {
        setLocalActive(next);
      }
    }
  }

  function onClick(event: MouseEvent) {
    const tab = event.currentTarget;
    if (!event.defaultPrevented && event.button === 0 && tab instanceof HTMLElement) {
      select(tab, event, true);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    const tab = event.currentTarget;
    if (
      event.defaultPrevented ||
      !(tab instanceof HTMLElement) ||
      nodes.get(tab.dataset.tabValue ?? "") !== tab ||
      !enabled().includes(tab.dataset.tabValue ?? "") ||
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
    const rtl = getComputedStyle(root()).direction === "rtl";
    const nextKey = vertical ? "ArrowDown" : rtl ? "ArrowLeft" : "ArrowRight";
    const previousKey = vertical ? "ArrowUp" : rtl ? "ArrowRight" : "ArrowLeft";
    if (![nextKey, previousKey, "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const values = enabled();
    const current = values.indexOf(tab.dataset.tabValue ?? "");
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? values.length - 1
          : (current + (event.key === nextKey ? 1 : -1) + values.length) % values.length;
    const value = values[index];
    if (value === undefined) {
      return;
    }
    const target = nodes.get(value);
    if (!target) {
      return;
    }
    setFocus({ active: active(), value });
    if (read().activation !== "manual") {
      select(target, event, false);
    }
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  return {
    active,
    element: (value: string | null) => (value === null ? undefined : nodes.get(value)),
    tabIndex: (value: string) => (focus().value === value ? 0 : -1),
    ref(value: string) {
      onCleanup(() => nodes.delete(value));
      return (element: HTMLElement) => {
        nodes.set(value, element);
      };
    },
    onClick,
    onKeyDown,
  };
}
