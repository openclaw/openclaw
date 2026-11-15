import type { JSX } from "@solidjs/web";
import { createUniqueId, onSettled } from "solid-js";
import { listen } from "../lib/reactive/listener.ts";
import type { IconName } from "./icon-data.ts";
import { Icon } from "./solid/icon.tsx";
import { pointMenuTriggerAttributes } from "./solid/menu-trigger.tsx";
import {
  Menu,
  type MenuControls,
  type MenuEntry,
  type MenuHandle,
  type MenuItem,
} from "./solid/menu.tsx";

type SidebarMenuPosition = {
  x: number;
  y?: number;
  top?: number;
  bottom?: number;
  placement?: "right-start" | "right-end";
};

export function renderSidebarMenuAction(
  value: string,
  label: string,
  icon: IconName,
  options: { disabled?: boolean; title?: string; className?: string; details?: JSX.Element } = {},
): MenuItem {
  return {
    id: value,
    label,
    class: ["sidebar-customize-menu__item", options.className],
    disabled: options.disabled,
    attributes: { title: options.title },
    icon: (
      <span class="nav-item__icon" aria-hidden="true">
        <Icon name={icon} />
      </span>
    ),
    content: <span class="sidebar-customize-menu__text">{label}</span>,
    details: options.details,
  };
}

export type SidebarDropdownProps = {
  controls?: MenuControls;
  position: SidebarMenuPosition;
  class: JSX.ClassValue;
  label: string;
  anchor?: HTMLElement;
  items: readonly MenuEntry[];
  onSelect: (id: string) => void;
  onClose: (restoreFocus: boolean) => void;
  onAfterShow?: (event: Event) => void;
  onOpenChange?: (open: boolean) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  panelStyle?: JSX.CSSProperties;
  focusOnOpen?: boolean;
  ref?: (handle: MenuHandle) => void;
};

export function SidebarDropdown(params: SidebarDropdownProps): JSX.Element {
  const id = createUniqueId();
  const sidePlacement = () =>
    params.position.placement === "right-start" || params.position.placement === "right-end";
  const triggerAttributes = () => {
    const attributes = pointMenuTriggerAttributes(
      {
        x: params.position.x,
        y: params.position.bottom ?? params.position.top ?? params.position.y,
      },
      params.position.bottom === undefined ? "top" : "bottom",
    );
    // This point sits on the rail edge; native button padding must not widen it.
    return sidePlacement()
      ? { ...attributes, style: { ...attributes.style, width: "0px", padding: "0", border: "0" } }
      : attributes;
  };
  let removeListeners: (() => void)[] = [];
  // Menu publishes its handle after settled setup has registered this teardown.
  onSettled(() => () => removeListeners.forEach((stop) => stop()));
  return (
    <Menu
      controls={params.controls}
      id={`sidebar-menu-${id}`}
      panelClass={params.class}
      label={params.label}
      open
      items={params.items}
      placement={
        params.position.placement ??
        (params.position.bottom === undefined ? "bottom-start" : "top-start")
      }
      triggerAttributes={triggerAttributes()}
      ref={(handle) => {
        params.ref?.(handle);
        const { overlay } = handle;
        overlay.surface.dataset.chatAutotypeExempt = "";
        if (params.anchor) {
          overlay.setReturnTarget(params.anchor);
        }
        if (sidePlacement()) {
          overlay.surface.style.setProperty("--oc-overlay-distance", "8px");
        }
        if (params.panelStyle) {
          for (const [property, value] of Object.entries(params.panelStyle)) {
            overlay.surface.style.setProperty(property, String(value));
          }
        }
        removeListeners = [
          listen(overlay.surface, "pointerenter", () => params.onPointerEnter?.()),
          listen(overlay.surface, "pointerleave", () => params.onPointerLeave?.()),
        ];
        overlay.request(true, params.focusOnOpen === false ? "none" : "first");
      }}
      onSelect={(item) => params.onSelect(item.id)}
      onAfterShow={params.onAfterShow}
      onOpenChange={(open) => {
        params.onOpenChange?.(open);
        if (!open) {
          params.onClose(false);
        }
      }}
    />
  );
}
