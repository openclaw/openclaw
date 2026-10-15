import { dynamic, insert, type JSX } from "@solidjs/web";
import {
  For,
  Show,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  onSettled,
  runWithOwner,
  untrack,
  merge,
} from "solid-js";
import { acquireNativeOverlaySurface } from "../../lib/native-overlay-occlusion.ts";
import { createOverlayAnchor, type OverlayPlacement } from "../overlay-anchor.ts";
import { createOverlay, findOverlayParent, type Overlay } from "../overlay-lifecycle.ts";
import { containsComposed, registryFor } from "../overlay-registry.ts";
import { useMenuMachine, type MenuBinding } from "./menu-machine.ts";
import { useOverlayControl } from "./overlay-control.ts";
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
    "id" | "ref" | "onClick" | "onContextMenu"
  > &
    Pick<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "target" | "rel"> & {
      id?: string;
      onClick?: (event: MouseEvent) => void;
      onContextMenu?: (event: MouseEvent) => void;
      [name: `data-${string}`]: string | number | boolean | undefined;
    };
  icon?: JSX.Element;
  details?: JSX.Element;
  labelClass?: string;
  disabled?: boolean;
  checked?: boolean;
  type?: "checkbox" | "radio";
  class?: string;
  variant?: "danger";
  children?: readonly MenuEntry[];
  content?: JSX.Element;
  trigger?: JSX.Element;
  closeOnSelect?: boolean;
  onBeforeShow?(event: Event): void;
  render?: (attributes: MenuItemBindings) => JSX.Element;
};
export type MenuEntry =
  | MenuItem
  | { kind: "content"; id: string; content: JSX.Element }
  | { kind: "group"; id: string; class?: string; items: readonly MenuEntry[] };

export type MenuHandle = { overlay: Overlay; open(): boolean; close(): boolean };

/** Close through the owner even when a menu surface has moved into the top layer. */
export function closeMenusWithin(
  root: Pick<ParentNode, "querySelectorAll"> & { ownerDocument: Document },
): void {
  const elements = new Set(root.querySelectorAll('[role="menu"], [aria-haspopup="menu"]'));
  for (const overlay of registryFor(root.ownerDocument).members.keys()) {
    if (
      overlay.open &&
      overlay.surface.getAttribute("role") === "menu" &&
      (elements.has(overlay.surface) || (overlay.trigger && elements.has(overlay.trigger)))
    ) {
      overlay.request(false);
    }
  }
}

