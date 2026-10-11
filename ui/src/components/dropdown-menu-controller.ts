import type { ReactiveController, ReactiveControllerHost } from "lit";
import { consumeTooltipEscape } from "./tooltip.ts";
import { trackDropdownKeyboardDismissal } from "./web-awesome.ts";

type DropdownMenuOptions = {
  getTrigger: () => HTMLElement | null;
  onClose: () => void;
  onKeydown?: (event: KeyboardEvent) => void;
};

/** The menu lifetime owns keyboard dismissal and initial focus in both renderers. */
export function connectDropdownMenu(
  host: HTMLElement,
  options: DropdownMenuOptions,
  whenUpdated: () => Promise<unknown>,
): () => void {
  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || consumeTooltipEscape(event, host.ownerDocument)) {
      return;
    }
    options.onKeydown?.(event);
    if (event.defaultPrevented) {
      return;
    }
    if (event.key !== "Escape") {
      // Only menu items need the durable trigger before Web Awesome dismisses them.
      if (
        event.key === "Tab" &&
        event
          .composedPath()
          .some(
            (target) =>
              target instanceof Element &&
              target.localName === "wa-dropdown-item" &&
              host.contains(target),
          )
      ) {
        trackDropdownKeyboardDismissal(event, () => options.getTrigger()?.focus());
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    options.getTrigger()?.focus();
    options.onClose();
  };
  host.ownerDocument.addEventListener("keydown", handleDocumentKeydown, true);
  void (async () => {
    await whenUpdated();
    const dropdown = host.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "wa-dropdown",
    );
    await dropdown?.updateComplete;
    if (host.isConnected) {
      host.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])")?.focus();
    }
  })();
  return () => {
    host.ownerDocument.removeEventListener("keydown", handleDocumentKeydown, true);
  };
}

export class DropdownMenuController implements ReactiveController {
  private disconnect?: () => void;
  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly options: DropdownMenuOptions,
  ) {
    host.addController(this);
  }
  hostConnected() {
    this.disconnect = connectDropdownMenu(this.host, this.options, () => this.host.updateComplete);
  }
  hostDisconnected() {
    this.disconnect?.();
    this.disconnect = undefined;
  }
}
