import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createOverlayAnchor, type OverlayAnchorBinding } from "./overlay-anchor.ts";
import { createOverlay, type Overlay } from "./overlay-lifecycle.ts";

const owners: Overlay[] = [];
const bindings: OverlayAnchorBinding[] = [];
const nodes: Element[] = [];
let nextId = 0;
const originalViewport = { width: window.innerWidth, height: window.innerHeight };

beforeEach(async () => {
  await page.viewport(900, 700);
});

afterEach(async () => {
  owners.splice(0).forEach((owner) => owner.dispose());
  bindings.splice(0).forEach((binding) => binding.dispose());
  nodes.splice(0).forEach((node) => node.remove());
  await page.viewport(originalViewport.width, originalViewport.height);
});

function shadow(mode: ShadowRootMode) {
  const host = document.createElement("div");
  host.style.cssText =
    "position:absolute;left:120px;top:100px;width:500px;height:400px;transform:translate(45px,30px) scale(.85);";
  document.body.append(host);
  nodes.push(host);
  return host.attachShadow({ mode });
}

function anchor(root: ParentNode, svg = false) {
  const element = svg
    ? document.createElementNS("http://www.w3.org/2000/svg", "svg")
    : document.createElement("button");
  element.style.cssText =
    "position:absolute;left:140px;top:110px;width:90px;height:30px;margin:0;padding:0;border:0;anchor-name:--author-anchor;";
  root.append(element);
  nodes.push(element);
  return element;
}

function popup(root: ParentNode) {
  const surface = document.createElement("div");
  surface.popover = "manual";
  surface.style.cssText =
    "position:fixed;inset:auto;position-anchor:auto;position-area:bottom;margin:6px 0 0;padding:0;border:0;width:120px;height:40px;";
  root.append(surface);
  nodes.push(surface);
  const owner = createOverlay(`anchor-proof-${++nextId}`);
  owner.bindSurface(surface);
  owners.push(owner);
  const binding = createOverlayAnchor(surface);
  bindings.push(binding);
  return { surface, owner, binding };
}

async function open(owner: Overlay) {
  const settled = new Promise<void>((resolve) => {
    owner.surface.addEventListener("overlay-after-show", () => resolve(), { once: true });
  });
  expect(owner.request(true)).toBe(true);
  await settled;
}

function frame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function expectAnchored(surface: HTMLElement, element: Element) {
  const source = element.getBoundingClientRect();
  const target = surface.getBoundingClientRect();
  expect(target.width).toBeGreaterThan(0);
  expect(target.height).toBeGreaterThan(0);
  expect(Math.abs(target.x + target.width / 2 - source.x - source.width / 2)).toBeLessThan(1);
  expect(Math.abs(target.top - source.bottom - 6)).toBeLessThan(1);
}

function spatialSource(surface: HTMLElement) {
  const root = surface.getRootNode();
  const container = root instanceof ShadowRoot ? root : document;
  const source = container.querySelector<HTMLElement>('span[popover="manual"][aria-hidden="true"]');
  if (!source) {
    throw new Error("Expected the active spatial anchor");
  }
  return source;
}

