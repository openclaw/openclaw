import type { ReactiveController, ReactiveControllerHost } from "lit";
import { consumeTooltipEscape } from "./tooltip.ts";
import { trackDropdownKeyboardDismissal } from "./web-awesome.ts";

type DropdownMenuHost = ReactiveControllerHost & HTMLElement;

export class DropdownMenuController implements ReactiveController {
  constructor(
    private readonly host: DropdownMenuHost,
    private readonly options: {
      getTrigger: () => HTMLElement | null;
      onClose: () => void;
      onKeydown?: (event: KeyboardEvent) => void;
    },
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    void this.focusFirstItem();
  }

  hostDisconnected(): void {
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || consumeTooltipEscape(event, this.host.ownerDocument)) {
      return;
    }
    this.options.onKeydown?.(event);
    if (event.defaultPrevented) {
      return;
    }
    if (event.key !== "Escape") {
      // Nested dialogs and outside targets own their own Tab order; only menu
      // items need the durable trigger before Web Awesome dismisses them.
      if (
        event.key === "Tab" &&
        event
          .composedPath()
          .some(
            (target) =>
              target instanceof Element &&
              target.localName === "wa-dropdown-item" &&
              this.host.contains(target),
          )
      ) {
        trackDropdownKeyboardDismissal(event, () => this.options.getTrigger()?.focus());
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.options.getTrigger()?.focus();
    this.options.onClose();
  };

  private async focusFirstItem(): Promise<void> {
    await this.host.updateComplete;
    const dropdown = this.host.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "wa-dropdown",
    );
    await dropdown?.updateComplete;
    if (this.host.isConnected) {
      this.host.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])")?.focus();
    }
  }
}
