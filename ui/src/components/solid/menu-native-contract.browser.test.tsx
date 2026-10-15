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

it("keeps submenu icons and details in the visible trigger", async () => {
  let icon!: HTMLSpanElement;
  let details!: HTMLSpanElement;
  render(() => (
    <Menu
      id="people"
      label="People"
      items={[
        {
          id: "view",
          label: "View",
          icon: <span ref={(node) => (icon = node)}>Eye</span>,
          details: <span ref={(node) => (details = node)}>V</span>,
          children: [{ id: "reasoning", label: "Reasoning" }],
        },
      ]}
    />
  ));
  flush();
  await openMenu();
  const view = item("View");
  expect(view.contains(icon)).toBe(true);
  expect(view.contains(details)).toBe(true);
  await userEvent.click(view);
  await phase(surface("people-view"), "open");
  expect(view.contains(icon)).toBe(true);
  expect(view.contains(details)).toBe(true);
});

it("routes arrow navigation from an embedded button through the menu", async () => {
  const activate = vi.fn();
  mountMenu({
    items: [
      { id: "disabled", label: "Unavailable", disabled: true },
      { id: "first", label: "First" },
      { id: "last", label: "Last" },
    ],
    children: (
      <button type="button" data-form-control="" autofocus onClick={activate}>
        About choices
      </button>
    ),
  });
  await openMenu();
  const info = surface().querySelector<HTMLButtonElement>("[data-form-control]")!;
  expect(document.activeElement).toBe(info);
  await userEvent.keyboard("{Enter}");
  expect(activate).toHaveBeenCalledOnce();
  expect(surface().matches(":popover-open")).toBe(true);
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement).toBe(item("First"));
  info.focus();
  await userEvent.keyboard("{ArrowUp}");
  await expect.poll(() => document.activeElement).toBe(item("Last"));
});

it("keeps native embedded controls in the menu keyboard flow", async () => {
  const activate = vi.fn();
  const navigate = vi.fn((event: MouseEvent) => event.preventDefault());
  const select = vi.fn();
  mountMenu({
    onSelect: select,
    items: [
      { id: "first", label: "First" },
      { id: "last", label: "Last" },
      {
        kind: "content",
        id: "header-actions",
        content: (
          <>
            <button type="button" onClick={activate}>
              Clear
            </button>
            <a href="#help" onClick={navigate}>
              Help
            </a>
          </>
        ),
      },
    ],
  });
  await openMenu();
  expect(document.activeElement).toBe(item("First"));
  await userEvent.tab();
  const button = surface().querySelector<HTMLButtonElement>("button:not([role])")!;
  expect(document.activeElement).toBe(button);
  await userEvent.keyboard("{Enter}");
  expect(activate).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
  expect(surface().matches(":popover-open")).toBe(true);
  await userEvent.tab();
  expect(document.activeElement).toBe(surface().querySelector("a"));
  await userEvent.keyboard("{Enter}");
  expect(navigate).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(button);
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
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...options }));
  }
  for (const target of ["_blank", "named-window"]) {
    link.target = target;
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }
  link.target = "";
  link.download = "settings.txt";
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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
        {
          id: "assign",
          label: childLabel(),
          icon: <span data-testid="assign-icon">Icon</span>,
          details: <span data-testid="assign-shortcut">A</span>,
          children: [{ id: "ada", label: "Ada Rivera" }],
        },
      ];
    },
  });
  const root = surface();
  const button = trigger();
  await openMenu();
  await openMenu("people-assign");
  const child = surface("people-assign");
  expect(trigger("people-assign").querySelector('[data-testid="assign-icon"]')).not.toBeNull();
  expect(trigger("people-assign").querySelector('[data-testid="assign-shortcut"]')).not.toBeNull();
  expect(item("Ada Rivera", "people-assign").getAttribute("value")).toBe("ada");
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
  const branch = [surface(), child];
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
  const closeTrace: {
    id: string;
    operation: "animations" | "hide-before" | "hide-after";
    phase: string | undefined;
    nativeOpen: boolean;
    animations?: number;
  }[] = [];
  const recordClose = (entry: (typeof closeTrace)[number]) => {
    if (closeTrace.length < 32) {
      closeTrace.push(entry);
    }
  };
  for (const menu of branch) {
    const getAnimations = menu.getAnimations.bind(menu);
    const hidePopover = menu.hidePopover.bind(menu);
    const animationSpy = vi.spyOn(menu, "getAnimations").mockImplementation(function (
      this: HTMLElement,
      ...args: Parameters<HTMLElement["getAnimations"]>
    ) {
      const animations = getAnimations(...args);
      recordClose({
        id: this.id,
        operation: "animations",
        phase: this.dataset.phase,
        nativeOpen: this.matches(":popover-open"),
        animations: animations.length,
      });
      return animations;
    });
    const hideSpy = vi.spyOn(menu, "hidePopover").mockImplementation(function (
      this: HTMLElement,
      ...args: Parameters<HTMLElement["hidePopover"]>
    ) {
      recordClose({
        id: this.id,
        operation: "hide-before",
        phase: this.dataset.phase,
        nativeOpen: this.matches(":popover-open"),
      });
      const result = hidePopover(...args);
      recordClose({
        id: this.id,
        operation: "hide-after",
        phase: this.dataset.phase,
        nativeOpen: this.matches(":popover-open"),
      });
      return result;
    });
    cleanups.push(
      () => animationSpy.mockRestore(),
      () => hideSpy.mockRestore(),
    );
  }
  expect(view.handle.close()).toBe(true);
  const closing = branch.flatMap((menu) => {
    const animations = menu.getAnimations();
    if (animations.length === 0) {
      const style = getComputedStyle(menu);
      console.error("Menu exit animation missing", {
        closeTrace,
        id: menu.id,
        phase: menu.dataset.phase,
        nativeOpen: menu.matches(":popover-open"),
        opacity: style.opacity,
        scale: style.scale,
        display: style.display,
        transitionDuration: style.transitionDuration,
        transitionProperty: style.transitionProperty,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
    }
    expect(animations.length).toBeGreaterThan(0);
    return animations;
  });
  for (const animation of closing) {
    animation.pause();
    cleanups.push(() => animation.cancel());
  }
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  expect(child.dataset.phase).toBe("closing");
  expect(child.matches(":popover-open")).toBe(true);
  expect(states).toEqual([false, true]);
  child.getAnimations().forEach((animation) => animation.finish());
  await hidden;
  expect(states).toEqual([false, true, false]);
  closing.forEach((animation) => animation.finish());
});
