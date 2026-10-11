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
};

export function useMenuMachine(
  overlay: Overlay,
  direction: () => "ltr" | "rtl",
  onSelect: (value: string) => void,
  parent?: MenuService,
): MenuBinding {
  let lastPointerX: number | undefined;
  let focusFromKeyboard = false;
  const focusItem = (service: MenuService) => {
    if (!overlay.open) {
      return;
    }
    const id = service.computed("highlightedId");
    const node = id ? service.scope.getById<HTMLElement>(id) : undefined;
    const active = service.scope.getActiveElement();
    if (
      active instanceof HTMLElement &&
      active.matches("input, textarea, select") &&
      !focusFromKeyboard
    ) {
      return;
    }
    for (const item of overlay.surface.querySelectorAll<HTMLElement>("[data-menu-item]")) {
      if (item.closest('[role="menu"]') === overlay.surface) {
        item.tabIndex = item === node ? 0 : -1;
      }
    }
    if (
      node &&
      focusFromKeyboard &&
      ![...overlay.children].some((child) => child.open && containsComposed(child.surface, active))
    ) {
      node.focus();
    }
  };
  const adapted: typeof machine = {
    ...machine,
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
      if (open && (!overlay.trigger?.isConnected || (overlay.parent && !overlay.parent.open))) {
        service.send({ type: "CONTROLLED.CLOSE" });
        return;
      }
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
  };
  const service = new VanillaMachine(adapted, props);
  createEffect(direction, (dir) => service.updateProps({ ...props, dir, open: overlay.open }));
  const [revision, setRevision] = createSignal(0);
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
      service.updateProps({ ...props, dir: untrack(direction), open });
      if (!open) {
        service.send({ type: "CONTROLLED.CLOSE" });
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
  return {
    service: service.service,
    read,
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
        onPointerMove: (event: PointerEvent) => {
          if (event.movementX === 0 && event.movementY === 0) {
            return;
          }
          focusFromKeyboard = false;
          (result.onPointerMove as ((event: PointerEvent) => void) | undefined)?.(event);
        },
        tabIndex: api.highlightedValue === value ? 0 : -1,
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
          focusFromKeyboard = true;
          (result.onClick as ((event: MouseEvent) => void) | undefined)?.(event);
        },
        onKeyDown: (e: KeyboardEvent) => {
          if (disabled || e.key === "Escape") {
            return;
          }
          if (parentBinding && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            return;
          }
          focusFromKeyboard = true;
          (result.onKeyDown as ((e: KeyboardEvent) => void) | undefined)?.(e);
        },
        onPointerMove: (event: PointerEvent) => {
          const trigger = overlay.trigger;
          if (disabled || !parentBinding || !trigger || event.pointerType !== "mouse") {
            return;
          }
          focusFromKeyboard = false;
          const target = event.currentTarget;
          const point = { x: event.clientX, y: event.clientY };
          const parentRevision = overlay.parent?.revision;
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
          (item.onPointerMove as ((e: PointerEvent) => void) | undefined)?.(event);
          // The document pointer listener releases the old child's corridor lock.
          // Decide child opening after that same event, rather than dropping it.
          queueMicrotask(() => {
            if (
              overlay.trigger !== target ||
              !overlay.trigger?.isConnected ||
              !overlay.parent?.open ||
              overlay.parent.revision !== parentRevision
            ) {
              return;
            }
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
          if ((e.target as HTMLElement).closest('[role="menu"]') !== overlay.surface) {
            return;
          }
          if (
            e.key === "Tab" ||
            e.key === "Escape" ||
            (e.target as HTMLElement).matches("input,textarea,select,[data-form-control]")
          ) {
            return;
          }
          focusFromKeyboard = true;
          const target = e.target as HTMLElement;
          const value = target.dataset.value;
          if (value && value !== read().highlightedValue) {
            read().setHighlightedValue(value);
          }
          (result.onKeyDown as ((e: KeyboardEvent) => void) | undefined)?.(e);
        },
      };
    },
  };
}
