import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  createOverlayAnchor,
  hideOverlayAnchor,
  showOverlayAnchor,
  type OverlayAnchorBinding,
} from "./overlay-anchor.ts";
import { createOverlay, type Overlay } from "./overlay-lifecycle.ts";

const owners: Overlay[] = [],
  bindings: OverlayAnchorBinding[] = [],
  nodes: Element[] = [];
let nextId = 0;
const viewport = { width: window.innerWidth, height: window.innerHeight };
const triggerStyle = "position:absolute;left:140px;top:110px;width:90px;height:30px";
const surfaceStyle =
  "position:fixed;inset:auto;position-area:bottom;margin:6px 0 0;padding:0;border:0;width:120px;height:40px";
beforeEach(async () => {
  await page.viewport(900, 700);
});
afterEach(async () => {
  vi.restoreAllMocks();
  owners.splice(0).forEach((owner) => owner.dispose());
  bindings.splice(0).forEach((binding) => binding.dispose());
  nodes.splice(0).forEach((node) => node.remove());
  await page.viewport(viewport.width, viewport.height);
});
function append<K extends keyof HTMLElementTagNameMap>(root: ParentNode, tag: K) {
  const node = document.createElement(tag);
  root.append(node);
  nodes.push(node);
  return node;
}
function shadow(mode: ShadowRootMode) {
  const host = append(document.body, "div");
  host.style.cssText =
    "position:absolute;left:120px;top:100px;width:500px;height:400px;transform:translate(45px,30px) scale(.85)";
  return host.attachShadow({ mode });
}
function anchor(root: ParentNode, svg = false) {
  const element = svg
    ? document.createElementNS("http://www.w3.org/2000/svg", "svg")
    : document.createElement("button");
  element.style.cssText = `${triggerStyle};margin:0;padding:0;border:0;anchor-name:--author-anchor`;
  root.append(element);
  nodes.push(element);
  return element;
}
function bind(
  surface: HTMLElement,
  element?: HTMLElement | SVGElement,
  sameRoot = false,
  trigger?: HTMLElement,
) {
  const owner = createOverlay(`anchor-proof-${++nextId}`);
  owner.bindSurface(surface);
  if (trigger) {
    owner.bindTrigger(trigger);
  }
  owners.push(owner);
  const binding = createOverlayAnchor(surface, { sameRoot });
  bindings.push(binding);
  if (element) {
    binding.update(element, "bottom");
  }
  return { surface, owner, binding };
}
function popup(root: ParentNode, element?: HTMLElement | SVGElement) {
  const surface = append(root, "div");
  surface.popover = "manual";
  surface.style.cssText = `${surfaceStyle};position-anchor:auto`;
  return bind(surface, element);
}
const after = (surface: HTMLElement, phase: "show" | "hide") =>
  new Promise<void>((resolve) => {
    surface.addEventListener(`overlay-after-${phase}`, () => resolve(), { once: true });
  });
async function open(owner: Overlay) {
  const settled = after(owner.surface, "show");
  expect(owner.request(true)).toBe(true);
  await settled;
}
const frame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
function expectAnchored(surface: HTMLElement, element: Element) {
  const source = element.getBoundingClientRect(),
    target = surface.getBoundingClientRect();
  expect(target.width).toBeGreaterThan(0);
  expect(target.height).toBeGreaterThan(0);
  expect(Math.abs(target.x + target.width / 2 - source.x - source.width / 2)).toBeLessThan(1);
  expect(Math.abs(target.top - source.bottom - 6)).toBeLessThan(1);
}
function spatialSource(surface: HTMLElement) {
  const root = surface.getRootNode();
  const source = (root instanceof ShadowRoot ? root : document).querySelector<HTMLElement>(
    'span[popover="manual"][aria-hidden="true"]',
  );
  if (!source) {
    throw new Error("Expected the active spatial anchor");
  }
  return source;
}

it("samples frames only while the active binding crosses roots", () => {
  const local = anchor(document.body),
    remote = anchor(shadow("closed"));
  const { surface, binding } = popup(document.body);
  binding.update(local);
  const requestFrame = vi.spyOn(window, "requestAnimationFrame");
  const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
  showOverlayAnchor(surface);
  expect(requestFrame).not.toHaveBeenCalled();
  binding.update(remote);
  expect(requestFrame).toHaveBeenCalledTimes(1);
  const temporary = createOverlayAnchor(surface);
  bindings.push(temporary);
  temporary.update(local);
  expect(cancelFrame).toHaveBeenCalledTimes(1);
  temporary.dispose();
  expect(requestFrame).toHaveBeenCalledTimes(2);
  hideOverlayAnchor(surface);
  expect(cancelFrame).toHaveBeenCalledTimes(2);
});

