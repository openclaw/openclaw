/* @vitest-environment jsdom */
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip, type TooltipElement } from "./tooltip.tsx";

let open: WeakSet<Element>;
let restorePopover: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  open = new WeakSet();
  // oxlint-disable-next-line typescript/unbound-method -- The DOM intrinsic is called below with its explicit element receiver.
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (selector) {
    return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
  });
  const show = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
  const hide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidePopover");
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: {
      configurable: true,
      value() {
        open.add(this);
      },
    },
    hidePopover: {
      configurable: true,
      value() {
        open.delete(this);
      },
    },
  });
  restorePopover = () => {
    if (show) {
      Object.defineProperty(HTMLElement.prototype, "showPopover", show);
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
    }
    if (hide) {
      Object.defineProperty(HTMLElement.prototype, "hidePopover", hide);
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
    }
  };
});

afterEach(() => {
  cleanup();
  restorePopover();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pointer(target: Element, type: "pointerenter" | "pointerleave" | "pointerdown") {
  const event = new MouseEvent(type, { bubbles: true, composed: true });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

function fixture(rich = false) {
  const view = render(() => (
    <Tooltip content="Action details">
      <button type="button">Trigger</button>
      {rich ? (
        <span slot="content">
          <button type="button">Tooltip action</button>
        </span>
      ) : undefined}
    </Tooltip>
  ));
  flush();
  const host = view.container.querySelector("openclaw-tooltip")!;
  const trigger = host.querySelector<HTMLButtonElement>(":scope > button")!;
  const surface = host.shadowRoot!.querySelector<HTMLElement>(".tooltip-surface")!;
  return { view, host, trigger, surface };
}

describe("Solid tooltip policy", () => {
  it("mounts the plain host before policy setup and keeps descriptions outside lazy content", async () => {
    const { host, trigger, surface } = fixture();
    expect(host).toBeInstanceOf(Tooltip.Element);
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
    const description = document.getElementById(trigger.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe("Action details");
    expect(surface.querySelector(".tooltip-content")).toBeNull();
    pointer(trigger, "pointerenter");
    vi.advanceTimersByTime(149);
    expect(host.hasAttribute("open")).toBe(false);
    vi.advanceTimersByTime(1);
    await host.updateComplete;
    flush();
    expect(open.has(surface)).toBe(true);
    expect(surface.querySelector(".tooltip-content")?.textContent).toBe("Action details");
    expect(trigger.getAttribute("aria-describedby")).toBe(description?.id);
  });

  it("rebinds a replaced trigger without changing tooltip props", async () => {
    const [replacement, setReplacement] = createSignal(false);
    const view = render(() => (
      <Tooltip content="Action details">
        {replacement() ? (
          <button type="button">New trigger</button>
        ) : (
          <button type="button">Old trigger</button>
        )}
      </Tooltip>
    ));
    flush();
    const host = view.container.querySelector("openclaw-tooltip")!;
    const oldTrigger = host.querySelector("button")!;
    oldTrigger.focus();
    flush();
    expect(host.hasAttribute("open")).toBe(true);
    setReplacement(true);
    flush();
    await Promise.resolve();
    const newTrigger = host.querySelector("button")!;
    expect(newTrigger).not.toBe(oldTrigger);
    expect(oldTrigger.hasAttribute("aria-describedby")).toBe(false);
    expect(newTrigger.getAttribute("aria-describedby")).toBeTruthy();
    expect(host.hasAttribute("open")).toBe(false);
    pointer(newTrigger, "pointerenter");
    vi.advanceTimersByTime(150);
    flush();
    expect(host.hasAttribute("open")).toBe(true);
    pointer(newTrigger, "pointerdown");
    view.container.append(oldTrigger);
    pointer(oldTrigger, "pointerenter");
    vi.advanceTimersByTime(150);
    expect(host.hasAttribute("open")).toBe(false);
    newTrigger.focus();
    flush();
    expect(host.hasAttribute("open")).toBe(true);
    pointer(newTrigger, "pointerdown");
    oldTrigger.focus();
    expect(host.hasAttribute("open")).toBe(false);
  });

  it("accepts an external title anchor through the imperative preview contract", async () => {
    let controller!: TooltipElement;
    const view = render(() => (
      <>
        <button type="button">External</button>
        <Tooltip
          ref={(value) => {
            controller = value;
          }}
        />
      </>
    ));
    flush();
    const anchor = view.container.querySelector("button")!;
    controller.previewForAnchor(anchor, "External details", "focus");
    await controller.updateComplete;
    flush();
    const host = view.container.querySelector("openclaw-tooltip")!;
    expect(host.hasAttribute("open")).toBe(true);
    expect(host.shadowRoot!.querySelector(".tooltip-content")?.textContent).toBe(
      "External details",
    );
    expect(document.getElementById(anchor.getAttribute("aria-describedby")!)?.textContent).toBe(
      "External details",
    );
  });

  it.each([false, true])(
    "places external descriptions in the anchor tree (tooltipInShadow=%s)",
    async (tooltipInShadow) => {
      const rootHost = document.createElement("section");
      const shadow = rootHost.attachShadow({ mode: "closed" });
      const container = document.createElement("div");
      const anchor = document.createElement("button");
      anchor.textContent = "External";
      const anchorRoot = tooltipInShadow ? document : shadow;
      document.body.append(rootHost);
      (tooltipInShadow ? shadow : document.body).append(container);
      (tooltipInShadow ? document.body : shadow).append(anchor);
      let controller!: TooltipElement;
      const view = render(
        () => (
          <Tooltip
            ref={(value) => {
              controller = value;
            }}
          />
        ),
        { container },
      );
      try {
        flush();
        controller.previewForAnchor(anchor, "External details", "focus");
        await controller.updateComplete;
        flush();
        const id = anchor.getAttribute("aria-describedby")!;
        expect(anchorRoot.getElementById(id)?.textContent).toBe("External details");
        expect(view.container.querySelector("openclaw-tooltip")?.hasAttribute("open")).toBe(true);
        view.unmount();
        expect(anchorRoot.getElementById(id)).toBeNull();
        expect(anchor.hasAttribute("aria-describedby")).toBe(false);
      } finally {
        anchor.remove();
        rootHost.remove();
        container.remove();
      }
    },
  );

  it("retains an external SVG anchor's closed-root interaction ownership", async () => {
    const rootHost = document.createElement("section");
    const shadow = rootHost.attachShadow({ mode: "closed" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const anchor = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    anchor.setAttribute("aria-label", "Requests");
    svg.append(anchor);
    shadow.append(svg);
    document.body.append(rootHost);
    let controller!: TooltipElement;
    const view = render(() => (
      <Tooltip
        openOnClick
        ref={(value) => {
          controller = value;
        }}
      />
    ));
    try {
      flush();
      controller.previewForAnchor(anchor, "Request details", "pointer");
      await controller.updateComplete;
      vi.advanceTimersByTime(150);
      flush();
      const host = view.container.querySelector("openclaw-tooltip")!;
      expect(host.hasAttribute("open")).toBe(true);
      expect(shadow.getElementById(anchor.getAttribute("aria-describedby")!)?.textContent).toBe(
        "Request details",
      );
      pointer(anchor, "pointerdown");
      expect(host.hasAttribute("open")).toBe(true);
      pointer(view.container, "pointerdown");
      expect(host.hasAttribute("open")).toBe(false);
    } finally {
      rootHost.remove();
    }
  });

  it("preserves an existing description while description ownership is disabled", () => {
    const view = render(() => (
      <Tooltip content="Details" describe={false}>
        <button type="button" aria-describedby="existing-description">
          Trigger
        </button>
      </Tooltip>
    ));
    flush();
    const trigger = view.container.querySelector("button")!;
    expect(trigger.getAttribute("aria-describedby")).toBe("existing-description");
    view.unmount();
    expect(trigger.getAttribute("aria-describedby")).toBe("existing-description");
  });

  it("recaptures description ownership when a wrapper's focusable descendant changes", async () => {
    const [replacement, setReplacement] = createSignal(false);
    const view = render(() => (
      <Tooltip content="Details">
        <span>
          {replacement() ? (
            <button type="button" aria-describedby="new-description">
              New
            </button>
          ) : (
            <button type="button" aria-describedby="old-description">
              Old
            </button>
          )}
        </span>
      </Tooltip>
    ));
    flush();
    const oldTrigger = view.container.querySelector("button")!;
    expect(oldTrigger.getAttribute("aria-describedby")).toContain(
      "old-description openclaw-tooltip-",
    );
    setReplacement(true);
    flush();
    await Promise.resolve();
    const newTrigger = view.container.querySelector("button")!;
    expect(oldTrigger.getAttribute("aria-describedby")).toBe("old-description");
    expect(newTrigger.getAttribute("aria-describedby")).toContain(
      "new-description openclaw-tooltip-",
    );
    view.unmount();
    expect(newTrigger.getAttribute("aria-describedby")).toBe("new-description");
  });

  it("does not install dismissal ownership or displace the open tooltip after a veto", () => {
    const first = fixture();
    first.trigger.focus();
    flush();
    expect(first.host.hasAttribute("open")).toBe(true);
    const second = fixture();
    second.host.addEventListener("wa-show", (event) => event.preventDefault());
    pointer(second.trigger, "pointerenter");
    vi.advanceTimersByTime(150);
    flush();
    expect(first.host.hasAttribute("open")).toBe(true);
    expect(second.host.hasAttribute("open")).toBe(false);
    expect(open.has(second.surface)).toBe(false);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    first.trigger.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(first.host.hasAttribute("open")).toBe(false);
  });

  it.each(["hidden", "inert", "aria-hidden"])(
    "retires an open tooltip when its trigger ancestry becomes %s",
    async (attribute) => {
      const { view, host, trigger, surface } = fixture();
      trigger.focus();
      flush();
      expect(host.hasAttribute("open")).toBe(true);
      view.container.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
      await Promise.resolve();
      expect(host.hasAttribute("open")).toBe(false);
      expect(open.has(surface)).toBe(false);
      view.container.removeAttribute(attribute);
      await Promise.resolve();
      expect(host.hasAttribute("open")).toBe(false);
      trigger.blur();
      trigger.focus();
      flush();
      expect(host.hasAttribute("open")).toBe(true);
    },
  );

  it.each(["open", "closed"] as const)(
    "keeps rich controls interactive inside a shadow root (mode=%s)",
    (mode) => {
      const rootHost = document.createElement("section");
      const outside = document.createElement("button");
      const shadow = rootHost.attachShadow({ mode });
      const container = document.createElement("div");
      shadow.append(container);
      document.body.append(rootHost, outside);
      let activations = 0;
      let trigger!: HTMLButtonElement;
      let action!: HTMLButtonElement;
      const view = render(
        () => (
          <Tooltip content="Action details">
            <button
              ref={(element) => {
                trigger = element;
              }}
              type="button"
            >
              Trigger
            </button>
            <span slot="content">
              <button
                ref={(element) => {
                  action = element;
                }}
                type="button"
                onClick={() => {
                  activations += 1;
                }}
              >
                Tooltip action
              </button>
            </span>
          </Tooltip>
        ),
        { container },
      );
      try {
        flush();
        const host = view.container.querySelector("openclaw-tooltip")!;
        expect(trigger.parentElement).toBe(host);
        expect(action.closest('[slot="content"]')).not.toBeNull();
        trigger.focus();
        flush();
        expect(host.hasAttribute("open")).toBe(true);
        pointer(action, "pointerdown");
        expect(host.hasAttribute("open")).toBe(true);
        action.click();
        expect(activations).toBe(1);
        action.focus();
        expect(shadow.activeElement).toBe(action);
        expect(host.hasAttribute("open")).toBe(true);
        const veto = (event: Event) => event.preventDefault();
        host.addEventListener("wa-hide", veto);
        action.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
        expect(shadow.activeElement).toBe(action);
        expect(host.hasAttribute("open")).toBe(true);
        host.removeEventListener("wa-hide", veto);
        action.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
        expect(shadow.activeElement).toBe(trigger);
        expect(host.hasAttribute("open")).toBe(false);
        trigger.blur();
        trigger.focus();
        flush();
        expect(host.hasAttribute("open")).toBe(true);
        pointer(outside, "pointerdown");
        expect(host.hasAttribute("open")).toBe(false);
        trigger.blur();
        trigger.focus();
        flush();
        expect(host.hasAttribute("open")).toBe(true);
        outside.focus();
        expect(host.hasAttribute("open")).toBe(false);
      } finally {
        rootHost.remove();
        outside.remove();
      }
    },
  );

  it("preserves rich-content focus on rejected close and returns focus only after acceptance", () => {
    const { host, trigger, surface } = fixture(true);
    trigger.focus();
    flush();
    const action = host.querySelector<HTMLButtonElement>('[slot="content"] button')!;
    action.focus();
    const veto = (event: Event) => event.preventDefault();
    host.addEventListener("wa-hide", veto);
    action.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(action);
    expect(host.hasAttribute("open")).toBe(true);
    expect(surface.querySelector(".tooltip-rich-content")?.hasAttribute("inert")).toBe(false);
    host.removeEventListener("wa-hide", veto);
    action.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(trigger);
    expect(host.hasAttribute("open")).toBe(false);
    expect(surface.querySelector(".tooltip-rich-content")?.hasAttribute("inert")).toBe(true);
  });
});
