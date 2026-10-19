import { createMemo, createSignal, onCleanup } from "solid-js";
import { createPendingFocus } from "./reactive/pending-focus.ts";

type TabsActivation = "auto" | "manual";

export function activeElementFor(element: Element): Element | null {
  const root = element.getRootNode();
  return root instanceof ShadowRoot
    ? (root.activeElement ?? document.activeElement)
    : document.activeElement;
}

function focusNeedsRecovery(element: Element): boolean {
  const current = activeElementFor(element);
  const root = element.getRootNode();
  return (
    current === document.body ||
    current === document.documentElement ||
    (root instanceof ShadowRoot && current === root.host)
  );
}

type TabFocusTarget = {
  root: HTMLElement;
  element: (value: string | null) => HTMLElement | undefined;
  active: () => string | null | undefined;
};

/** The panel keeps this handle when its tab strip is replaced during an async close. */
export function createTabFocus() {
  let current: TabFocusTarget | undefined;
  return {
    attach(target: TabFocusTarget) {
      current = target;
      return () => {
        if (current === target) {
          current = undefined;
        }
      };
    },
    focusActive(this: void, options?: FocusOptions) {
      current?.element(current.active() ?? null)?.focus(options);
    },
    restoreAfterClose(closedId: string) {
      if (!current?.root.isConnected || current.element(closedId)) {
        return;
      }
      const selected = current.element(current.active() ?? null);
      if (selected && focusNeedsRecovery(selected)) {
        selected.focus({ preventScroll: true });
      }
    },
  };
}

export type TabFocus = ReturnType<typeof createTabFocus>;

export type TabsOptions = {
  /** Null deliberately leaves every tab unselected. */
  active: string | null;
  activation?: TabsActivation;
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
  options: { revealActive?: boolean } = {},
) {
  const nodes = new Map<string, HTMLElement>();
  const active = createMemo(() => read().active);
  const enabled = createMemo(() =>
    items()
      .filter((item) => !item.disabled)
      .map((item) => item.value),
  );
  // Preserve keyboard focus until selection changes or the focused tab disappears.
  const [focus, setFocus] = createSignal((previous?: { active: string | null; value?: string }) => {
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
  });

  if (options.revealActive) {
    const layoutKey = createMemo(() =>
      JSON.stringify([active(), items().map((item) => item.value)]),
    );
    createPendingFocus(
      () => {
        const key = layoutKey();
        let focused = document.activeElement;
        while (focused instanceof HTMLElement && focused.shadowRoot?.activeElement) {
          focused = focused.shadowRoot.activeElement;
        }
        return { key, focused };
      },
      {
        requested: () => true,
        focus: ({ focused }) => {
          queueMicrotask(() => {
            const selected = nodes.get(active() ?? "");
            if (!root().isConnected || !selected) {
              return;
            }
            selected.scrollIntoView?.({ block: "nearest", inline: "nearest" });
            // Keyed movement may blur a retained node; newer user focus always wins.
            if (focused === selected && focusNeedsRecovery(selected)) {
              selected.focus({ preventScroll: true });
            }
          });
        },
      },
    );
  }

  function select(tab: HTMLElement, event: MouseEvent | KeyboardEvent, direct: boolean) {
    const next = tab.dataset.tabValue;
    if (next === undefined || nodes.get(next) !== tab || !enabled().includes(next)) {
      return;
    }
    setFocus({ active: active(), value: next });
    if (direct && read().onActivate?.(next, tab, event) === false) {
      return;
    }
    if (next !== active()) {
      read().onSelect?.(next, tab, event);
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
    const rtl = getComputedStyle(root()).direction === "rtl";
    const nextKey = rtl ? "ArrowLeft" : "ArrowRight";
    const previousKey = rtl ? "ArrowRight" : "ArrowLeft";
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
