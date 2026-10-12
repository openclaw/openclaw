import type { JSX } from "@solidjs/web";
import { For, Show, createEffect, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import { acquireNativeOverlaySurface } from "../../lib/native-overlay-occlusion.ts";
import { createOverlayAnchor, type OverlayPlacement } from "../overlay-anchor.ts";
import { createOverlay, findOverlayParent, type Overlay } from "../overlay-lifecycle.ts";
import { useMenuMachine, type MenuBinding } from "./menu-machine.ts";
import { retainShadowStyles } from "./shadow-styles.ts";
import overlayStyles from "./overlay.css?inline";
import "./overlay.css";

export type MenuItem = {
  id: string;
  label: string;
  icon?: JSX.Element;
  details?: JSX.Element;
  disabled?: boolean;
  checked?: boolean;
  type?: "checkbox" | "radio";
  class?: string;
  variant?: "danger";
  children?: readonly MenuItem[];
  content?: JSX.Element;
  closeOnSelect?: boolean;
};

export type MenuHandle = { overlay: Overlay; open(): boolean; close(): boolean };
export type MenuProps = {
  /** Stable for this mount; remount the menu to change its identity. */
  id: string;
  label: string;
  items: readonly MenuItem[];
  trigger?: JSX.Element;
  children?: JSX.Element;
  class?: string;
  panelClass?: string;
  triggerClass?: string;
  placement?: OverlayPlacement;
  dir?: "ltr" | "rtl";
  open?: boolean;
  disabled?: boolean;
  onSelect?: (item: MenuItem, event: CustomEvent<MenuItem>) => void;
  onOpenChange?(open: boolean): void;
  onBeforeShow?(event: Event): void;
  onBeforeHide?(event: Event): void;
  ref?(handle: MenuHandle): void;
};

type BranchProps = MenuProps & { parent?: Overlay; parentBinding?: MenuBinding; root?: Overlay };

function ownItems(surface: HTMLElement) {
  return [...surface.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter(
    (item) =>
      item.closest('[role="menu"]') === surface &&
      !item.matches(":disabled") &&
      item.getAttribute("aria-disabled") !== "true",
  );
}

function itemRole(type: MenuItem["type"]): "menuitem" | "menuitemcheckbox" | "menuitemradio" {
  return type ? `menuitem${type}` : "menuitem";
}

/** Menus share native visibility authority; Zag owns navigation and pointer intent. */
export function Menu(props: BranchProps): JSX.Element {
  let mounted = false;
  let trigger!: HTMLButtonElement;
  let surface!: HTMLDivElement;
  let anchorBinding: ReturnType<typeof createOverlayAnchor> | undefined;
  const identity = untrack(() => ({
    id: props.id,
    parent: props.parent,
    binding: props.parentBinding,
    root: props.root,
  }));
  const direction = () => props.dir ?? (document.documentElement.dir === "rtl" ? "rtl" : "ltr");
  const overlay = createOverlay(identity.id, identity.parent, {
    exclusiveGroup: "menu",
    isValid: (panel) =>
      Boolean(
        panel.querySelector(
          '[role^="menuitem"], [data-form-control], [data-search], input, textarea, select, button, a[href]',
        ),
      ),
    acquireOcclusion: acquireNativeOverlaySurface,
    onRootChange: (root) =>
      root instanceof ShadowRoot ? retainShadowStyles(root, [overlayStyles]) : undefined,
    onInitialFocus(intent) {
      const items = ownItems(overlay.surface);
      const initial = [
        ...overlay.surface.querySelectorAll<HTMLElement>("[data-initial-focus], [autofocus]"),
      ].find((node) => node.closest('[role="menu"]') === overlay.surface);
      (intent === "last" ? items.at(-1) : (initial ?? items[0]))?.focus({ preventScroll: true });
    },
    onEscape(event) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement &&
        target.hasAttribute("data-search") &&
        target.value
      ) {
        target.value = "";
        target.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
      return false;
    },
  });
  const menuRoot = identity.root ?? overlay;
  const placement = () =>
    props.placement ??
    (identity.parent ? (direction() === "rtl" ? "left-start" : "right-start") : "bottom-start");
  const activate = (value: string) => {
    const item = props.items.find((entry) => entry.id === value);
    if (!item || item.disabled || item.children) {
      return;
    }
    const event = new CustomEvent("menu-select", { detail: item, bubbles: true, cancelable: true });
    props.onSelect?.(item, event);
    if (!overlay.surface.dispatchEvent(event)) {
      return;
    }
    if (item.closeOnSelect !== false) {
      menuRoot.request(false, "return");
    }
  };
  onSettled(() => overlay.bindSurface(surface));
  const binding = useMenuMachine(overlay, direction, activate, identity.binding?.service);
  const [opened, setOpened] = createSignal(false);
  let openPublication = 0;
  const syncOpen = (open: boolean) => {
    if (open === overlay.open) {
      return;
    }
    const previousPublication = openPublication;
    if (!overlay.request(open) && previousPublication === openPublication) {
      untrack(() => props.onOpenChange?.(overlay.open));
    }
  };
  onCleanup(() => overlay.dispose());
  createEffect(
    () => props.open,
    (open) => {
      if (mounted && open !== undefined) {
        syncOpen(open);
      }
    },
  );
  createEffect(placement, (value) => {
    if (mounted) {
      anchorBinding?.update(trigger, value);
    }
  });
  onSettled(() => {
    mounted = true;
    if (!identity.parent) {
      overlay.setParent(findOverlayParent(trigger));
    }
    anchorBinding = createOverlayAnchor(overlay.surface);
    anchorBinding.update(trigger, placement());
    const stopOpen = overlay.subscribe((open) => {
      openPublication += 1;
      setOpened(open);
      untrack(() => props.onOpenChange?.(open));
    });
    const beforeShow = (event: Event) => {
      if (event.target !== overlay.surface) {
        return;
      }
      if (props.disabled) {
        event.preventDefault();
      }
      props.onBeforeShow?.(event);
    };
    const beforeHide = (event: Event) => {
      if (event.target === overlay.surface) {
        props.onBeforeHide?.(event);
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented || event.isComposing) {
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('[role="menu"]') !== overlay.surface) {
        return;
      }
      const controls = [
        ...overlay.surface.querySelectorAll<HTMLElement>("[data-form-control]"),
      ].filter(
        (control) =>
          control.closest('[role="menu"]') === overlay.surface &&
          control.tabIndex >= 0 &&
          !control.matches(':disabled, [aria-disabled="true"]') &&
          !control.closest("[inert]") &&
          control.checkVisibility({ checkVisibilityCSS: true }),
      );
      const index = controls.indexOf(target);
      const next = controls[index + (event.shiftKey ? -1 : 1)];
      if (index >= 0 && next) {
        event.preventDefault();
        next.focus();
      } else {
        menuRoot.request(false, "return");
      }
    };
    overlay.surface.addEventListener("overlay-show", beforeShow);
    overlay.surface.addEventListener("overlay-hide", beforeHide);
    overlay.surface.addEventListener("keydown", keydown, true);
    props.ref?.({
      overlay,
      open: () => overlay.request(true, "first"),
      close: () => overlay.request(false, "return"),
    });
    if (props.open) {
      syncOpen(true);
    }
    return () => {
      mounted = false;
      stopOpen();
      anchorBinding?.dispose();
      overlay.surface.removeEventListener("overlay-show", beforeShow);
      overlay.surface.removeEventListener("overlay-hide", beforeHide);
      overlay.surface.removeEventListener("keydown", keydown, true);
    };
  });
  return (
    <div class={props.class} dir={direction()}>
      <button
        {...binding.trigger(identity.binding, props.disabled)}
        ref={(node) => {
          trigger = node;
          overlay.bindTrigger(node);
        }}
        type="button"
        id={`${identity.id}:trigger`}
        class={[
          identity.parent ? "oc-menu-item oc-menu-item--submenu" : "oc-menu-trigger",
          props.triggerClass,
        ]}
        role={identity.parent ? "menuitem" : undefined}
        aria-haspopup="menu"
        aria-controls={`${identity.id}:content`}
        aria-expanded={opened() ? "true" : "false"}
        aria-label={props.label}
        disabled={props.disabled}
      >
        <span class="oc-menu-item__label">{props.trigger ?? props.label}</span>
        <Show when={identity.parent}>
          <span class="oc-menu-item__submenu-icon" aria-hidden="true">
            ›
          </span>
        </Show>
      </button>
      <div
        {...binding.content()}
        ref={(node) => {
          surface = node;
        }}
        id={`${identity.id}:content`}
        class={["oc-overlay oc-menu", props.panelClass]}
        popover="manual"
        role="menu"
        aria-label={props.label}
        dir={direction()}
      >
        {props.children}
        <For each={props.items} keyed={(item) => item.id}>
          {(item) => (
            <Show
              when={item().children}
              fallback={
                <button
                  {...binding.item(
                    item().id,
                    item().disabled,
                    item().type,
                    item().checked,
                    item().label,
                  )}
                  type="button"
                  class={["oc-menu-item", item().class]}
                  data-value={item().id}
                  data-variant={item().variant}
                  role={itemRole(item().type)}
                  aria-label={item().label}
                  aria-checked={item().type ? (item().checked ? "true" : "false") : undefined}
                  aria-disabled={item().disabled ? "true" : undefined}
                  disabled={item().disabled}
                >
                  <Show when={item().type}>
                    <span class="oc-menu-item__check" aria-hidden="true">
                      {item().checked ? "✓" : ""}
                    </span>
                  </Show>
                  <Show when={item().icon}>
                    <span class="oc-menu-item__icon">{item().icon}</span>
                  </Show>
                  <span class="oc-menu-item__label">{item().label}</span>
                  <Show when={item().details}>
                    <span class="oc-menu-item__details">{item().details}</span>
                  </Show>
                </button>
              }
            >
              {(children) => (
                <Menu
                  id={`${identity.id}-${item().id}`}
                  label={item().label}
                  items={children()}
                  trigger={item().label}
                  parent={overlay}
                  root={menuRoot}
                  parentBinding={binding}
                  dir={direction()}
                  disabled={item().disabled}
                  triggerClass={item().class}
                  onSelect={props.onSelect}
                >
                  {item().content}
                </Menu>
              )}
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}