export type MenuProps = {
  /** Stable for this mount; remount the menu to change its identity. */
  id: string;
  label: string;
  items: readonly MenuEntry[];
  /** Materialize content on first open, then retain it across closes. Stable for this mount. */
  lazy?: boolean;
  trigger?: JSX.Element;
  children?: JSX.Element;
  class?: JSX.HTMLAttributes<HTMLDivElement>["class"];
  panelClass?: string;
  triggerClass?: string;
  triggerAttributes?: Pick<
    JSX.ButtonHTMLAttributes<HTMLButtonElement>,
    "title" | "style" | "tabindex" | "aria-hidden" | "aria-keyshortcuts" | "aria-busy" | "value"
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
  onNavigate?: (link: { href: string; value: string }) => void;
  pointerFocus?: "menu" | "trigger";
  onOpenChange?(open: boolean): void;
  onBeforeShow?(event: Event): void;
  onEscape?(event: KeyboardEvent): boolean;
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
  const owner = getOwner();
  const lazy = untrack(() => props.lazy);
  let disposeBody: (() => void) | undefined;
  onCleanup(() => disposeBody?.());
  const overlay = createOverlay(identity.id, identity.parent, {
    exclusiveGroup: "menu",
    isValid: (panel) =>
      (lazy && !disposeBody) ||
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
      if (props.onEscape?.(event)) {
        return true;
      }
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
    if (item.href) {
      props.onNavigate?.({ href: item.href, value: item.id });
    }
    if (item.closeOnSelect !== false) {
      menuRoot.request(false, "return");
    }
  };
  onSettled(() => overlay.bindSurface(surface));
  const binding = useMenuMachine(overlay, direction, activate, identity.binding?.service, {
    ids: { trigger: identity.triggerId },
    pointerFocus: () => props.pointerFocus ?? "menu",
  });
  const [opened, setOpened] = createSignal(false);
  const connectControl = useOverlayControl(
    overlay,
    merge(props, {
      onBeforeShow(event: Event) {
        materializeBody();
        props.onBeforeShow?.(event);
      },
    }),
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
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        target.closest('[role="menu"]') !== overlay.surface ||
        [...overlay.children].some((child) => child.open && containsComposed(child.surface, target))
      ) {
        return;
      }
      const search = overlay.surface.querySelector<HTMLInputElement>("input[data-search]");
      const first = ownItems(overlay.surface).find(
        (item) =>
          !search ||
          Boolean(search.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
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
      let next = index >= 0 ? controls[index + (event.shiftKey ? -1 : 1)] : undefined;
      if (target.matches("input[data-search]") && !event.shiftKey) {
        next = ownItems(overlay.surface).find((item) =>
          Boolean(target.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
      } else if (index === 0 && event.shiftKey) {
        next = ownItems(overlay.surface).findLast((item) =>
          Boolean(target.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_PRECEDING),
        );
      } else if (index < 0 && !event.shiftKey && target.matches('[role^="menuitem"]')) {
        next = controls.find((control) =>
          Boolean(target.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
      }
      if (next) {
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
    overlay.surface.addEventListener("keydown", keydown, true);
    const disconnectControl = connectControl(
      () =>
        props.ref?.({
          overlay,
          open: () => overlay.request(true, "first"),
          close: () => overlay.request(false, "return"),
        }),
      setOpened,
    );
    return () => {
      mounted = false;
      disconnectControl();
      anchorBinding?.dispose();
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
              const Leaf = () => {
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
                return renderCustom ? (
                  untrack(() => renderCustom(attributes))
                ) : (
                  <Item
                    {...item().attributes}
                    {...attributes}
                    onClick={(event: MouseEvent) => {
                      item().attributes?.onClick?.(event);
                      if (!event.defaultPrevented) {
                        attributes.onClick?.(event);
                      }
                    }}
                    onContextMenu={(event: MouseEvent) => {
                      item().attributes?.onContextMenu?.(event);
                      if (item().href !== undefined) {
                        event.stopPropagation();
                      }
                    }}
                    type={item().href === undefined && !item().as ? "button" : undefined}
                    href={item().disabled ? undefined : item().href}
                    class={["oc-menu-item", item().class]}
                    value={item().attributes?.value ?? item().id}
                    data-variant={item().variant}
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
                    <span class={["oc-menu-item__label", item().labelClass]}>
                      {item().content ?? item().label}
                    </span>
                    <Show when={item().details}>
                      <span class="oc-menu-item__details">{item().details}</span>
                    </Show>
                  </Item>
                );
              };
              return (
                <Show when={item().children} fallback={<Leaf />}>
                  {(children) => (
                    <Menu
                      id={`${identity.id}-${item().id}`}
                      label={item().label}
                      items={children()}
                      trigger={
                        item().trigger ?? (
                          <>
                            <Show when={item().icon}>
                              <span class="oc-menu-item__icon">{item().icon}</span>
                            </Show>
                            <span class={["oc-menu-item__label", item().labelClass]}>
                              {item().label}
                            </span>
                            <Show when={item().details}>
                              <span class="oc-menu-item__details">{item().details}</span>
                            </Show>
                          </>
                        )
                      }
                      parent={overlay}
                      root={menuRoot}
                      parentBinding={binding}
                      tabFocusTarget={props.tabFocusTarget}
                      dir={direction()}
                      disabled={item().disabled}
                      triggerClass={item().class}
                      triggerAttributes={{
                        "data-value": item().id,
                        value: item().attributes?.value ?? item().id,
                        "data-shortcut": item().attributes?.["data-shortcut"],
                        "aria-keyshortcuts": item().attributes?.["aria-keyshortcuts"],
                        title: item().attributes?.title,
                      }}
                      onSelect={props.onSelect}
                      onNavigate={props.onNavigate}
                      onBeforeShow={(event) => item().onBeforeShow?.(event)}
                      onEscape={(event) => props.onEscape?.(event) ?? false}
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
  const body = () => (
    <>
      {props.children}
      {renderEntries(() => props.items)}
    </>
  );
  const materializeBody = () => {
    if (lazy && !disposeBody) {
      runWithOwner(owner, () => {
        disposeBody = createRoot((dispose) => {
          insert(surface, body());
          return dispose;
        });
      });
    }
  };
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
        {lazy ? undefined : body()}
      </div>
    </div>
  );
}
