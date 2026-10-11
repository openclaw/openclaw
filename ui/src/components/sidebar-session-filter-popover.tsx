import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import type { JSX } from "@solidjs/web";
import { createEffect, onSettled, Show } from "solid-js";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { occludeNativeBrowserSurface } from "../lib/native-overlay-occlusion.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { configureAnchoredPopup } from "./anchored-overlay.ts";
import "./menu-surface.ts";

const TABBABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]";

// The sheet is modal: Tab and Shift+Tab wrap between its first and last tabbable controls.
function keepSheetFocus(panel: HTMLElement, event: KeyboardEvent) {
  const tabbable = [...panel.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)].filter(
    (candidate) => candidate.tabIndex >= 0 && candidate.checkVisibility(),
  );
  const boundary = event.shiftKey ? tabbable[0] : tabbable.at(-1);
  const target = event.shiftKey ? tabbable.at(-1) : tabbable[0];
  // A closing picker page may have handed focus back to its trigger.
  const active = panel.ownerDocument.activeElement;
  if (!target || active === panel || active === boundary) {
    event.preventDefault();
    target?.focus({ preventScroll: true });
  }
}

type SidebarSessionFilterPopoverProps = {
  anchor: HTMLElement | null;
  label: string;
  initialFocusSelector: string;
  content: JSX.Element;
  onClose: (restoreFocus: boolean) => void;
};

function renderSidebarSessionFilterPopover(
  props: SidebarSessionFilterPopoverProps,
  host: HTMLElement,
) {
  host.style.display = "contents";
  let popup: WaPopup | undefined;
  let focused = false;
  let focusFrame: number | undefined;
  const focusInitialControl = () => {
    if (!focused) {
      focused = true;
      host.querySelector<HTMLElement>(props.initialFocusSelector)?.focus({ preventScroll: true });
    }
  };
  const close = (restoreFocus: boolean) => props.onClose?.(restoreFocus);
  const handleOutsidePointer = (event: PointerEvent) => {
    const path = event.composedPath();
    if (!path.includes(host) && (!props.anchor || !path.includes(props.anchor))) {
      close(false);
    }
  };
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (
      event.key === "Tab" &&
      !event.defaultPrevented &&
      isMobileNavLayout() &&
      event.currentTarget instanceof HTMLElement
    ) {
      keepSheetFocus(event.currentTarget, event);
    }
  };
  const handleFocusOut = (event: FocusEvent) => {
    if (
      event.relatedTarget instanceof Node &&
      !host.contains(event.relatedTarget) &&
      event.relatedTarget !== props.anchor
    ) {
      close(false);
    }
  };
  createEffect(
    () => props.anchor,
    (anchor) => {
      if (popup && anchor) {
        configureAnchoredPopup(popup, anchor, "bottom");
      } else {
        // Sheet controls settle after the outer panel commits.
        focusFrame = requestAnimationFrame(focusInitialControl);
      }
      return () => {
        if (focusFrame !== undefined) {
          cancelAnimationFrame(focusFrame);
        }
      };
    },
  );
  onSettled(() => {
    occludeNativeBrowserSurface(host);
    host.ownerDocument.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => host.ownerDocument.removeEventListener("pointerdown", handleOutsidePointer, true);
  });
  function Panel() {
    return (
      <div
        class="sidebar-session-filter-panel"
        tabindex={-1}
        role="dialog"
        aria-label={props.label ?? ""}
        aria-modal={isMobileNavLayout() ? "true" : undefined}
        onKeyDown={handleKeydown}
        onFocusOut={handleFocusOut}
      >
        <div class="sidebar-session-filter-panel__grabber" aria-hidden="true" />
        {props.content}
      </div>
    );
  }
  return (
    <>
      <Show
        when={isMobileNavLayout()}
        fallback={
          <wa-popup
            ref={(element: WaPopup) => {
              popup = element;
            }}
            active
            onWa-reposition={focusInitialControl}
          >
            <Panel />
          </wa-popup>
        }
      >
        <button
          type="button"
          class="sidebar-session-filter-panel__backdrop"
          tabindex={-1}
          aria-label={t("common.close")}
          onClick={() => close(true)}
        />
        <openclaw-menu-surface>
          <Panel />
        </openclaw-menu-surface>
      </Show>
    </>
  );
}

export const SidebarSessionFilterPopover = defineSolidBridge<SidebarSessionFilterPopoverProps>(
  "openclaw-sidebar-session-filter-popover",
  renderSidebarSessionFilterPopover,
  {
    properties: {
      anchor: { default: null, attribute: false },
      label: { default: "", attribute: false },
      initialFocusSelector: {
        default: '#sidebar-sessions-owner, #sidebar-sessions-status input[type="radio"]:checked',
        attribute: false,
      },
      content: { default: null, attribute: false },
      onClose: { default: () => {}, attribute: false },
    },
  },
);
