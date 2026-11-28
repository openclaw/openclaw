import { createEffect, createMemo, createSignal, onSettled } from "solid-js";
import {
  isStaleChunkImportError,
  retryControlUiImport,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { focusProgrammatically } from "../../lib/programmatic-focus.ts";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import type { Overlay } from "../overlay-lifecycle.ts";
import {
  compareMenuElements,
  MENU_FORM_CONTROL_SELECTOR,
  ownsMenuTarget,
} from "./menu-form-controls.ts";
import type { MenuKeySource, PendingMenuHover, PendingMenuIntent } from "./menu-navigation.ts";
import type { MenuNavigationOptions, MenuRuntime } from "./menu-runtime.ts";

export type { MenuNavigationOptions } from "./menu-runtime.ts";

export type MenuControls = {
  readonly elements: ReadonlySet<HTMLElement>;
  ref(this: void): (element: HTMLElement) => void;
};

/** One tree's controls or items, registered by their rendering owners. */
export function createMenuControls(): MenuControls {
  const elements = new Set<HTMLElement>();
  return {
    elements,
    ref() {
      return elementRef((element: HTMLElement) => {
        elements.add(element);
        return () => elements.delete(element);
      });
    },
  };
}

export type MenuBinding = {
  isOpen(): boolean;
  itemRef(): (element: HTMLElement) => void;
  items(ordered?: boolean): HTMLElement[];
  highlightedValue(): string | null;
  highlightedValueNow(): string | null;
  setHighlightedValue(value: string | null): void;
  typeahead(key: string): void;
  itemId(value: string): string;
  item(
    value: string,
    disabled?: boolean,
    type?: "checkbox" | "radio",
    checked?: boolean,
    label?: string,
  ): Record<string, unknown>;
  trigger(parentBinding?: MenuBinding, disabled?: boolean): Record<string, unknown>;
  content(): Record<string, unknown> & { onKeyDown(event: KeyboardEvent): void };
  keydown(event: KeyboardEvent): void;
  error(): unknown;
  retry(): void;
  /** Nested menus share the loaded navigation runtime, never its loading state. */
  runtime(): MenuRuntime | undefined;
};

/** Native admission, DOM identity, and activation remain available before navigation loads. */
export function useMenuMachine(
  overlay: Overlay,
  direction: () => "ltr" | "rtl",
  onSelect: (value: string) => void,
  parent?: MenuBinding,
  options: MenuNavigationOptions = {},
): MenuBinding {
  const { elements: itemNodes, ref: itemRef } = createMenuControls();
  const items = (ordered = true) => {
    const connected = [...itemNodes].filter(
      (item) => item.isConnected && ownsMenuTarget(overlay, item, options.surface),
    );
    return ordered ? connected.toSorted(compareMenuElements) : connected;
  };
  const parentRuntime = createMemo(() => parent?.runtime());
  let hover: PendingMenuHover | undefined;
  let runtime: MenuRuntime | undefined;
  let virtualized = false;
  let stopRuntime: (() => void) | undefined;
  let mounted = false;
  let loading = false;
  const pending: PendingMenuIntent[] = [];
  const [revision, setRevision] = createSignal(0);
  const [error, setError] = createSignal<unknown>();
  const notify = () => setRevision((value) => value + 1);
  const current = () => {
    revision();
    return runtime;
  };
  // Highlights refresh presentation without resynchronizing unchanged widget inputs.
  const inputRuntime = createMemo(current);
  // Rows share one rendered snapshot; imperative navigation still reads the live machine.
  const presentation = createMemo(
    () => {
      const loaded = current();
      return loaded ? { runtime: loaded, api: loaded.read() } : undefined;
    },
    { lazy: true },
  );
  const awaitingRuntime = () => loading || (parent && !parentRuntime() && !parent.error());
  const run = (intent: (loaded: MenuRuntime) => void, highlightedValue?: string | null) => {
    if (runtime) {
      intent(runtime);
    } else if (overlay.open && awaitingRuntime()) {
      pending.push({ run: intent, highlightedValue });
    }
  };
  const load = async (loadedParent?: MenuRuntime) => {
    // A submenu may already be visible, but its Zag machine must start with its parent.
    if (!mounted || runtime || loading || (parent && !loadedParent)) {
      return;
    }
    loading = true;
    setError(undefined);
    try {
      const { createMenuRuntime, adoptNativeMenuInput, replayMenuIntents } =
        await retryControlUiImport(() => import("./menu-navigation.ts"));
      if (!mounted) {
        return;
      }
      runtime = createMenuRuntime(
        overlay,
        direction,
        loadedParent?.service,
        { ...options, virtualized: () => virtualized },
        items,
        notify,
        onSelect,
      );
      stopRuntime = runtime.start();
      adoptNativeMenuInput(runtime, overlay, options.surface, items, hover, parentRuntime);
      hover = undefined;
      loading = false;
      notify();
      await replayMenuIntents(pending, runtime, parentRuntime);
    } catch (reason) {
      if (!mounted) {
        return;
      }
      stopRuntime?.();
      stopRuntime = undefined;
      runtime = undefined;
      loading = false;
      pending.length = 0;
      setError(reason);
      notify();
    }
  };
  onSettled(() => {
    mounted = true;
    const stopOpen = overlay.subscribe((open) => {
      notify();
      if (!open) {
        pending.length = 0;
      } else if (!parent) {
        void load();
      }
    });
    const loadedParent = parentRuntime();
    if (overlay.open || loadedParent) {
      void load(loadedParent);
    }
    return () => {
      mounted = false;
      pending.length = 0;
      stopOpen();
      stopRuntime?.();
    };
  });
  // Zag is an imperative widget; retain one live input snapshot once admitted.
  createEffect(
    () =>
      [
        inputRuntime(),
        direction(),
        options.items?.(),
        options.value?.(),
        options.virtualized?.() ?? false,
        parentRuntime(),
      ] as const,
    ([loaded, dir, catalog, selected, nextVirtualized, loadedParent]) => {
      virtualized = nextVirtualized;
      if (loaded) {
        loaded.updateInputs(dir, catalog, selected);
      } else if (loadedParent) {
        void load(loadedParent);
      }
    },
  );
  const deferKey = (event: KeyboardEvent, target: MenuKeySource) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      !overlay.open ||
      !awaitingRuntime() ||
      !(event.target instanceof HTMLElement) ||
      (target === "content" && !ownsMenuTarget(overlay, event.target, options.surface))
    ) {
      return;
    }
    const { key } = event;
    const editing =
      event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (key === "Escape") {
      // A child can retain focus on its parent trigger before navigation loads, too.
      if (![...overlay.children].some((child) => child.open)) {
        overlay.keydown(event);
      }
      return;
    }
    if (
      target === "content" &&
      options.surface !== "listbox" &&
      event.target.matches(MENU_FORM_CONTROL_SELECTOR) &&
      !(event.target.matches("input[data-search]") && ["ArrowDown", "Enter"].includes(key)) &&
      !(event.target instanceof HTMLButtonElement && ["ArrowDown", "ArrowUp"].includes(key))
    ) {
      return;
    }
    if (
      (key.length !== 1 &&
        ![
          "ArrowDown",
          "ArrowUp",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
          "Enter",
          "Backspace",
        ].includes(key)) ||
      (editing && !["ArrowDown", "ArrowUp", "Enter"].includes(key)) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }
    const originalTarget = event.target;
    event.preventDefault();
    event.stopPropagation();
    if (
      target === "content" &&
      options.surface !== "listbox" &&
      !pending.some((intent) => "event" in intent)
    ) {
      // Close the visible branch before the next Escape chooses its deepest owner.
      if (parent && key === (direction() === "rtl" ? "ArrowRight" : "ArrowLeft")) {
        overlay.request(false, "return");
        return;
      }
      if (
        ["Enter", " "].includes(key) &&
        itemNodes.has(originalTarget) &&
        !originalTarget.hasAttribute("aria-haspopup")
      ) {
        originalTarget.click();
        return;
      }
    }
    pending.push({ event, source: target, originalTarget, currentTarget: event.currentTarget });
  };
  const keydown = (event: KeyboardEvent) =>
    runtime ? runtime.keydown(event) : deferKey(event, "input");
  const setHighlightedValue = (value: string | null) =>
    run((loaded) => loaded.service.send({ type: "HIGHLIGHTED.SET", value }), value);
  return {
    isOpen: () => {
      revision();
      return overlay.open;
    },
    runtime: current,
    items,
    itemRef,
    highlightedValue: () => presentation()?.api.highlightedValue ?? null,
    highlightedValueNow: () => runtime?.service.context.get("highlightedValue") ?? null,
    setHighlightedValue,
    typeahead: (key) => run((loaded) => loaded.service.send({ type: "TYPEAHEAD", key })),
    itemId: (value) => `${overlay.id}:${value}`,
    keydown,
    error,
    retry: () => {
      if (isStaleChunkImportError(error())) {
        void retryStaleChunkReloadWhenReachable({ canReload: () => mounted && overlay.open });
      } else {
        void load(parentRuntime());
      }
    },
    item(value, disabled, type, checked = false, label = value) {
      const rendered = presentation();
      return {
        id: `${overlay.id}:${value}`,
        "data-scope": "menu",
        "data-part": "item",
        "data-ownedby": overlay.id,
        "data-menu-item": overlay.id,
        "data-disabled": disabled ? "" : undefined,
        "data-value": value,
        "data-valuetext": label,
        tabIndex: -1,
        ...rendered?.runtime.item(rendered.api, value, disabled, type, checked, label),
        // A repeated cold focus must not replay an old highlight after queued keys.
        // Keep distinct focus changes ordered, including entry focus before returning to the trigger.
        onFocusIn: () => {
          const highlighted = runtime
            ? runtime.service.context.get("highlightedValue")
            : pending.findLast((intent) => intent.highlightedValue !== undefined)?.highlightedValue;
          if (highlighted !== value) {
            setHighlightedValue(value);
          }
        },
        onClick: (event: MouseEvent) => {
          if (disabled || !overlay.open) {
            event.preventDefault();
            return;
          }
          const anchor = event.currentTarget;
          if (anchor instanceof HTMLAnchorElement) {
            if (
              !shouldHandleNavigationClick(event) ||
              (anchor.target !== "" && anchor.target !== "_self") ||
              anchor.hasAttribute("download")
            ) {
              return;
            }
            event.preventDefault();
          }
          onSelect(value);
        },
        onContextMenu: (event: MouseEvent) => {
          if (event.currentTarget instanceof HTMLAnchorElement) {
            event.stopPropagation();
          }
        },
      };
    },
    trigger(parentBinding, disabled = false) {
      const loaded = current();
      if (loaded) {
        return loaded.trigger(parentBinding?.runtime(), disabled);
      }
      return {
        "data-scope": "menu",
        "data-part": parentBinding ? "trigger-item" : "trigger",
        "data-menu-item": parentBinding ? overlay.parent?.id : undefined,
        "data-state": overlay.open ? "open" : "closed",
        "aria-disabled": disabled ? "true" : undefined,
        "data-disabled": disabled ? "" : undefined,
        onPointerDown: (event: PointerEvent) => {
          if (
            disabled ||
            event.button === 2 ||
            (event.button === 0 && event.ctrlKey && /^Mac/i.test(navigator.platform))
          ) {
            return;
          }
          // Match Zag: focus can settle an animated ancestor and move the trigger before pointerup.
          event.preventDefault();
        },
        onClick: (event: MouseEvent) => {
          if (disabled || event.defaultPrevented) {
            return;
          }
          const focus = event.detail === 0 || options.pointerFocus?.() !== "trigger";
          if (!focus && overlay.trigger) {
            focusProgrammatically(overlay.trigger, { preventScroll: true });
          }
          overlay.request(parentBinding ? true : !overlay.open, focus ? "first" : "none");
        },
        onPointerMove: (event: PointerEvent) => {
          if (disabled || !parentBinding || event.pointerType !== "mouse") {
            return;
          }
          hover = { event, originalTarget: event.target, currentTarget: event.currentTarget };
        },
        onPointerLeave: () => {
          hover = undefined;
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (disabled || event.defaultPrevented || event.isComposing) {
            return;
          }
          if (parentBinding && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            return;
          }
          if (overlay.open) {
            deferKey(event, "trigger");
            return;
          }
          const forward = direction() === "rtl" ? "ArrowLeft" : "ArrowRight";
          if (
            ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key) ||
            (parentBinding && event.key === forward)
          ) {
            event.preventDefault();
            overlay.request(true, event.key === "ArrowUp" ? "last" : "first");
          }
        },
      };
    },
    content() {
      return {
        id: options.ids?.content ?? `${overlay.id}:content`,
        "data-scope": "menu",
        "data-part": "content",
        "data-state": overlay.open ? "open" : "closed",
        "aria-labelledby": options.ids?.trigger ?? `${overlay.id}:trigger`,
        tabIndex: -1,
        ...current()?.content(),
        onKeyDown: (event: KeyboardEvent) =>
          runtime ? runtime.content().onKeyDown(event) : deferKey(event, "content"),
      };
    },
  };
}
