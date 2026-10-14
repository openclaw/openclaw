import { dynamic, type JSX } from "@solidjs/web";
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
  untrack,
  merge,
} from "solid-js";
import { acquireNativeOverlaySurface } from "../../lib/native-overlay-occlusion.ts";
import { createOverlayAnchor, type OverlayPlacement } from "../overlay-anchor.ts";
import { createOverlay, findOverlayParent, type Overlay } from "../overlay-lifecycle.ts";
import { useMenuMachine, type MenuBinding } from "./menu-machine.ts";
import { retainShadowStyles } from "./shadow-styles.ts";
import overlayStyles from "./overlay.css?inline";
import "./overlay.css";

export type MenuItemBindings = Pick<
  JSX.HTMLAttributes<HTMLElement>,
  "id" | "role" | "tabindex" | "aria-label" | "aria-disabled" | "aria-checked"
> & {
  [name: `data-${string}`]: string | number | boolean | undefined;
  onClick?: (event: MouseEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onFocusIn?: (event: FocusEvent) => void;
  onPointerMove?: (event: PointerEvent) => void;
};

export type MenuItem = {
  kind?: "item";
  id: string;
  label: string;
  href?: string;
  /** Compound rows can contain independently focusable controls. */
  as?: "div";
  attributes?: Omit<
    JSX.ButtonHTMLAttributes<HTMLButtonElement>,
    "ref" | "onClick" | "onContextMenu"
  > &
    Pick<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "target" | "rel"> & {
      onClick?: (event: MouseEvent) => void;
      onContextMenu?: (event: MouseEvent) => void;
      [name: `data-${string}`]: string | number | boolean | undefined;
    };
  icon?: JSX.Element;
  details?: JSX.Element;
  disabled?: boolean;
  checked?: boolean;
  type?: "checkbox" | "radio";
  class?: string;
  variant?: "danger";
  children?: readonly MenuEntry[];
  content?: JSX.Element;
  trigger?: JSX.Element;
  closeOnSelect?: boolean;
  render?: (attributes: MenuItemBindings) => JSX.Element;
};
export type MenuEntry =
  | MenuItem
  | { kind: "content"; id: string; content: JSX.Element }
  | { kind: "group"; id: string; class?: string; items: readonly MenuEntry[] };

export type MenuHandle = { overlay: Overlay; open(): boolean; close(): boolean };
export type MenuProps = {
  /** Stable for this mount; remount the menu to change its identity. */
  id: string;
  label: string;
  items: readonly MenuEntry[];
  trigger?: JSX.Element;
  children?: JSX.Element;
  class?: string;
  panelClass?: string;
  triggerClass?: string;
  triggerAttributes?: Pick<
    JSX.HTMLAttributes<HTMLButtonElement>,
    "title" | "style" | "tabindex" | "aria-hidden" | "aria-busy"
  > & {
    /** Stable for this mount, like the menu id. */
    id?: string;
    [name: `data-${string}`]: string | number | boolean | undefined;
  };
  placement?: OverlayPlacement;
  dir?: "ltr" | "rtl";
  open?: boolean;
  disabled?: boolean;
  /** Override the destination when Tab exits the menu; dismissal stays owned here. */
  tabFocusTarget?: (backward: boolean) => HTMLElement | undefined;
  onSelect?: (item: MenuItem, event: CustomEvent<MenuItem>) => void;
  onOpenChange?(open: boolean): void;
  onBeforeShow?(event: Event): void;
  onAfterShow?(event: Event): void;
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

function findItem(entries: readonly MenuEntry[], id: string): MenuItem | undefined {
  for (const entry of entries) {
    if (entry.kind === "group") {
      const item = findItem(entry.items, id);
      if (item) {
        return item;
      }
    } else if (entry.kind !== "content" && entry.id === id) {
      return entry;
    }
  }
  return undefined;
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
    triggerId: props.parent
      ? `${props.id}:trigger`
      : (props.triggerAttributes?.id ?? `${props.id}:trigger`),
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
    const item = findItem(props.items, value);
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
  const binding = useMenuMachine(overlay, direction, activate, identity.binding?.service, {
    ids: { trigger: identity.triggerId },
  });
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
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('[role="menu"]') !== overlay.surface) {
        return;
      }
      const search = overlay.surface.querySelector<HTMLInputElement>("input[data-search]");
      const first = ownItems(overlay.surface)[0];
      if (
        target instanceof HTMLButtonElement &&
        target.hasAttribute("data-form-control") &&
        ["ArrowDown", "ArrowUp"].includes(event.key)
      ) {
        binding.keydown(event);
        return;
      }
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        ((target === search && event.key === "ArrowDown") ||
          (target === first && search && event.key === "ArrowUp"))
      ) {
        event.preventDefault();
        event.stopPropagation();
        (target === search ? first : search)?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== "Tab" || event.defaultPrevented || event.isComposing) {
        return;
      }
      const controls = [
        ...overlay.surface.querySelectorAll<HTMLElement>("[data-form-control]"),
      ].filter(
        (control) =>
          control.closest('[role="menu"]') === overlay.surface &&
          (control.tabIndex >= 0 || control.closest('[role^="menuitem"]')) &&
          !control.matches(':disabled, [aria-disabled="true"]') &&
          !control.closest("[inert]") &&
          control.checkVisibility({ checkVisibilityCSS: true }),
      );
      const row = target.closest<HTMLElement>('[role^="menuitem"]');
      const firstControl = row ? controls.find((control) => row.contains(control)) : undefined;
      if (
        firstControl &&
        ((!event.shiftKey && target === row) || (event.shiftKey && target === firstControl))
      ) {
        event.preventDefault();
        (event.shiftKey ? row : firstControl)?.focus();
        return;
      }
      const index = controls.indexOf(target);
      const next = controls[index + (event.shiftKey ? -1 : 1)];
      if (index >= 0 && next) {
        event.preventDefault();
        next.focus();
      } else {
        const destination = untrack(() => props.tabFocusTarget?.(event.shiftKey));
        if (destination) {
          event.preventDefault();
          if (menuRoot.request(false, "none")) {
            destination.focus({ preventScroll: true });
          }
        } else {
          menuRoot.request(false, "return");
        }
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
  const renderEntries = (entries: () => readonly MenuEntry[]): JSX.Element => (
    <For each={entries()} keyed={(entry) => entry.id}>
      {(entry) => {
        const actionable = () => {
          const current = entry();
          return current.kind === "content" || current.kind === "group" ? undefined : current;
        };
        const content = () => {
          const current = entry();
          return current.kind === "content" ? current.content : undefined;
        };
        const group = () => {
          const current = entry();
          return current.kind === "group" ? current : undefined;
        };
        const fallback = (
          <Show when={group()} fallback={content()}>
            {(section) => <div class={section().class}>{renderEntries(() => section().items)}</div>}
          </Show>
        );
        return (
          <Show when={actionable()} fallback={fallback}>
            {(item) => {
              const Item = dynamic(() =>
                item().href === undefined ? (item().as ?? "button") : "a",
              );
              const renderCustom = untrack(() => item().render);
              const attributes = merge((): MenuItemBindings => ({
                ...binding.item(
                  item().id,
                  item().disabled,
                  item().type,
                  item().checked,
                  item().label,
                ),
                role: itemRole(item().type),
                "aria-label": item().label,
                "data-value": item().id,
              }));
              const leaf = renderCustom ? (
                untrack(() => renderCustom(attributes))
              ) : (
                <Item
                  {...item().attributes}
                  {...binding.item(
                    item().id,
                    item().disabled,
                    item().type,
                    item().checked,
                    item().label,
                  )}
                  onClick={(event: MouseEvent) => {
                    const handler = item().attributes?.onClick;
                    if (typeof handler === "function") {
                      handler(event);
                    }
                    if (!event.defaultPrevented) {
                      const bound = binding.item(
                        item().id,
                        item().disabled,
                        item().type,
                        item().checked,
                        item().label,
                      );
                      if (typeof bound.onClick === "function") {
                        bound.onClick(event);
                      }
                    }
                  }}
                  onContextMenu={(event: MouseEvent) => {
                    const handler = item().attributes?.onContextMenu;
                    if (typeof handler === "function") {
                      handler(event);
                    }
                    if (item().href !== undefined) {
                      event.stopPropagation();
                    }
                  }}
                  type={item().href === undefined && !item().as ? "button" : undefined}
                  href={item().disabled ? undefined : item().href}
                  class={["oc-menu-item", item().class]}
                  data-value={item().id}
                  data-variant={item().variant}
                  role={itemRole(item().type)}
                  aria-label={item().label}
                  aria-checked={item().type ? (item().checked ? "true" : "false") : undefined}
                  aria-disabled={item().disabled ? "true" : undefined}
                  disabled={item().href === undefined ? item().disabled : undefined}
                >
                  <Show when={item().type}>
                    <span class="oc-menu-item__check" aria-hidden="true">
                      {item().checked ? "✓" : ""}
                    </span>
                  </Show>
                  <Show when={item().icon}>
                    <span class="oc-menu-item__icon">{item().icon}</span>
                  </Show>
                  <span class="oc-menu-item__label">{item().content ?? item().label}</span>
                  <Show when={item().details}>
                    <span class="oc-menu-item__details">{item().details}</span>
                  </Show>
                </Item>
              );
              return (
                <Show when={item().children} fallback={leaf}>
                  {(children) => (
                    <Menu
                      id={`${identity.id}-${item().id}`}
                      label={item().label}
                      items={children()}
                      trigger={item().trigger ?? item().label}
                      parent={overlay}
                      root={menuRoot}
                      parentBinding={binding}
                      tabFocusTarget={props.tabFocusTarget}
                      dir={direction()}
                      disabled={item().disabled}
                      triggerClass={item().class}
                      triggerAttributes={{ "data-value": item().id }}
                      onSelect={props.onSelect}
                    >
                      {item().content}
                    </Menu>
                  )}
                </Show>
              );
            }}
          </Show>
        );
      }}
    </For>
  );
  return (
    <div class={props.class} dir={direction()}>
      <button
        {...binding.trigger(identity.binding, props.disabled)}
        {...props.triggerAttributes}
        ref={(node) => {
          trigger = node;
          overlay.bindTrigger(node);
        }}
        type="button"
        id={identity.triggerId}
        class={[
          identity.parent ? "oc-menu-item oc-menu-item--submenu" : "oc-menu-trigger",
          props.triggerClass,
        ]}
        role={identity.parent ? "menuitem" : undefined}
        aria-haspopup="menu"
        aria-controls={`${identity.id}:content`}
        aria-expanded={opened() ? "true" : "false"}
        data-highlighted={
          identity.binding &&
          (identity.binding.read().highlightedValue === props.triggerAttributes?.["data-value"] ||
            identity.binding.read().highlightedValue === identity.triggerId)
            ? ""
            : undefined
        }
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
        onOverlay-after-show={(event: Event) => {
          if (event.target === surface) {
            props.onAfterShow?.(event);
          }
        }}
      >
        {props.children}
        {renderEntries(() => props.items)}
      </div>
    </div>
  );
}
