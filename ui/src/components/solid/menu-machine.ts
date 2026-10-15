import {
  machine,
  connect,
  type Props as MenuProps,
  type Service as MenuService,
  type Api,
} from "@zag-js/menu";
import { isPointInPolygon } from "@zag-js/rect-utils";
import { VanillaMachine, normalizeProps } from "@zag-js/vanilla";
import { createEffect, createSignal, onSettled, untrack } from "solid-js";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type { Overlay } from "../overlay-lifecycle.ts";
import { containsComposed } from "../overlay-registry.ts";

// Focus events use bubbling DOM names; all other listener names stay canonical.
const normalize = (props: object) => {
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(props));
  for (const [from, to] of [
    ["onFocus", "onFocusIn"],
    ["onBlur", "onFocusOut"],
  ] as const) {
    if (from in out) {
      out[to] = out[from];
      delete out[from];
    }
  }
  return out;
};
const normalizer: Parameters<typeof connect>[1] = {
  element: normalize,
  button: normalize,
  input: normalize,
  label: normalize,
  circle: normalize,
  img: normalize,
  output: normalize,
  path: normalize,
  select: normalize,
  svg: normalize,
  textarea: normalize,
  rect: normalize,
  style: normalizeProps.style,
};
export type MenuBinding = {
  service: MenuService;
  read(): Api;
  pointerDelta(x: number): number;
  item(
    value: string,
    disabled?: boolean,
    type?: "checkbox" | "radio",
    checked?: boolean,
    label?: string,
  ): Record<string, unknown>;
  trigger(parentBinding?: MenuBinding, disabled?: boolean): Record<string, unknown>;
  content(): Record<string, unknown>;
  keydown(event: KeyboardEvent): void;
};

export type MenuNavigationOptions = {
  ids?: MenuProps["ids"];
  surface?: "menu" | "listbox";
  /** Searchable lists keep focus in their input while Zag moves the highlight. */
  focus?: "item" | "retain";
  pointerFocus?: () => "menu" | "trigger";
  items?: () => readonly { value: string; disabled?: boolean }[];
  value?: () => string | null;
};

