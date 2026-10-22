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
import { menuContent, mountControls, tabFocus, update } from "./menu-contract.test-support.tsx";
import { Menu } from "./menu.tsx";
import "../resizable-divider.ts";
import "../../styles/base.css";
import "../../styles/layout.css";

const cleanups: (() => void)[] = [];
const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
function clickLink(link: HTMLAnchorElement, options: MouseEventInit = {}) {
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...options }));
}
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

it.each([true, false])("keeps embedded controls native (autofocus=%s)", async (autofocus) => {
  const activate = vi.fn();
  const navigate = vi.fn((event: MouseEvent) => event.preventDefault());
  const select = vi.fn();
  mountControls((controls) => ({
    onSelect: select,
    items: [
      ...(autofocus ? [{ id: "disabled", label: "Unavailable", disabled: true }] : []),
      { id: "first", label: "First" },
      { id: "last", label: "Last" },
      ...(!autofocus
        ? [
            menuContent(
              "header-actions",
              <>
                <button ref={controls.ref()} type="button" onClick={activate}>
                  Clear
                </button>
                <a ref={controls.ref()} href="#help" onClick={navigate}>
                  Help
                </a>
              </>,
            ),
          ]
        : []),
    ],
    children: autofocus ? (
      <button ref={controls.ref()} type="button" data-form-control="" autofocus onClick={activate}>
        About choices
      </button>
    ) : undefined,
  }));
  await openMenu();
  const button = surface().querySelector<HTMLButtonElement>("button:not([role])")!;
  expect(document.activeElement).toBe(autofocus ? button : item("First"));
  if (!autofocus) {
    await tabFocus(button);
  }
  await userEvent.keyboard("{Enter}");
  expect(activate).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
  expect(surface().matches(":popover-open")).toBe(true);
  if (autofocus) {
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => document.activeElement).toBe(item("First"));
    button.focus();
  } else {
    await tabFocus(surface().querySelector("a"));
    await userEvent.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    await tabFocus(button, true);
  }
  await userEvent.keyboard("{ArrowUp}");
  await expect.poll(() => document.activeElement).toBe(item("Last"));
});

it.each([false, true])("preserves native link intent (routing=%s)", async (routing) => {
  let cancel = false;
  let selections = 0;
  const navigate = vi.fn();
  const view = mountMenu({
    items: [{ id: "settings", label: "Settings", href: "#settings" }],
    onNavigate: routing ? navigate : undefined,
    onSelect: (_item, event) => {
      selections += 1;
      if (cancel) {
        event.preventDefault();
      }
    },
  });
  const prevented: boolean[] = [];
  let suppressNative = true;
  const initialHash = window.location.hash;
  view.container.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) {
      prevented.push(event.defaultPrevented);
      // Modified gestures stay native; same-tab clicks below exercise the real cancellation path.
      if (suppressNative) {
        event.preventDefault();
      }
    }
  });
  await openMenu();
  const link = surface().querySelector<HTMLAnchorElement>("a")!;
  expect(getComputedStyle(link).cursor).toBe("pointer");
  for (const options of [
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    clickLink(link, options);
  }
  for (const target of ["_blank", "named-window"]) {
    link.target = target;
    clickLink(link);
  }
  link.target = "";
  link.download = "settings.txt";
  clickLink(link);
  link.removeAttribute("download");
  expect(prevented).toEqual(Array.from({ length: 8 }, () => false));
  const canceledClick = new MouseEvent("click", { bubbles: true, cancelable: true });
  canceledClick.preventDefault();
  link.dispatchEvent(canceledClick);
  expect(prevented.at(-1)).toBe(true);

  suppressNative = false;
  await userEvent.click(link);
  await expect.poll(() => selections).toBe(1);
  expect(navigate.mock.calls).toEqual(routing ? [[{ href: "#settings", value: "settings" }]] : []);
  expect(prevented.at(-1)).toBe(true);
  await phase(surface(), "hidden");

  await openMenu();
  cancel = true;
  await userEvent.click(link);
  await expect.poll(() => selections).toBe(2);
  expect(navigate).toHaveBeenCalledTimes(routing ? 1 : 0);
  expect(view.handle.overlay.open).toBe(true);
  expect(window.location.hash).toBe(initialHash);
  cancel = false;
  link.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => selections).toBe(3);
  expect(navigate).toHaveBeenCalledTimes(routing ? 2 : 0);
  await phase(surface(), "hidden");
});

