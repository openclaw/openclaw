import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush, untrack } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { subscribeNativeOverlayOcclusion } from "../../lib/native-overlay-occlusion.ts";
import {
  item,
  mountMenu,
  openMenu,
  phase,
  surface,
  trigger,
} from "../../test-helpers/solid-menu.tsx";
import { Menu } from "./menu.tsx";
import "../resizable-divider.ts";
import "../../styles/base.css";
import "../../styles/layout.css";

const cleanups: (() => void)[] = [];
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  cleanup();
  cleanups
    .splice(0)
    .toReversed()
    .forEach((stop) => stop());
  vi.unstubAllGlobals();
  await page.viewport(originalViewport.width, originalViewport.height);
});

it.each([false, true])(
  "rolls rejected controlled visibility back to accepted state (initial=%s)",
  async (initial) => {
    const [open, setOpen] = createSignal(initial);
    let vetoShow = true;
    let vetoHide = true;
    const received: boolean[] = [];
    mountMenu({
      get open() {
        return open();
      },
      onBeforeShow: (event) => {
        if (vetoShow) {
          event.preventDefault();
        }
      },
      onBeforeHide: (event) => {
        if (vetoHide) {
          event.preventDefault();
        }
      },
      onOpenChange: (accepted) => {
        received.push(accepted);
        setOpen(accepted);
      },
    });
    if (!initial) {
      setOpen(true);
      flush();
    }
    expect(untrack(open)).toBe(false);
    expect(surface().matches(":popover-open")).toBe(false);
    expect(received).toEqual([false]);
    vetoShow = false;
    setOpen(true);
    flush();
    await phase(surface(), "open");
    expect(received).toEqual([false, true]);
    setOpen(false);
    flush();
    expect(untrack(open)).toBe(true);
    expect(surface().matches(":popover-open")).toBe(true);
    expect(received).toEqual([false, true, true]);
    vetoHide = false;
    setOpen(false);
    flush();
    await phase(surface(), "hidden");
    expect(received).toEqual([false, true, true, false]);
  },
);

it("updates accessible labels without splitting mounted DOM and machine identity", async () => {
  const [id, setId] = createSignal("people");
  const [label, setLabel] = createSignal("People actions");
  const [childLabel, setChildLabel] = createSignal("Assign to");
  mountMenu({
    get id() {
      return id();
    },
    get label() {
      return label();
    },
    get items() {
      return [
        { id: "assign", label: childLabel(), children: [{ id: "ada", label: "Ada Rivera" }] },
      ];
    },
  });
  const root = surface();
  const button = trigger();
  await openMenu();
  await openMenu("people-assign");
  const child = surface("people-assign");
  setId("replacement-id");
  setLabel("Updated actions");
  setChildLabel("Updated assignment");
  flush();
  expect(surface()).toBe(root);
  expect(trigger()).toBe(button);
  expect(button.getAttribute("aria-controls")).toBe(root.id);
  expect(root.getAttribute("aria-label")).toBe("Updated actions");
  expect(child.getAttribute("aria-label")).toBe("Updated assignment");
  expect(document.getElementById("replacement-id:content")).toBeNull();
  await userEvent.keyboard("{ArrowLeft}{Escape}");
  await phase(root, "hidden");
  await openMenu();
  await openMenu("people-assign");
  expect(document.activeElement).toBe(item("Ada Rivera", "people-assign"));
});

it("preserves live root placement and RTL submenu geometry across open frames", async () => {
  await page.viewport(1280, 800);
  const [placement, setPlacement] = createSignal<"bottom-start" | "top-end">("bottom-start");
  const [direction, setDirection] = createSignal<"ltr" | "rtl">("ltr");
  mountMenu({
    get placement() {
      return placement();
    },
    get dir() {
      return direction();
    },
  });
  Object.assign(trigger().style, { position: "fixed", left: "500px", top: "350px" });
  await openMenu();
  const button = trigger().getBoundingClientRect();
  expect(surface().getBoundingClientRect().top).toBeGreaterThanOrEqual(button.bottom);
  setPlacement("top-end");
  flush();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  expect(surface().dataset.placement).toBe("top-end");
  expect(surface().getBoundingClientRect().bottom).toBeLessThanOrEqual(button.top);
  await openMenu("people-assign");
  expect(surface("people-assign").getBoundingClientRect().left).toBeGreaterThanOrEqual(
    trigger("people-assign").getBoundingClientRect().right,
  );
  setDirection("rtl");
  flush();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  expect(surface("people-assign").dataset.placement).toBe("left-start");
  expect(surface("people-assign").getBoundingClientRect().right).toBeLessThanOrEqual(
    trigger("people-assign").getBoundingClientRect().left,
  );
});

it("paints the actual menu above the shell sidebar resizer", async () => {
  await page.viewport(1280, 800);
  const shell = document.createElement("div");
  shell.className = "shell";
  shell.style.cssText = "height:800px;animation:none";
  const nav = document.createElement("div");
  nav.className = "shell-nav";
  const divider = document.createElement("resizable-divider");
  divider.className = "sidebar-resizer";
  shell.append(nav, divider);
  document.body.append(shell);
  cleanups.push(() => shell.remove());
  await divider.updateComplete;
  render(
    () => (
      <Menu
        id="resizer-menu"
        label="Actions"
        items={[{ id: "created", label: "Created recently" }]}
      />
    ),
    { container: nav },
  );
  flush();
  const boundary = divider.getBoundingClientRect();
  Object.assign(trigger("resizer-menu").style, {
    position: "fixed",
    left: `${boundary.left - 90}px`,
    top: "100px",
  });
  await openMenu("resizer-menu");
  const menu = surface("resizer-menu");
  const bounds = menu.getBoundingClientRect();
  expect(bounds.left).toBeLessThan(boundary.left);
  expect(bounds.right).toBeGreaterThan(boundary.right);
  const hit = document.elementFromPoint(
    boundary.left + boundary.width / 2,
    bounds.top + bounds.height / 2,
  );
  expect(menu.contains(hit)).toBe(true);
});

it("keeps descendant-only native overlap leased through closing and releases after settlement", async () => {
  vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage() {} } } });
  await page.viewport(1280, 800);
  let bounds = new DOMRect(1000, 100, 100, 100);
  const states: boolean[] = [];
  cleanups.push(
    subscribeNativeOverlayOcclusion(
      (value) => states.push(value),
      () => bounds,
    ),
  );
  const view = mountMenu();
  Object.assign(trigger().style, { position: "fixed", left: "40px", top: "100px" });
  await openMenu();
  expect(states).toEqual([false]);
  await openMenu("people-assign");
  const child = surface("people-assign");
  const childRect = child.getBoundingClientRect();
  bounds = new DOMRect(childRect.right - 4, childRect.top + 4, 100, childRect.height - 8);
  expect(bounds.left).toBeGreaterThan(surface().getBoundingClientRect().right);
  await expect.poll(() => states).toEqual([false, true]);
  child.style.setProperty("--oc-overlay-hide-duration", "60s");
  const hidden = new Promise<void>((resolve) => {
    child.addEventListener("overlay-after-hide", () => resolve(), { once: true });
  });
  expect(view.handle.close()).toBe(true);
  const closing = child.getAnimations();
  expect(closing.length).toBeGreaterThan(0);
  for (const animation of closing) {
    animation.pause();
    cleanups.push(() => animation.cancel());
  }
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  expect(states).toEqual([false, true]);
  closing.forEach((animation) => animation.finish());
  await hidden;
  expect(states).toEqual([false, true, false]);
});
