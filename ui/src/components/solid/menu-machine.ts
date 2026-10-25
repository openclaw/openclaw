import { createEffect, createMemo, createSignal, onSettled } from "solid-js";
import {
  isStaleChunkImportError,
  retryControlUiImport,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import type { Overlay } from "../overlay-lifecycle.ts";
import { containsComposed } from "../overlay-registry.ts";
import { MENU_FORM_CONTROL_SELECTOR } from "./menu-form-controls.ts";
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
  itemRef(): (element: HTMLElement) => void;
  items(): HTMLElement[];
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
  const ownsTarget = (target: HTMLElement) =>
    ![...overlay.children].some((child) => child.open && containsComposed(child.surface, target)) &&
    (options.surface === "listbox"
      ? overlay.surface.contains(target)
      : target.closest('[role="menu"]') === overlay.surface);
  const items = () =>
    [...itemNodes]
      .filter((item) => item.isConnected && ownsTarget(item))
      .toSorted((left, right) =>
        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
  const parentRuntime = createMemo(() => parent?.runtime());
  let hover: PointerEvent | undefined;
  let runtime: MenuRuntime | undefined;
  let stopRuntime: (() => void) | undefined;
  let mounted = false;
  let loading = false;
  let pending: Array<{ run: (loaded: MenuRuntime) => void; keyboard?: boolean }> = [];
  const [revision, setRevision] = createSignal(0);
  const [error, setError] = createSignal<unknown>();
  const notify = () => setRevision((value) => value + 1);
  const current = () => {
    revision();
    return runtime;
  };
  const run = (intent: (loaded: MenuRuntime) => void) => {
    if (runtime) {
      intent(runtime);
    } else if (overlay.open && loading) {
      pending.push({ run: intent });
    }
  };
  const load = async () => {
    if (!mounted || runtime || loading) {
      return;
    }
    loading = true;
    setError(undefined);
    try {
      const { createMenuRuntime } = await retryControlUiImport(() => import("./menu-runtime.ts"));
      if (!mounted) {
        return;
      }
      runtime = createMenuRuntime(
        overlay,
        direction,
        parentRuntime()?.service,
        options,
        items,
        notify,
      );
      stopRuntime = runtime.start();
      if (hover && overlay.trigger?.matches(":hover") && overlay.parent?.open) {
        runtime.trigger(parentRuntime()).onPointerMove(hover);
      }
      hover = undefined;
      // Native entry already chose focus while the module was loading. Adopt it
      // before replaying subsequent keyboard input instead of focusing twice.
      if (overlay.open && options.surface !== "listbox") {
        const focused = items().find((item) => item.matches(":focus"));
        if (focused?.dataset.value) {
          runtime.read().setHighlightedValue(focused.dataset.value);
        }
      }
      loading = false;
      notify();
      while (pending.length) {
        pending.shift()?.run(runtime);
        // Vanilla queues the transition; Home/End queue the highlight again,
        // whose store notification publishes roving focus. Drain both before replay.
        await new Promise<void>((resolve) => {
          queueMicrotask(() => queueMicrotask(resolve));
        });
      }
    } catch (reason) {
      if (!mounted) {
        return;
      }
      stopRuntime?.();
      stopRuntime = undefined;
      runtime = undefined;
      loading = false;
      pending = [];
      setError(reason);
    }
  };
  onSettled(() => {
    mounted = true;
    const stopOpen = overlay.subscribe((open) => {
      notify();
      if (open) {
        void load();
      } else {
        pending = [];
      }
    });
    if (overlay.open || parentRuntime()) {
      void load();
    }
    return () => {
      mounted = false;
      pending = [];
      stopOpen();
      stopRuntime?.();
    };
  });
  // Zag is an imperative widget; retain one live input snapshot once admitted.
  createEffect(
    () => [current(), direction(), options.items?.(), options.value?.(), parentRuntime()] as const,
    ([loaded, dir, catalog, selected, loadedParent]) => {
      if (loaded) {
        loaded.updateInputs(dir, catalog, selected);
      } else if (loadedParent) {
        void load();
      }
    },
  );
  const deferKey = (event: KeyboardEvent, target: "content" | "input" | "trigger") => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      !overlay.open ||
      !loading ||
      !(event.target instanceof HTMLElement) ||
      (target === "content" && !ownsTarget(event.target))
    ) {
      return;
    }
    const editing =
      event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (event.key === "Escape") {
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
      !(event.target.matches("input[data-search]") && ["ArrowDown", "Enter"].includes(event.key)) &&
      !(event.target instanceof HTMLButtonElement && ["ArrowDown", "ArrowUp"].includes(event.key))
    ) {
      return;
    }
    if (
      event.key === "Tab" ||
      (event.key.length !== 1 &&
        ![
          "ArrowDown",
          "ArrowUp",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
          "Enter",
          "Backspace",
        ].includes(event.key)) ||
      (editing && !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }
    const originalTarget = event.target;
    const currentTarget = event.currentTarget;
    event.preventDefault();
    event.stopPropagation();
    if (
      target === "content" &&
      options.surface !== "listbox" &&
      ["Enter", " "].includes(event.key) &&
      itemNodes.has(originalTarget) &&
      !originalTarget.hasAttribute("aria-haspopup") &&
      !pending.some((intent) => intent.keyboard)
    ) {
      // Leaf activation already has a native owner; only prior navigation needs replay.
      originalTarget.click();
      return;
    }
    pending.push({
      keyboard: true,
      run: (loaded) => {
        const replay = new KeyboardEvent(event.type, event);
        Object.defineProperties(replay, {
          target: {
            value: target === "content" ? loaded.service.scope.getActiveElement() : originalTarget,
          },
          currentTarget: { value: currentTarget },
        });
        if (target === "content") {
          loaded.content().onKeyDown(replay);
        } else if (target === "trigger") {
          loaded.trigger(parentRuntime()).onKeyDown(replay);
        } else {
          loaded.keydown(replay);
        }
      },
    });
  };
  const keydown = (event: KeyboardEvent) =>
    runtime ? runtime.keydown(event) : deferKey(event, "input");
  const setHighlightedValue = (value: string | null) =>
    run((loaded) => loaded.service.send({ type: "HIGHLIGHTED.SET", value }));
  return {
    runtime: current,
    items,
    itemRef,
    highlightedValue: () => current()?.read().highlightedValue ?? null,
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
        void load();
      }
    },
    item(value, disabled, type, checked = false, label = value) {
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
        ...current()?.item(value, disabled, type, checked, label),
        // Preserve cold entry focus without echoing machine-owned focus into its queue.
        onFocusIn: () => {
          if (runtime?.service.context.get("highlightedValue") !== value) {
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
          if (!focus) {
            overlay.trigger?.focus({ preventScroll: true });
          }
          overlay.request(parentBinding ? true : !overlay.open, focus ? "first" : "none");
        },
        onPointerMove: (event: PointerEvent) => {
          if (disabled || !parentBinding || event.pointerType !== "mouse") {
            return;
          }
          hover = new PointerEvent(event.type, event);
          Object.defineProperties(hover, {
            target: { value: event.target },
            currentTarget: { value: event.currentTarget },
          });
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
            ["ArrowDown", "ArrowUp", "Enter", " ", ...(parentBinding ? [forward] : [])].includes(
              event.key,
            )
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