it("stops geometry reads while a stationary anchor's ancestor animates decorative paint", async () => {
  const container = append(document.body, "div");
  const element = anchor(container);
  const { surface, owner } = popup(shadow("closed"), element);
  const animation = container.animate(
    { opacity: [0.8, 1], color: ["red", "blue"], boxShadow: ["0 0 1px red", "0 0 5px blue"] },
    { duration: 1_000, iterations: Infinity },
  );
  try {
    await open(owner);
    await frame();
    await frame();
    const read = vi.spyOn(element, "getBoundingClientRect");
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();

    element.style.left = "240.375px";
    await frame();
    expectAnchored(surface, element);
  } finally {
    animation.cancel();
  }
});

it("follows outside layout shifts and a signaled ancestor animation", async () => {
  const container = append(document.body, "div");
  container.style.cssText = "position:absolute;left:150px;top:100px";
  const spacer = append(container, "div");
  spacer.style.height = "20px";
  const element = anchor(container);
  element.style.position = "static";
  const { surface, owner } = popup(shadow("closed"), element);
  await open(owner);
  await frame();
  spacer.style.height = "80px";
  await expect
    .poll(() => {
      const source = element.getBoundingClientRect();
      const target = surface.getBoundingClientRect();
      return Math.abs(target.top - source.bottom - 6);
    })
    .toBeLessThan(1);

  container.style.willChange = "transform";
  const animation = container.animate(
    [{ transform: "translate(0, 0) scale(1)" }, { transform: "translate(40px, 20px) scale(.9)" }],
    { duration: 2_000, fill: "forwards" },
  );
  try {
    await frame();
    await frame();
    const animationReads = vi.spyOn(container, "getAnimations");
    await frame();
    await frame();
    expect(animationReads).not.toHaveBeenCalled();
    animationReads.mockRestore();
    expectAnchored(surface, element);
    animation.finish();
    await frame();
    expectAnchored(surface, element);
  } finally {
    animation.cancel();
  }
});

it("follows padding shrinkage from a stylesheet without an anchor mutation", async () => {
  const element = anchor(document.body);
  element.style.boxSizing = "content-box";
  element.classList.add("anchor-padding-proof");
  const style = append(document.head, "style");
  style.textContent = ".anchor-padding-proof { padding: 20px !important }";
  const { surface, owner } = popup(shadow("closed"), element);
  await open(owner);
  await frame();
  expectAnchored(surface, element);

  style.textContent = ".anchor-padding-proof { padding: 0 !important }";
  await expect
    .poll(() => {
      const source = element.getBoundingClientRect();
      const target = surface.getBoundingClientRect();
      return Math.abs(target.top - source.bottom - 6);
    })
    .toBeLessThan(1);
});

it.each([false, true])("opens an adopted template (same-root=%s)", async (sameRoot) => {
  const template = document.createElement("template");
  template.innerHTML =
    '<button>Open adopted menu</button><div popover="manual"><button>Adopted action</button></div>';
  const trigger = template.content.querySelector("button")!,
    surface = template.content.querySelector("div")!;
  trigger.style.cssText = triggerStyle;
  surface.style.cssText = surfaceStyle;
  const { owner, binding } = bind(surface, undefined, sameRoot, trigger);
  // Bind before adoption to exercise the template document boundary.
  binding.update(trigger, "bottom");
  document.body.append(template.content);
  nodes.push(trigger, surface);
  await open(owner);
  expectAnchored(surface, trigger);
  if (!sameRoot) {
    expect(spatialSource(surface).ownerDocument).toBe(document);
  }
  const action = surface.querySelector("button")!;
  let openOnClick = false;
  action.addEventListener("click", () => (openOnClick = owner.open));
  await userEvent.click(action);
  expect([openOnClick, owner.open]).toEqual([true, true]);
  await userEvent.click(trigger);
  expect(owner.open).toBe(true);
  const outside = append(document.body, "button");
  outside.textContent = "Outside adopted menu";
  await userEvent.click(outside);
  expect(owner.open).toBe(false);
});