it("forwards link navigation from nested menus and closes the root", async () => {
  const navigate = vi.fn();
  mountMenu({
    items: [
      {
        id: "manage",
        label: "Manage",
        children: [{ id: "models", label: "Models", href: "#models" }],
      },
    ],
    onNavigate: navigate,
  });
  await openMenu();
  await openMenu("people-manage");
  await userEvent.click(surface("people-manage").querySelector<HTMLAnchorElement>("a")!);
  await expect.poll(() => navigate).toHaveBeenCalledWith({ href: "#models", value: "models" });
  await phase(surface(), "hidden");
});

it.each([false, true])("rolls rejected visibility back (initial=%s)", async (initial) => {
  const [open, setOpen] = createSignal(initial);
  let vetoShow = true;
  let vetoHide = true;
  const received: boolean[] = [];
  mountMenu({
    get open() {
      return open();
    },
    onBeforeShow: (event) => vetoShow && event.preventDefault(),
    onBeforeHide: (event) => vetoHide && event.preventDefault(),
    onOpenChange: (accepted) => {
      received.push(accepted);
      setOpen(accepted);
    },
  });
  if (!initial) {
    update(() => setOpen(true));
  }
  expect(untrack(open)).toBe(false);
  expect(surface().matches(":popover-open")).toBe(false);
  expect(received).toEqual([false]);
  vetoShow = false;
  update(() => setOpen(true));
  await phase(surface(), "open");
  expect(received).toEqual([false, true]);
  update(() => setOpen(false));
  expect(untrack(open)).toBe(true);
  expect(surface().matches(":popover-open")).toBe(true);
  expect(received).toEqual([false, true, true]);
  vetoHide = false;
  update(() => setOpen(false));
  await phase(surface(), "hidden");
  expect(received).toEqual([false, true, true, false]);
});

it("retains submenu content and identity across label updates", async () => {
  let icon!: HTMLSpanElement;
  let details!: HTMLSpanElement;
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
        {
          id: "assign",
          label: childLabel(),
          icon: <span ref={(node) => (icon = node)}>Icon</span>,
          details: <span ref={(node) => (details = node)}>A</span>,
          children: [{ id: "ada", label: "Ada Rivera" }],
        },
      ];
    },
  });
  const root = surface();
  const button = trigger();
  await openMenu();
  const assignment = trigger("people-assign");
  expect([icon, details].every((node) => assignment.contains(node))).toBe(true);
  await openMenu("people-assign");
  expect([icon, details].every((node) => assignment.contains(node))).toBe(true);
  const child = surface("people-assign");
  expect(item("Ada Rivera", "people-assign").getAttribute("value")).toBe("ada");
  setId("replacement-id");
  setLabel("Updated actions");
  update(() => setChildLabel("Updated assignment"));
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

it("updates root placement and RTL submenu geometry", async () => {
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
  update(() => setPlacement("top-end"));
  await nextFrame();
  expect(surface().dataset.placement).toBe("top-end");
  expect(surface().getBoundingClientRect().bottom).toBeLessThanOrEqual(button.top);
  await openMenu("people-assign");
  expect(surface("people-assign").getBoundingClientRect().left).toBeGreaterThanOrEqual(
    trigger("people-assign").getBoundingClientRect().right,
  );
  update(() => setDirection("rtl"));
  await nextFrame();
  expect(surface("people-assign").dataset.placement).toBe("left-start");
  expect(surface("people-assign").getBoundingClientRect().right).toBeLessThanOrEqual(
    trigger("people-assign").getBoundingClientRect().left,
  );
});

