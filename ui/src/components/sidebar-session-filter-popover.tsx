import type { JSX } from "@solidjs/web";
import { createUniqueId, onCleanup, Show } from "solid-js";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { Popover, type PopoverHandle } from "./solid/popover.tsx";

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
  let handle: PopoverHandle | undefined;
  let focused = false;
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Tab" && !event.defaultPrevented && isMobileNavLayout() && handle) {
      keepSheetFocus(handle.overlay.surface, event);
    }
  };
  onCleanup(() => handle?.overlay.surface.removeEventListener("keydown", handleKeydown));
  const focusInitialControl = () => {
    if (focused) {
      return;
    }
    focused = true;
    // Opening must not take focus from a control already chosen inside the panel.
    if (!host.contains(host.ownerDocument.activeElement)) {
      host.querySelector<HTMLElement>(props.initialFocusSelector)?.focus({ preventScroll: true });
    }
  };
  return (
    <>
      <Show when={isMobileNavLayout()}>
        <button
          type="button"
          class="sidebar-session-filter-panel__backdrop"
          tabindex={-1}
          aria-label={t("common.close")}
          onClick={() => handle?.overlay.request(false, "return")}
        />
      </Show>
      <Popover
        id={`sidebar-session-filter-${createUniqueId()}`}
        anchor={props.anchor ?? host}
        label={props.label}
        class="sidebar-session-filter-popover sidebar-session-filter-panel"
        placement="bottom-start"
        open
        dismissOutsidePointer={!isMobileNavLayout()}
        dismissOutsideFocus={!isMobileNavLayout()}
        ref={(value) => {
          handle = value;
          if (isMobileNavLayout()) {
            value.overlay.surface.setAttribute("aria-modal", "true");
          }
          value.overlay.surface.addEventListener("keydown", handleKeydown);
        }}
        onOpenChange={(open) => {
          if (open) {
            focusInitialControl();
          } else {
            props.onClose(false);
          }
        }}
      >
        <div class="sidebar-session-filter-panel__grabber" aria-hidden="true" />
        {props.content}
      </Popover>
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
        default: '#sidebar-sessions-status input[type="radio"]:checked',
        attribute: false,
      },
      content: { default: null, attribute: false },
      onClose: { default: () => {}, attribute: false },
    },
  },
);
