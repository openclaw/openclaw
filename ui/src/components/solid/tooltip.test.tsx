/* @vitest-environment jsdom */
import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { type ComponentProps, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Tooltip, type TooltipElement } from "./tooltip.tsx";

const extraNodes: Element[] = [];
beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  cleanup();
  extraNodes.splice(0).forEach((node) => node.remove());
  vi.useRealTimers();
});

function pointer(target: Element, type: "pointerenter" | "pointerleave" | "pointerdown") {
  const event = new MouseEvent(type, { bubbles: true, composed: true });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

function shadowFixture(mode: ShadowRootMode = "closed") {
  const rootHost = document.createElement("section");
  const shadow = rootHost.attachShadow({ mode });
  const container = shadow.appendChild(document.createElement("div"));
  document.body.append(rootHost);
  extraNodes.push(rootHost);
  return { shadow, container };
}

const describedBy = (trigger: Element) => trigger.getAttribute("aria-describedby");

function refocus(host: TooltipElement, trigger: HTMLElement) {
  trigger.blur();
  trigger.focus();
  flush();
  expect(host.hasAttribute("open")).toBe(true);
}

function fixture(
  props: Omit<ComponentProps<typeof Tooltip>, "children"> & { children?: () => JSX.Element } = {},
  container?: HTMLElement,
) {
  const view = render(
    () => (
      <Tooltip content="Action details" {...props}>
        {props.children ? props.children() : <button type="button">Trigger</button>}
      </Tooltip>
    ),
    container ? { container } : undefined,
  );
  flush();
  const host = view.container.querySelector("openclaw-tooltip")!;
  const trigger = host.querySelector<HTMLButtonElement>(":scope > button")!;
  const surface = host.shadowRoot!.querySelector<HTMLElement>(".tooltip-surface")!;
  return { view, host, trigger, surface };
}

async function settle(host: TooltipElement) {
  await host.updateComplete;
  flush();
}

async function focus(host: TooltipElement, trigger: HTMLElement) {
  trigger.focus();
  await settle(host);
  expect(host.hasAttribute("open")).toBe(true);
}

function escape(target: Element) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

it.each([false, true])(
  "rebinds replaced triggers and descriptions (wrapped=%s)",
  async (wrapped) => {
    const [replacement, setReplacement] = createSignal(false);
    let descriptionTarget!: HTMLButtonElement;
    const buttons = () => (
      <>
        {replacement() ? (
          <button
            ref={(element) => (descriptionTarget = element)}
            aria-describedby={wrapped ? "new-description" : undefined}
          >
            New
          </button>
        ) : (
          <button
            ref={(element) => (descriptionTarget = element)}
            aria-describedby={wrapped ? "old-description" : undefined}
          >
            Old
          </button>
        )}
      </>
    );
    const { view, host, surface } = fixture({
      descriptionTarget: wrapped ? () => descriptionTarget : undefined,
      children: () => (
        <>
          {wrapped ? (
            <span>
              <button type="button" aria-describedby="other-description">
                Other
              </button>
              {buttons()}
            </span>
          ) : (
            buttons()
          )}
        </>
      ),
    });
    const events: Event[] = [];
    for (const type of ["overlay-show", "overlay-hide"]) {
      view.container.addEventListener(type, (event) => events.push(event), { capture: true });
    }
    const oldTrigger = descriptionTarget;
    if (wrapped) {
      expect(host.querySelector("button")?.getAttribute("aria-describedby")).toBe(
        "other-description",
      );
    }
    expect(host).toBeInstanceOf(Tooltip.Element);
    expect(document.getElementById(describedBy(oldTrigger)!.split(" ").at(-1)!)?.textContent).toBe(
      "Action details",
    );
    expect(surface.querySelector(".tooltip-content")).toBeNull();
    expect(describedBy(oldTrigger)).toContain(
      wrapped ? "old-description openclaw-tooltip-" : "openclaw-tooltip-",
    );
    await focus(host, oldTrigger);
    setReplacement(true);
    flush();
    await Promise.resolve();
    const newTrigger = descriptionTarget;
    expect(newTrigger).not.toBe(oldTrigger);
    expect(describedBy(oldTrigger)).toBe(wrapped ? "old-description" : null);
    expect(describedBy(newTrigger)).toContain(
      wrapped ? "new-description openclaw-tooltip-" : "openclaw-tooltip-",
    );
    const descriptionId = describedBy(newTrigger);
    expect(host.hasAttribute("open")).toBe(false);
    pointer(newTrigger, "pointerenter");
    vi.advanceTimersByTime(149);
    expect(host.hasAttribute("open")).toBe(false);
    vi.advanceTimersByTime(1);
    await settle(host);
    expect(host.hasAttribute("open")).toBe(true);
    expect(surface.matches(":popover-open")).toBe(true);
    expect(surface.querySelector(".tooltip-content")?.textContent).toBe("Action details");
    expect(describedBy(newTrigger)).toBe(descriptionId);
    pointer(newTrigger, "pointerdown");
    expect(events.map(({ type, target, composed }) => [type, target, composed])).toEqual(
      ["show", "hide", "show", "hide"].map((type) => [`overlay-${type}`, host, true]),
    );
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
    view.unmount();
    expect(describedBy(newTrigger)).toBe(wrapped ? "new-description" : null);
  },
);

it.each(["document", "shadow", "svg"] as const)(
  "keeps external %s anchor descriptions and interaction ownership",
  async (kind) => {
    const { shadow, container } = shadowFixture();
    const isSvg = kind === "svg";
    const anchor = isSvg
      ? document.createElementNS("http://www.w3.org/2000/svg", "rect")
      : document.createElement("button");
    const anchorRoot = kind === "document" ? document : shadow;
    (kind === "document" ? shadow : document.body).append(container);
    if (isSvg) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.append(anchor);
      shadow.append(svg);
    } else {
      (kind === "document" ? document.body : shadow).append(anchor);
    }
    extraNodes.push(container, anchor);
    const { view, host: controller } = fixture(
      { content: "", children: () => null, openOnClick: isSvg },
      container,
    );
    controller.previewForAnchor(anchor, "External details", isSvg ? "pointer" : "focus");
    if (isSvg) {
      await controller.updateComplete;
      vi.advanceTimersByTime(150);
    }
    await settle(controller);
    const id = anchor.getAttribute("aria-describedby")!;
    expect(anchorRoot.getElementById(id)?.textContent).toBe("External details");
    expect(controller.hasAttribute("open")).toBe(true);
    if (isSvg) {
      pointer(anchor, "pointerdown");
      expect(controller.hasAttribute("open")).toBe(true);
      pointer(view.container, "pointerdown");
      expect(controller.hasAttribute("open")).toBe(false);
    }
    view.unmount();
    expect(anchorRoot.getElementById(id)).toBeNull();
    expect(anchor.hasAttribute("aria-describedby")).toBe(false);
  },
);