it.each([
  { dir: "ltr", placement: "right-end", left: "60px", side: "right" },
  { dir: "ltr", placement: "right-end", left: "1060px", side: "left" },
  { dir: "rtl", placement: "left-end", left: "1060px", side: "left" },
] as const)("keeps end-aligned submenu actions reachable ($dir, $side)", async (position) => {
  await page.viewport(1280, 800);
  const selected = vi.fn();
  mountMenu({
    dir: position.dir,
    placement: position.placement,
    items: [
      {
        id: "gateways",
        label: "Gateways",
        children: [
          ...Array.from({ length: 9 }, (_, index) => ({
            id: `gateway-${index}`,
            label: `Gateway ${index + 1}`,
          })),
          { id: "settings", label: "Gateway settings" },
        ],
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `action-${index}`,
        label: `Action ${index + 1}`,
      })),
    ],
    onSelect: selected,
  });
  Object.assign(trigger().style, { position: "fixed", left: position.left, bottom: "12px" });
  await openMenu();
  await openMenu("people-gateways");
  const child = surface("people-gateways");
  await expect.poll(() => getComputedStyle(child).scale).toBe("1");
  const branch = trigger("people-gateways").getBoundingClientRect();
  const bounds = child.getBoundingClientRect();
  expect(child.scrollHeight).toBeLessThanOrEqual(child.clientHeight);
  expect(bounds.bottom).toBeLessThanOrEqual(branch.bottom + 1);
  if (position.side === "right") {
    expect(bounds.left).toBeGreaterThanOrEqual(branch.right);
  } else {
    expect(bounds.right).toBeLessThanOrEqual(branch.left);
  }
  const settings = item("Gateway settings", "people-gateways");
  const row = settings.getBoundingClientRect();
  expect(row.top).toBeGreaterThanOrEqual(bounds.top);
  expect(row.bottom).toBeLessThanOrEqual(bounds.bottom);
  expect(
    settings.contains(document.elementFromPoint(row.x + row.width / 2, row.y + row.height / 2)),
  ).toBe(true);
  await userEvent.click(settings);
  expect(selected).toHaveBeenCalledWith(
    expect.objectContaining({ id: "settings" }),
    expect.any(CustomEvent),
  );
  await phase(surface(), "hidden");
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

it("leases descendant native overlap until exit settles", async () => {
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
  const branch = [surface(), child];
  // Establish the visible starting state for the closing transitions.
  await expect.poll(() => branch.map((menu) => getComputedStyle(menu).opacity)).toEqual(["1", "1"]);
  // Hold the parent too: its exit moves the submenu anchor before hiding it.
  branch.forEach((menu) => {
    const animation = menu.animate({ opacity: [1, 0], scale: [1, 0.9] }, { duration: 1000 });
    animation.pause();
    animation.currentTime = 0;
    cleanups.push(() => animation.cancel());
  });
  const hidden = new Promise<void>((resolve) => {
    child.addEventListener("overlay-after-hide", () => resolve(), { once: true });
  });
  child.addEventListener("toggle", (event) => {
    if ((event as ToggleEvent).newState === "closed") {
      // Chromium starts discrete exits when the native popover finally closes.
      child.getAnimations().forEach((animation) => animation.finish());
    }
  });
  expect(view.handle.close()).toBe(true);
  const closing = branch.flatMap((menu) => {
    const animations = menu.getAnimations();
    expect(animations.length).toBeGreaterThan(0);
    return animations;
  });
  for (const animation of closing) {
    animation.pause();
    cleanups.push(() => animation.cancel());
  }
  await nextFrame();
  expect(child.dataset.phase).toBe("closing");
  expect(child.matches(":popover-open")).toBe(true);
  expect(states).toEqual([false, true]);
  child.getAnimations().forEach((animation) => animation.finish());
  await hidden;
  expect(states).toEqual([false, true, false]);
  closing.forEach((animation) => animation.finish());
});
