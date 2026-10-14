/** JSDOM native-popover fixture; browser suites own positioning, timing, and light dismissal. */
export function installPopoverPolyfill(): () => void {
  if (typeof HTMLElement === "undefined" || "showPopover" in HTMLElement.prototype) {
    return () => {};
  }
  const methods = ["popover", "showPopover", "hidePopover", "togglePopover"] as const;
  const descriptors = new Map(
    methods.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]),
  );
  const matchesDescriptor: TypedPropertyDescriptor<Element["matches"]> =
    Object.getOwnPropertyDescriptor(Element.prototype, "matches")!;
  const matches = matchesDescriptor.value!;
  const opened = new WeakSet<Element>();
  const toggle = (element: HTMLElement, open: boolean) => {
    // Removing a native popover (or its attribute) already closes it.
    if (!open && (!element.isConnected || !element.hasAttribute("popover"))) {
      opened.delete(element);
      return;
    }
    if (opened.has(element) === open) {
      return;
    }
    if (!element.isConnected || !element.hasAttribute("popover")) {
      throw new DOMException(
        "Popover must be connected and have a popover attribute",
        "InvalidStateError",
      );
    }
    const oldState = opened.has(element) ? "open" : "closed";
    const newState = open ? "open" : "closed";
    const event = (type: string, cancelable = false) => {
      const result = new Event(type, { cancelable });
      Object.defineProperties(result, {
        oldState: { value: oldState },
        newState: { value: newState },
      });
      return result;
    };
    if (!element.dispatchEvent(event("beforetoggle", open))) {
      return;
    }
    if (open) {
      opened.add(element);
    } else {
      opened.delete(element);
    }
    element.dispatchEvent(event("toggle"));
  };
  Object.defineProperty(Element.prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: Element, selector: string) {
      if (selector === ":popover-open") {
        if (!this.isConnected || !this.hasAttribute("popover")) {
          opened.delete(this);
          return false;
        }
        return opened.has(this);
      }
      return matches.call(this, selector);
    },
  });
  Object.defineProperties(HTMLElement.prototype, {
    popover: {
      configurable: true,
      get(this: HTMLElement) {
        const value = this.getAttribute("popover");
        return value === null || value === "manual" || value === "hint" ? value : "auto";
      },
      set(this: HTMLElement, value: string | null) {
        if (value === null) {
          this.removeAttribute("popover");
        } else {
          this.setAttribute("popover", value);
        }
      },
    },
    showPopover: {
      configurable: true,
      writable: true,
      value(this: HTMLElement) {
        toggle(this, true);
      },
    },
    hidePopover: {
      configurable: true,
      writable: true,
      value(this: HTMLElement) {
        toggle(this, false);
      },
    },
    togglePopover: {
      configurable: true,
      value(this: HTMLElement, options?: boolean | { force?: boolean }) {
        toggle(
          this,
          (typeof options === "boolean" ? options : options?.force) ?? !opened.has(this),
        );
        return opened.has(this);
      },
    },
  });
  return () => {
    Object.defineProperty(Element.prototype, "matches", matchesDescriptor);
    for (const name of methods) {
      const descriptor = descriptors.get(name);
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, name, descriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, name);
      }
    }
  };
}