it("preserves an existing description while description ownership is disabled", () => {
  const { view, trigger } = fixture({
    describe: false,
    children: () => <button aria-describedby="existing-description">Trigger</button>,
  });
  expect(describedBy(trigger)).toBe("existing-description");
  view.unmount();
  expect(describedBy(trigger)).toBe("existing-description");
});

it("does not install dismissal ownership or displace the open tooltip after a veto", async () => {
  const first = fixture();
  await focus(first.host, first.trigger);
  const second = fixture();
  second.host.addEventListener("overlay-show", (event) => event.preventDefault());
  pointer(second.trigger, "pointerenter");
  vi.advanceTimersByTime(150);
  await settle(second.host);
  expect(first.host.hasAttribute("open")).toBe(true);
  expect(second.host.hasAttribute("open")).toBe(false);
  expect(second.surface.matches(":popover-open")).toBe(false);
  expect(escape(first.trigger).defaultPrevented).toBe(true);
  expect(first.host.hasAttribute("open")).toBe(false);
});

it.each(["hidden", "inert", "aria-hidden"])(
  "retires an open tooltip when its trigger ancestry becomes %s",
  async (attribute) => {
    const { view, host, trigger, surface } = fixture();
    await focus(host, trigger);
    view.container.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
    await Promise.resolve();
    expect(host.hasAttribute("open")).toBe(false);
    expect(surface.matches(":popover-open")).toBe(false);
    view.container.removeAttribute(attribute);
    await Promise.resolve();
    expect(host.hasAttribute("open")).toBe(false);
    refocus(host, trigger);
  },
);

it.each(["open", "closed"] as const)(
  "keeps rich controls interactive inside a shadow root (mode=%s)",
  async (mode) => {
    const { shadow, container } = shadowFixture(mode);
    const outside = document.body.appendChild(document.createElement("button"));
    extraNodes.push(outside);
    const activate = vi.fn();
    let trigger!: HTMLButtonElement;
    const { host } = fixture(
      {
        descriptionTarget: () => trigger,
        children: () => (
          <>
            <span>
              <button ref={(element) => (trigger = element)} type="button">
                Trigger
              </button>
            </span>
            <span slot="content">
              <button onClick={activate}>Tooltip action</button>
            </span>
          </>
        ),
      },
      container,
    );
    const action = host.querySelector<HTMLButtonElement>('[slot="content"] button')!;
    expect(trigger.parentElement?.parentElement).toBe(host);
    await focus(host, trigger);
    pointer(action, "pointerdown");
    expect(host.hasAttribute("open")).toBe(true);
    action.click();
    expect(activate).toHaveBeenCalledTimes(1);
    action.focus();
    expect(shadow.activeElement).toBe(action);
    expect(host.hasAttribute("open")).toBe(true);
    const veto = (event: Event) => event.preventDefault();
    host.addEventListener("overlay-hide", veto);
    escape(action);
    expect(shadow.activeElement).toBe(action);
    expect(host.hasAttribute("open")).toBe(true);
    host.removeEventListener("overlay-hide", veto);
    escape(action);
    expect(shadow.activeElement).toBe(trigger);
    expect(host.hasAttribute("open")).toBe(false);
    refocus(host, trigger);
    pointer(outside, "pointerdown");
    expect(host.hasAttribute("open")).toBe(false);
    refocus(host, trigger);
    outside.focus();
    expect(host.hasAttribute("open")).toBe(false);
  },
);
