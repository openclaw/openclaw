import type { JSX } from "@solidjs/web";
import { createUniqueId, onSettled, Show } from "solid-js";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { Popover, type PopoverHandle } from "./solid/popover.tsx";

export function SidebarSessionFilterPopover(props: {
  class?: string;
  anchor: HTMLElement | null;
  label: string;
  initialFocus: () => HTMLElement | undefined;
  focusTargets: () => readonly HTMLElement[];
  content: JSX.Element;
  onClose: (restoreFocus: boolean) => void;
}) {
  let host!: HTMLElement;
  let handle: PopoverHandle | undefined;
  let disconnectKeydown: (() => void) | undefined;
  let focused = false;
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Tab" && !event.defaultPrevented && isMobileNavLayout() && handle) {
      // The sheet is modal: Tab and Shift+Tab wrap between its first and last tabbable controls.
      const panel = handle.overlay.surface;
      const targets = props.focusTargets();
      const tabbable = targets
        .filter(
          (candidate) =>
            panel.contains(candidate) &&
            candidate.tabIndex >= 0 &&
            !candidate.matches(":disabled") &&
            !candidate.closest("[hidden]") &&
            candidate.checkVisibility(),
        )
        .toSorted((left, right) =>
          left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
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
  };
  onSettled(() => () => disconnectKeydown?.());
  const focusInitialControl = () => {
    if (focused) {
      return;
    }
    focused = true;
    // Opening must not take focus from a control already chosen inside the panel.
    if (!host.contains(host.ownerDocument.activeElement)) {
      props.initialFocus()?.focus({ preventScroll: true });
    }
  };
  return (
    <openclaw-sidebar-session-filter-popover
      ref={(element) => {
        host = element;
      }}
      class={props.class}
      style={{ display: "contents" }}
    >
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
          disconnectKeydown = listen(value.overlay.surface, "keydown", handleKeydown);
        }}
        onOpenChange={(open) => {
          if (open) {
            // Native picker bridges mount their own roots in the preceding microtask.
            queueMicrotask(focusInitialControl);
          } else {
            props.onClose(false);
          }
        }}
      >
        <div class="sidebar-session-filter-panel__grabber" aria-hidden="true" />
        {props.content}
      </Popover>
    </openclaw-sidebar-session-filter-popover>
  );
}