it.each([
  ["shadow-anchor", false, "open"],
  ["shadow-anchor", true, "open"],
  ["shadow-surface", false, "open"],
  ["shadow-surface", true, "open"],
  ["shadow-anchor", false, "closed"],
  ["shadow-anchor", true, "closed"],
  ["shadow-surface", false, "closed"],
  ["shadow-surface", true, "closed"],
] as const)("positions %s svg=%s in a transformed %s shadow tree", async (direction, svg, mode) => {
  const root = shadow(mode);
  const element = anchor(direction === "shadow-anchor" ? root : document.body, svg);
  const { surface, owner, binding } = popup(
    direction === "shadow-surface" ? root : document.body,
    element,
  );
  await open(owner);
  expectAnchored(surface, element);
  const source = spatialSource(surface);
  expect(source.getRootNode()).toBe(surface.getRootNode());
  expect(source.matches(":popover-open")).toBe(true);
  element.style.left = "240.375px";
  element.style.top = "125.25px";
  element.style.width = "101.625px";
  element.style.height = "35.5px";
  await frame();
  expectAnchored(surface, element);
  const hidden = after(surface, "hide");
  owner.request(false);
  await hidden;
  expect(source.matches(":popover-open")).toBe(false);
  const left = source.style.left;
  element.style.left = "340.625px";
  element.style.top = "145.5px";
  element.style.width = "112.25px";
  element.style.height = "41.75px";
  await frame();
  expect(source.style.left).toBe(left);
  await open(owner);
  expectAnchored(surface, element);
  const hiddenAgain = after(surface, "hide");
  owner.request(false);
  await hiddenAgain;
  binding.dispose();
  expect(source.isConnected).toBe(false);
  expect(element.style.getPropertyValue("anchor-name")).toBe("--author-anchor");
  expect(surface.style.getPropertyValue("position-anchor")).toBe("auto");
});

it("reanchors across roots without reopening or blocking clicks", async () => {
  const first = anchor(document.body),
    second = anchor(shadow("closed"), true);
  const { surface, owner, binding } = popup(document.body, first);
  const shown = vi.fn();
  surface.addEventListener("overlay-after-show", shown);
  await open(owner);
  const source = spatialSource(surface);
  expect(surface.style.getPropertyValue("position-anchor")).not.toBe("auto");
  expectAnchored(surface, first);
  binding.update(second, "bottom");
  expect(spatialSource(surface)).toBe(source);
  expect(surface.style.getPropertyValue("position-anchor")).toBe(
    source.style.getPropertyValue("anchor-name"),
  );
  expectAnchored(surface, second);
  expect(owner).toMatchObject({ open: true, phase: "open" });
  expect(shown).toHaveBeenCalledOnce();
  expect(first.style.getPropertyValue("anchor-name")).toBe("--author-anchor");
  const action = append(surface, "button"),
    clicked = vi.fn();
  action.textContent = "Activate anchored action";
  action.addEventListener("click", clicked);
  const box = action.getBoundingClientRect();
  expect(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)).toBe(action);
  await userEvent.click(action);
  expect(clicked).toHaveBeenCalledOnce();
  expect(owner.open).toBe(true);
  document.body.append(second);
  await frame();
  expectAnchored(surface, second);
  second.style.left = "330.375px";
  await frame();
  expectAnchored(surface, second);
  expect(owner).toMatchObject({ open: true, phase: "open" });
  expect(shown).toHaveBeenCalledOnce();
});

it("keeps native Tab entry and exit tied to the real cross-root invoker", async () => {
  const trigger = append(document.body, "input"),
    next = append(document.body, "input");
  const { surface, owner, binding } = popup(shadow("closed"));
  const input = append(surface, "input");
  owner.bindTrigger(trigger);
  binding.update(trigger);
  await open(owner);
  trigger.focus();
  await userEvent.keyboard("{Tab}");
  expect(surface.getRootNode()).toBe(input.getRootNode());
  expect((input.getRootNode() as ShadowRoot).activeElement).toBe(input);
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(next);
});

it.each(["proposal", "native"])("cleans up a %s opening veto", (veto) => {
  const { surface, owner, binding } = popup(shadow("closed"));
  binding.update(anchor(document.body));
  surface.addEventListener(veto === "proposal" ? "overlay-show" : "beforetoggle", (event) =>
    event.preventDefault(),
  );
  expect(owner.request(true)).toBe(false);
  expect(owner).toMatchObject({ open: false, phase: "hidden" });
  const root = surface.getRootNode() as ShadowRoot;
  expect(root.querySelector(":popover-open")).toBeNull();
  if (veto === "proposal") {
    expect(root.querySelector('[aria-hidden="true"]')).toBeNull();
  }
});

it("retains geometry during closing and disposes the spatial anchor on teardown", async () => {
  const element = anchor(document.body);
  const { surface, owner, binding } = popup(shadow("closed"), element);
  await open(owner);
  const source = spatialSource(surface);
  const animation = surface.animate({ opacity: [1, 0] }, { duration: 60_000 });
  animation.pause();
  try {
    expect(owner.request(false)).toBe(true);
    element.style.left = "210.375px";
    element.style.top = "140.625px";
    await frame();
    expect(owner).toMatchObject({ open: false, phase: "closing" });
    expect(surface.inert).toBe(true);
    expect([surface.matches(":popover-open"), source.matches(":popover-open")]).toEqual([
      true,
      true,
    ]);
    expectAnchored(surface, element);
    owner.dispose();
    expect([source.matches(":popover-open"), surface.matches(":popover-open")]).toEqual([
      false,
      false,
    ]);
    binding.dispose();
    expect(source.isConnected).toBe(false);
  } finally {
    animation.cancel();
  }
});