export function useMenuMachine(
  overlay: Overlay,
  direction: () => "ltr" | "rtl",
  onSelect: (value: string) => void,
  parent?: MenuService,
  options: MenuNavigationOptions = {},
): MenuBinding {
  let lastPointerX: number | undefined;
  let focusFromKeyboard = false;
  const ownsTarget = (target: HTMLElement) =>
    options.surface === "listbox"
      ? overlay.surface.contains(target)
      : target.closest('[role="menu"]') === overlay.surface;
  const focusItem = (service: MenuService) => {
    if (!overlay.open) {
      return;
    }
    const id = service.computed("highlightedId");
    const node = id ? service.scope.getById(id) : undefined;
    const active = service.scope.getActiveElement();
    if (
      active instanceof HTMLElement &&
      active.matches("input, textarea, select") &&
      !focusFromKeyboard
    ) {
      return;
    }
    for (const item of overlay.surface.querySelectorAll<HTMLElement>("[data-menu-item]")) {
      if (ownsTarget(item)) {
        item.tabIndex = options.focus !== "retain" && item === node ? 0 : -1;
      }
    }
    if (
      node &&
      options.focus !== "retain" &&
      focusFromKeyboard &&
      ![...overlay.children].some((child) => child.open && containsComposed(child.surface, active))
    ) {
      node.focus({ preventScroll: true });
      node.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };
  // SAFETY: The pinned menu machine defines its complete computed map.
  const computed = machine.computed!;
  const adapted: typeof machine = {
    ...machine,
    // The overlay subscription below owns controlled visibility. Keep the
    // remaining Zag watchers without dispatching each open change twice.
    watch({ track, action, context }) {
      track([() => context.get("isSubmenu")], () => action(["setSubmenuPlacement"]));
      track([() => context.hash("anchorPoint")], () => {
        if (context.get("anchorPoint")) {
          action(["reposition"]);
        }
      });
    },
    computed: {
      ...computed,
      highlightedId(params) {
        const value = params.context.get("highlightedValue");
        return options.surface === "listbox"
          ? value == null
            ? null
            : `${params.scope.id}:${value}`
          : // Submenu triggers keep the caller's logical value and their own DOM id.
            ((value == null
              ? null
              : params.scope.query(
                  `[data-menu-item="${CSS.escape(overlay.id)}"][data-value="${CSS.escape(value)}"]`,
                )?.id) ?? computed.highlightedId(params));
      },
    },
    implementations: {
      ...machine.implementations,
      effects: {
        ...machine.implementations?.effects,
        // The native host owns geometry and dismissal, so no Floating UI or duplicate listeners.
        trackPositioning() {},
        trackInteractOutside() {},
        scrollToHighlightedItem() {},
        // A fixed 100 ms close defeats slow diagonal travel inside the safe polygon.
        // Pointer movement and MENU_POINTERENTER already settle this live branch.
        waitForCloseDelay() {},
      },
      actions: {
        ...machine.implementations?.actions,
        highlightFirstItem(params) {
          // Keep Zag's queued opening focus aligned with the overlay's initial row.
          if (options.surface !== "listbox" && params.event.type !== "HOME") {
            const initial = [
              ...overlay.surface.querySelectorAll<HTMLElement>(
                "[data-initial-focus][data-menu-item]",
              ),
            ].find(
              (item) =>
                ownsTarget(item) &&
                !item.matches(":disabled") &&
                item.getAttribute("aria-disabled") !== "true",
            );
            if (initial) {
              params.context.set("highlightedValue", initial.getAttribute("data-value"));
              return;
            }
          }
          machine.implementations?.actions?.highlightFirstItem?.(params);
        },
        setHighlightedItem(params) {
          if (options.surface === "listbox") {
            const target = params.event.target;
            params.context.set(
              "highlightedValue",
              params.event.value ??
                (target instanceof HTMLElement ? target.dataset.value : null) ??
                null,
            );
          } else {
            machine.implementations?.actions?.setHighlightedItem?.(params);
          }
        },
        // Zag treats an empty value as no active item. Its DOM navigation also
        // accepts an item ID, so preserve the valid empty choice by using its ID.
        highlightNextItem(params) {
          if (options.surface === "listbox" && params.context.get("highlightedValue") === "") {
            params.context.set("highlightedValue", `${params.scope.id}:`);
          }
          machine.implementations?.actions?.highlightNextItem?.(params);
        },
        highlightPrevItem(params) {
          if (options.surface === "listbox" && params.context.get("highlightedValue") === "") {
            params.context.set("highlightedValue", `${params.scope.id}:`);
          }
          machine.implementations?.actions?.highlightPrevItem?.(params);
        },
        reposition() {},
        focusTrigger() {},
        focusMenu() {},
        focusParentMenu() {},
        setIntentPolygon(params) {
          const trigger = overlay.trigger;
          if (!trigger) {
            return;
          }
          // Geometry reads serve pointer intent only; CSS owns every placement write.
          const box = overlay.surface.getBoundingClientRect();
          const anchor = trigger.getBoundingClientRect();
          params.context.set("currentPlacement", box.x < anchor.x ? "left-start" : "right-start");
          machine.implementations?.actions?.setIntentPolygon?.(params);
        },
      },
    },
  };
  const props: MenuProps = {
    id: overlay.id,
    ids: options.ids,
    getRootNode: () => {
      // The connector reads initial props before the DOM refs are bound.
      const surface = overlay.surface;
      const root = surface?.getRootNode();
      return root instanceof ShadowRoot ? root : (surface?.ownerDocument ?? document);
    },
    dir: untrack(direction),
    open: false,
    loopFocus: true,
    closeOnSelect: false,
    "aria-label": overlay.id,
    onOpenChange({ open }) {
      const restore = !open && containsComposed(overlay.surface, service.scope.getActiveElement());
      // Native sibling dismissal must not leave focus behind in the retired branch.
      const handoff =
        open &&
        [...(overlay.parent?.children ?? [])].some(
          (sibling) => sibling !== overlay && sibling.open && sibling.containsFocus(),
        );
      if (
        !overlay.request(
          open,
          open && (focusFromKeyboard || handoff) ? "first" : restore ? "return" : "none",
        )
      ) {
        service.send({ type: overlay.open ? "CONTROLLED.OPEN" : "CONTROLLED.CLOSE" });
      }
    },
    onSelect: ({ value }) => onSelect(value),
    // Zag's default link click is not cancelable; native click keeps selection vetoable.
    navigate: ({ node }) => queueMicrotask(() => node.click()),
  };
  // Keep one current input snapshot. Vanilla updateProps retains every prior
  // source, making each subsequent prop read replay the whole update history.
  const service = new VanillaMachine(adapted, () => props);
  const [revision, setRevision] = createSignal(0);
  createEffect(direction, (dir) => {
    if (props.dir !== dir) {
      props.dir = dir;
      setRevision((n) => n + 1);
    }
  });
  const read = () => {
    revision();
    return connect(service.service, normalizer);
  };
  onSettled(() => {
    const unsubscribe = service.subscribe((state) => {
      setRevision((n) => n + 1);
      focusItem(state);
    });
    const stopOpen = overlay.subscribe((open) => {
      props.dir = untrack(direction);
      props.open = open;
      // Deliver the same controlled transition as the menu open-prop watcher,
      // preserving the event that selected keyboard opening/closing behavior.
      service.send({
        type: open ? "CONTROLLED.OPEN" : "CONTROLLED.CLOSE",
        previousEvent: service.service.event,
      });
      if (open && options.items) {
        untrack(() => {
          const enabled = options.items!().filter((item) => !item.disabled);
          service.send({
            type: "HIGHLIGHTED.SET",
            value:
              enabled.find((item) => item.value === options.value?.())?.value ??
              enabled[0]?.value ??
              null,
          });
        });
      }
    });
    service.start();
    if (parent) {
      read().setParent(parent);
      connect(parent, normalizer).setChild(service.service);
    }
    return () => {
      unsubscribe();
      stopOpen();
      service.stop();
      if (parent) {
        const children = { ...parent.refs.get("children") };
        delete children[overlay.id];
        parent.refs.set("children", children);
      }
    };
  });
  createEffect(
    () => [options.items?.(), read().highlightedValue, options.value?.()] as const,
    ([items, _highlighted, selected]) => {
      if (!items) {
        return;
      }
      const enabled = items.filter((item) => !item.disabled);
      const api = untrack(read);
      if (!enabled.some((item) => item.value === api.highlightedValue)) {
        const next =
          enabled.find((item) => item.value === selected)?.value ?? enabled[0]?.value ?? null;
        if (api.highlightedValue !== next) {
          // Zag queues send(); a stale catalog correction must not replace a later opening choice.
          service.service.context.set("highlightedValue", next);
        }
      }
    },
  );
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !overlay.open) {
      return;
    }
    const editing =
      event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    const type =
      event.key === "ArrowDown"
        ? "ARROW_DOWN"
        : event.key === "ArrowUp"
          ? "ARROW_UP"
          : event.key === "Home"
            ? "HOME"
            : event.key === "End"
              ? "END"
              : event.key === "Enter"
                ? "ENTER"
                : undefined;
    if (type && (!editing || !["Home", "End"].includes(event.key))) {
      focusFromKeyboard = true;
      service.send({ type });
      event.preventDefault();
      event.stopPropagation();
    } else if (!editing && event.key === "Backspace") {
      const state = service.service.refs.get("typeaheadState");
      const keys = state.keysSoFar.slice(0, -1);
      state.keysSoFar = "";
      if (keys) {
        service.send({ type: "TYPEAHEAD", key: keys });
      }
      event.preventDefault();
      event.stopPropagation();
    } else if (
      !editing &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      focusFromKeyboard = true;
      service.send({
        type:
          event.key === " " && !service.service.refs.get("typeaheadState").keysSoFar
            ? "ENTER"
            : "TYPEAHEAD",
        key: event.key,
      });
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return {
    service: service.service,
    read,
    keydown,
    pointerDelta(x) {
      const delta = lastPointerX === undefined ? 0 : x - lastPointerX;
      lastPointerX = x;
      return delta;
    },
    item(
      value: string,
      disabled = false,
      type?: "checkbox" | "radio",
      checked = false,
      label = value,
    ) {
      const api = read();
      const result = type
        ? api.getOptionItemProps({
            value,
            valueText: label,
            type,
            checked,
            disabled,
            closeOnSelect: false,
          })
        : api.getItemProps({ value, valueText: label, disabled, closeOnSelect: false });
      return {
        ...result,
        onClick: (event: MouseEvent) => {
          const anchor = event.currentTarget;
          if (anchor instanceof HTMLAnchorElement) {
            if (disabled) {
              event.preventDefault();
              return;
            }
            if (
              !shouldHandleNavigationClick(event) ||
              (anchor.target !== "" && anchor.target !== "_self") ||
              anchor.hasAttribute("download")
            ) {
              return;
            }
            // Selection is queued; prevent navigation now so its cancelable event can veto it.
            event.preventDefault();
          }
          result.onClick?.(event);
        },
        onContextMenu: (event: MouseEvent) => {
          if (event.currentTarget instanceof HTMLAnchorElement) {
            event.stopPropagation();
          }
        },
        onPointerMove: (event: PointerEvent) => {
          if (event.movementX === 0 && event.movementY === 0) {
            return;
          }
          focusFromKeyboard = false;
          result.onPointerMove?.(event);
        },
        tabIndex: options.focus !== "retain" && api.highlightedValue === value ? 0 : -1,
        onFocusIn: () => {
          if (api.highlightedValue !== value) {
            api.setHighlightedValue(value);
          }
        },
      };
    },
    trigger(parentBinding?: MenuBinding, disabled = false) {
      const api = read();
      const result = parentBinding
        ? parentBinding.read().getTriggerItemProps(api)
        : api.getTriggerProps();
      return {
        ...result,
        "aria-disabled": disabled ? "true" : undefined,
        "data-disabled": disabled ? "" : undefined,
        onClick: (event: MouseEvent) => {
          if (disabled) {
            return;
          }
          focusFromKeyboard = event.detail === 0 || options.pointerFocus?.() !== "trigger";
          if (!focusFromKeyboard) {
            overlay.trigger?.focus({ preventScroll: true });
          }
          result.onClick?.(event);
        },
        onKeyDown: (e: KeyboardEvent) => {
          if (disabled || e.key === "Escape") {
            return;
          }
          if (parentBinding && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            return;
          }
          focusFromKeyboard = true;
          result.onKeyDown?.(e);
        },
        onPointerMove: (event: PointerEvent) => {
          const trigger = overlay.trigger;
          if (disabled || !parentBinding || !trigger || event.pointerType !== "mouse") {
            return;
          }
          focusFromKeyboard = false;
          const target = event.currentTarget;
          const point = { x: event.clientX, y: event.clientY };
          const deltaX = parentBinding.pointerDelta(point.x);
          const protectedTravel =
            parent &&
            Object.values(parent.refs.get("children")).some((child) => {
              const polygon = child.context.get("intentPolygon");
              return (
                child.scope.id !== overlay.id &&
                child.state.hasTag("open") &&
                (child.context.get("currentPlacement")?.startsWith("left")
                  ? deltaX < 0
                  : deltaX > 0) &&
                polygon &&
                isPointInPolygon(polygon, point)
              );
            });
          // A leave can lock the parent before the child's document tracker is installed.
          // A sibling's first move must release that stale lock unless its point is protected.
          if (parent && !protectedTravel) {
            parent.refs.set("pointerRoutingLocked", false);
            parent.context.set("pointerRoutingMode", "interactive");
          }
          const item = parentBinding.read().getItemProps({ value: trigger.id });
          item.onPointerMove?.(event);
          // The document pointer listener releases the old child's corridor lock.
          // Decide child opening after that same event, rather than dropping it.
          queueMicrotask(() => {
            if (parent?.refs.get("pointerRoutingLocked")) {
              return;
            }
            service.send({ type: "TRIGGER_POINTERMOVE", target, point });
          });
        },
      };
    },
    content() {
      const result = read().getContentProps();
      const {
        hidden: _hidden,
        tabIndex: _tabIndex,
        style: _style,
        "aria-activedescendant": _active,
        ...rest
      } = result;
      return {
        ...rest,
        tabIndex: -1,
        onPointerMove: (event: PointerEvent) => {
          lastPointerX = event.clientX;
        },
        onKeyDown: (e: KeyboardEvent) => {
          const target = e.target;
          if (!(target instanceof HTMLElement) || !ownsTarget(target)) {
            return;
          }
          if (options.surface === "listbox") {
            keydown(e);
            return;
          }
          if (e.key === "Escape") {
            overlay.keydown(e);
            return;
          }
          if (e.key === "Tab" || target.matches("input,textarea,select,[data-form-control]")) {
            return;
          }
          focusFromKeyboard = true;
          const value = target.dataset.value;
          if (value && value !== read().highlightedValue) {
            read().setHighlightedValue(value);
          }
          result.onKeyDown?.(e);
          // End/Home can keep the same highlight after the user scrolls it out of view.
          focusItem(service.service);
        },
      };
    },
  };
}