describe("native cross-root anchor geometry", () => {
  it.each([
    { direction: "shadow-anchor", svg: false, mode: "open" },
    { direction: "shadow-anchor", svg: true, mode: "open" },
    { direction: "shadow-surface", svg: false, mode: "open" },
    { direction: "shadow-surface", svg: true, mode: "open" },
    { direction: "shadow-anchor", svg: false, mode: "closed" },
    { direction: "shadow-anchor", svg: true, mode: "closed" },
    { direction: "shadow-surface", svg: false, mode: "closed" },
    { direction: "shadow-surface", svg: true, mode: "closed" },
  ] as const)(
    "positions $direction svg=$svg in a transformed $mode shadow tree",
    async ({ direction, svg, mode }) => {
      const root = shadow(mode);
      const element = anchor(direction === "shadow-anchor" ? root : document.body, svg);
      const current = popup(direction === "shadow-surface" ? root : document.body);
      current.binding.update(element, "bottom");
      await open(current.owner);
      expectAnchored(current.surface, element);
      const source = spatialSource(current.surface);
      expect(source.getRootNode()).toBe(current.surface.getRootNode());
      expect(source.matches(":popover-open")).toBe(true);
      element.style.left = "240px";
      await frame();
      expectAnchored(current.surface, element);
      const hidden = new Promise<void>((resolve) => {
        current.surface.addEventListener("overlay-after-hide", () => resolve(), { once: true });
      });
      current.owner.request(false);
      await hidden;
      expect(source.matches(":popover-open")).toBe(false);
      const left = source.style.left;
      element.style.left = "340px";
      await frame();
      expect(source.style.left).toBe(left);
      current.binding.dispose();
      expect(source.isConnected).toBe(false);
      expect(element.style.getPropertyValue("anchor-name")).toBe("--author-anchor");
      expect(current.surface.style.getPropertyValue("position-anchor")).toBe("auto");
    },
  );

  it("reanchors an open surface from named HTML to cross-root SVG without a new opening", async () => {
    const first = anchor(document.body);
    const second = anchor(shadow("closed"), true);
    const current = popup(document.body);
    current.binding.update(first, "bottom");
    let shown = 0;
    current.surface.addEventListener("overlay-after-show", () => shown++);
    await open(current.owner);
    const source = spatialSource(current.surface);
    expect(current.surface.style.getPropertyValue("position-anchor")).not.toBe("auto");
    expectAnchored(current.surface, first);
    current.binding.update(second, "bottom");
    expect(spatialSource(current.surface)).toBe(source);
    expect(current.surface.style.getPropertyValue("position-anchor")).toBe(
      source.style.getPropertyValue("anchor-name"),
    );
    expectAnchored(current.surface, second);
    expect(current.owner.open).toBe(true);
    expect(current.owner.phase).toBe("open");
    expect(shown).toBe(1);
    expect(first.style.getPropertyValue("anchor-name")).toBe("--author-anchor");
  });

  it("paints and delivers a real click with an invisible spatial proxy and SVG anchor", async () => {
    const element = anchor(shadow("closed"), true);
    const current = popup(document.body);
    const action = document.createElement("button");
    action.textContent = "Activate anchored action";
    let clicks = 0;
    action.addEventListener("click", () => clicks++);
    current.surface.append(action);
    current.binding.update(element, "bottom");
    await open(current.owner);
    expectAnchored(current.surface, element);
    const box = action.getBoundingClientRect();
    expect(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)).toBe(action);
    await userEvent.click(action);
    expect(clicks).toBe(1);
    expect(current.owner.open).toBe(true);
  });

  it("keeps native Tab entry and exit tied to the real invoker across shadow roots", async () => {
    const trigger = document.createElement("input");
    const next = document.createElement("input");
    document.body.append(trigger, next);
    nodes.push(trigger, next);
    const current = popup(shadow("closed"));
    const input = document.createElement("input");
    current.surface.append(input);
    current.owner.bindTrigger(trigger);
    current.binding.update(trigger);
    await open(current.owner);
    trigger.focus();
    await userEvent.keyboard("{Tab}");
    expect(current.surface.getRootNode()).toBe(input.getRootNode());
    expect((input.getRootNode() as ShadowRoot).activeElement).toBe(input);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(next);
  });

  it.each(["proposal", "native"] as const)("cleans up a %s opening veto", (veto) => {
    const current = popup(shadow("closed"));
    current.binding.update(anchor(document.body));
    current.surface.addEventListener(
      veto === "proposal" ? "overlay-show" : "beforetoggle",
      (event) => event.preventDefault(),
    );
    expect(current.owner.request(true)).toBe(false);
    expect(current.owner.open).toBe(false);
    expect(current.owner.phase).toBe("hidden");
    const root = current.surface.getRootNode() as ShadowRoot;
    expect(root.querySelector(":popover-open")).toBeNull();
    if (veto === "proposal") {
      expect(root.querySelector('[aria-hidden="true"]')).toBeNull();
    }
  });

  it("retains its spatial anchor through a held closing animation and disposes it on teardown", async () => {
    const current = popup(shadow("closed"));
    const element = anchor(document.body);
    current.binding.update(element, "bottom");
    await open(current.owner);
    const source = spatialSource(current.surface);
    const animation = current.surface.animate({ opacity: [1, 0] }, { duration: 60_000 });
    animation.pause();
    try {
      expect(current.owner.request(false)).toBe(true);
      await frame();
      expect(current.owner.open).toBe(false);
      expect(current.owner.phase).toBe("closing");
      expect(current.surface.inert).toBe(true);
      expect(current.surface.matches(":popover-open")).toBe(true);
      expect(source.matches(":popover-open")).toBe(true);
      expectAnchored(current.surface, element);
      current.owner.dispose();
      expect(source.matches(":popover-open")).toBe(false);
      expect(current.surface.matches(":popover-open")).toBe(false);
      current.binding.dispose();
      expect(source.isConnected).toBe(false);
    } finally {
      animation.cancel();
    }
  });
});
