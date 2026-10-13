import { nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ChildPart } from "lit/directive.js";
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

class LazyDropdownContent extends AsyncDirective {
  private dropdown: HTMLElement | undefined;
  private content: (() => unknown) | undefined;
  private opened = false;

  override render(content: () => unknown) {
    this.content = content;
    return this.opened ? content() : nothing;
  }

  override update(part: ChildPart, [content]: [() => unknown]) {
    if (!this.dropdown) {
      const dropdown = part.parentNode;
      if (!(dropdown instanceof HTMLElement) || dropdown.localName !== "wa-dropdown") {
        throw new Error("Lazy dropdown content must be a direct child of wa-dropdown");
      }
      this.dropdown = dropdown;
      this.dropdown.addEventListener("wa-show", this.show);
    }
    return this.render(content);
  }

  private readonly show = (event: Event) => {
    if (event.target !== this.dropdown || this.opened) {
      return;
    }
    this.opened = true;
    // Commit before Web Awesome measures the popup and chooses its initial focus.
    this.setValue(this.content?.());
  };

  override disconnected() {
    this.dropdown?.removeEventListener("wa-show", this.show);
  }

  override reconnected() {
    this.dropdown?.addEventListener("wa-show", this.show);
  }
}

export const lazyDropdownContent = directive(LazyDropdownContent);
