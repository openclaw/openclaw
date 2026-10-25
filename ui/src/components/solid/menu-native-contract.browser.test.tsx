import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { createSignal, createStore, flush, untrack } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { subscribeNativeOverlayOcclusion } from "../../lib/native-overlay-occlusion.ts";
import {
  ChatPaneLayoutMenu,
  type HeaderPanelAction,
} from "../../pages/chat/components/chat-header-panel-actions.tsx";
import {
  item,
  mountMenu,
  navigationItems,
  openMenu,
  openSurfaces,
  phase,
  surface,
  trigger,
} from "../../test-helpers/solid-menu.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { Icon } from "./icon.tsx";
import { Kbd, KeyboardShortcut } from "./kbd.tsx";
import { keyFocus, mountControls, update } from "./menu-contract.test-support.tsx";
import { createMenuControls, Menu, type MenuItem } from "./menu.tsx";
import "../../styles/base.css";
import "../../styles/layout.css";
import "../../styles/session-menu.css";
import "../kbd.css";
import "../../styles/chat/layout.css";
import "../../styles/chat/split-view.css";

const cleanups: (() => void)[] = [];
const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
function clickLink(link: HTMLAnchorElement, options: MouseEventInit = {}) {
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...options }));
}
function entries(prefix: string, count: number): MenuItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    label: `${prefix[0]!.toUpperCase()}${prefix.slice(1)} ${index + 1}`,
  }));
}

const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  cleanups
    .splice(0)
    .toReversed()
    .forEach((stop) => stop());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await page.viewport(originalViewport.width, originalViewport.height);
});

it("keeps embedded-button activation and arrow navigation native", async () => {
  const activate = vi.fn();
  const select = vi.fn();
  mountControls((controls) => ({
    onSelect: select,
    children: (
      <button ref={controls.ref()} autofocus onClick={activate}>
        Clear
      </button>
    ),
  }));
  await openMenu();
  const button = surface().querySelector<HTMLButtonElement>("button:not([role])")!;
  expect(document.activeElement).toBe(button);
  await userEvent.keyboard("{Enter}");
  expect(activate).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
  expect(surface().matches(":popover-open")).toBe(true);
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement).toBe(trigger("people-assign"));
  button.focus();
  await userEvent.keyboard("{ArrowUp}");
  await expect.poll(() => document.activeElement).toBe(item("Archive"));
});

it("preserves native link intent while routing selections", async () => {
  const select = vi.fn();
  const navigate = vi.fn();
  const view = mountMenu({
    items: [{ id: "settings", label: "Settings", href: "#settings" }],
    onNavigate: navigate,
    onSelect: select,
  });
  const prevented: boolean[] = [];
  view.container.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) {
      prevented.push(event.defaultPrevented);
      event.preventDefault();
    }
  });
  await openMenu();
  const link = surface().querySelector<HTMLAnchorElement>("a")!;
  expect(getComputedStyle(link).cursor).toBe("pointer");
  for (const target of ["_blank", "named-window"]) {
    link.target = target;
    clickLink(link);
  }
  link.target = "";
  link.download = "settings.txt";
  clickLink(link);
  link.removeAttribute("download");
  expect(prevented).toEqual([false, false, false]);
  const canceledClick = new MouseEvent("click", { bubbles: true, cancelable: true });
  canceledClick.preventDefault();
  link.dispatchEvent(canceledClick);
  expect(prevented.at(-1)).toBe(true);

  await userEvent.click(link);
  await expect.poll(() => select).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ href: "#settings", value: "settings" });
  expect(prevented.at(-1)).toBe(true);
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

it("rolls rejected initial and controlled visibility back", async () => {
  const [open, setOpen] = createSignal(true);
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
  expect(untrack(open)).toBe(false);
  expect(surface().matches(":popover-open")).toBe(false);
  expect(received).toEqual([false]);
  update(() => setOpen(true));
  expect(untrack(open)).toBe(false);
  expect(received).toEqual([false, false]);
  vetoShow = false;
  update(() => setOpen(true));
  await phase(surface(), "open");
  expect(received).toEqual([false, false, true]);
  update(() => setOpen(false));
  expect(untrack(open)).toBe(true);
  expect(surface().matches(":popover-open")).toBe(true);
  expect(received).toEqual([false, false, true, true]);
  vetoHide = false;
  update(() => setOpen(false));
  await phase(surface(), "hidden");
  expect(received).toEqual([false, false, true, true, false]);
});

it("retains submenu content and identity across label updates", async () => {
  const icon = document.createElement("span"),
    details = document.createElement("span");
  const [props, setProps] = createStore({
    id: "people",
    label: "People actions",
    items: [
      {
        id: "assign",
        label: "Assign to",
        icon,
        details,
        children: [{ id: "ada", label: "Ada Rivera" }],
      },
    ],
  });
  mountMenu(props);
  const root = surface();
  const button = trigger();
  await openMenu();
  const assignment = trigger("people-assign");
  expect([icon, details].every((node) => assignment.contains(node))).toBe(true);
  await openMenu("people-assign");
  expect([icon, details].every((node) => assignment.contains(node))).toBe(true);
  const child = surface("people-assign");
  update(() =>
    setProps((draft) => {
      draft.id = "replacement-id";
      draft.label = "Updated actions";
      draft.items[0]!.label = "Updated assignment";
    }),
  );
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
        children: [...entries("gateway", 9), { id: "settings", label: "Gateway settings" }],
      },
      ...entries("action", 5),
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

it("leases native overlap contributed only by a descendant menu", async () => {
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
  expect(view.handle.close()).toBe(true);
  await phase(child, "hidden");
  expect(states).toEqual([false, true, false]);
});

async function finishHover() {
  await vi.advanceTimersByTimeAsync(300);
  flush();
}

function submenuBranch(id: string, children: MenuItem["children"]): MenuItem {
  return { id, label: id, children };
}

async function openBranch(...ids: string[]) {
  for (const id of ids) {
    await openMenu(`people-${id}`);
  }
}

function liveMenu(
  initial: readonly MenuItem[] = [],
  children?: (controls: ReturnType<typeof createMenuControls>) => JSX.Element,
) {
  const [items, setItems] = createSignal(initial);
  const view = mountMenu(() => {
    const controls = createMenuControls();
    return {
      controls,
      get items() {
        return items();
      },
      children: children?.(controls),
    };
  });
  const updateItems = (next: readonly MenuItem[]) => {
    setItems(next);
    flush();
  };
  return { ...view, update: updateItems };
}

describe("Solid menu branch lifetime", () => {
  it("opens a clicked submenu without waiting for its pending hover delay", async () => {
    mountMenu();
    await openMenu();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await userEvent.hover(trigger("people-assign"));
    await vi.advanceTimersByTimeAsync(0);
    expect(surface("people-assign").matches(":popover-open")).toBe(false);
    trigger("people-assign").click();
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(surface("people-assign").matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(item("Ada Rivera", "people-assign"));
  });

  it("materializes lazy submenu factories once and retains their controls", async () => {
    const children = [{ id: "ada", label: "Ada Rivera" }];
    mountMenu({
      lazy: true,
      items: [submenuBranch("assign", () => children)],
    });
    await openMenu();
    expect(surface("people-assign").querySelector('[role="menuitem"]')).toBeNull();
    await openMenu("people-assign");
    const ada = item("Ada Rivera", "people-assign");
    await userEvent.keyboard("{Escape}");
    await phase(surface("people-assign"), "hidden");
    await openMenu("people-assign");
    expect(item("Ada Rivera", "people-assign")).toBe(ada);
  });

  it("opens custom form content and retains it when generated items become empty", async () => {
    let input!: HTMLInputElement;
    const view = liveMenu([], (controls) => (
      <input autofocus aria-label="Filter" ref={[controls.ref(), (element) => (input = element)]} />
    ));
    expect(view.handle.open()).toBe(true);
    expect(document.activeElement).toBe(input);
    view.update([{ id: "result", label: "Result" }]);
    view.update([]);
    await Promise.resolve();
    expect(view.handle.overlay.open).toBe(true);
    expect(surface().matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it.each(["ltr", "rtl"] as const)(
    "routes hover to a sibling then Back → Down in %s",
    async (dir) => {
      mountMenu({ dir });
      await openMenu();
      await openMenu("people-assign");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await userEvent.hover(trigger("people-move"));
      await finishHover();
      vi.useRealTimers();
      await phase(surface("people-move"), "open");
      await phase(surface("people-assign"), "hidden");
      expect(surface("people-assign").matches(":popover-open")).toBe(false);
      expect(document.activeElement).toBe(item("Engineering", "people-move"));
      await keyFocus(dir === "ltr" ? "{ArrowLeft}" : "{ArrowRight}", trigger("people-move"));
      expect(trigger("people-move").getAttribute("aria-expanded")).toBe("false");
      expect(surface("people-move").inert).toBe(true);
      await keyFocus("{ArrowDown}", item("Archive"));
      await phase(surface("people-move"), "hidden");
      expect(openSurfaces()).toEqual([surface()]);
    },
  );

  it("retires nested descendants when replacing, unmounting, and remounting a branch", async () => {
    const nested = submenuBranch("browser", [
      submenuBranch("advanced", [{ id: "network", label: "Network access" }]),
    ]);
    const files = submenuBranch("files", [{ id: "read", label: "Read file" }]);
    const view = liveMenu([nested, files]);
    await openMenu();
    await openBranch("browser", "browser-advanced", "files");
    expect(openSurfaces()).toEqual([surface(), surface("people-files")]);
    await openBranch("browser", "browser-advanced");
    view.update([files]);
    await Promise.resolve();
    expect(document.getElementById("people-browser:content")).toBeNull();
    expect(openSurfaces()).toEqual([surface()]);
    trigger("people-files").focus();
    await keyFocus("{Home}", trigger("people-files"));
    view.update([nested, files]);
    await openBranch("browser", "browser-advanced");
    expect(openSurfaces()).toHaveLength(3);
  });

  it.each(["ancestor close", "ancestor reopen", "leave trigger", "native reopen"] as const)(
    "cancels pending hover after %s",
    async (operation) => {
      const view = mountMenu();
      await openMenu();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await userEvent.hover(trigger("people-assign"));
      if (operation === "leave trigger") {
        await userEvent.hover(item("Archive"));
      } else if (operation === "native reopen") {
        surface().hidePopover();
        surface().showPopover();
      } else {
        view.handle.close();
        if (operation === "ancestor reopen") {
          view.handle.open();
        }
      }
      await finishHover();
      vi.useRealTimers();
      const expectedOpen = operation !== "ancestor close";
      await phase(surface(), expectedOpen ? "open" : "hidden");
      expect(openSurfaces()).toEqual(expectedOpen ? [surface()] : []);
      expect(surface("people-assign").matches(":popover-open")).toBe(false);
    },
  );

  it("retires an emptied submenu and allows restored content to open at its current anchor", async () => {
    const view = liveMenu();
    view.update(navigationItems);
    await openMenu();
    await openMenu("people-move");
    const child = surface("people-move");
    view.update(
      navigationItems.map((entry) => (entry.id === "move" ? { ...entry, children: [] } : entry)),
    );
    await phase(child, "hidden");
    expect(surface().matches(":popover-open")).toBe(true);
    view.update(navigationItems);
    await openMenu("people-move");
    const bounds = surface("people-move").getBoundingClientRect();
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    await userEvent.click(item("Design", "people-move"));
    await phase(surface(), "hidden");
  });
});

function panelAction(
  id: string,
  icon: HeaderPanelAction["icon"],
  shortcut: HeaderPanelAction["shortcut"],
  active?: boolean,
): HeaderPanelAction {
  return { id, label: id[0]!.toUpperCase() + id.slice(1), icon, shortcut, active, onActivate() {} };
}

it.each([
  ["ltr", false],
  ["rtl", false],
  ["ltr", true],
  ["rtl", true],
] as const)("aligns shortcut rails in %s (icons only: %s)", async (dir, iconsOnly) => {
  await page.viewport(1000, 700);
  const rows: MenuItem[] = iconsOnly
    ? ["s", "b"].map((id) => ({
        id,
        label: id,
        icon: <Icon name="copy" />,
        details: <Kbd class="session-menu__shortcut" keys={id.toUpperCase()} inline />,
      }))
    : (
        [
          { id: "plain", label: "Plain" },
          { id: "off", label: "Unchecked", type: "checkbox", checked: false },
          { id: "on", label: "Checked", type: "checkbox", checked: true },
          { id: "radio", label: "Radio", type: "radio", checked: true },
          { id: "branch", label: "Submenu", children: [{ id: "child", label: "Child" }] },
        ] satisfies MenuItem[]
      ).map((row, index) =>
        Object.assign(row, {
          details: (
            <KeyboardShortcut
              class="session-menu__shortcut"
              combo={{
                key: index % 2 ? "u" : "b",
                modifiers: index % 2 ? ["mod", "alt", "shift"] : ["mod"],
              }}
              applePlatform
            />
          ),
        }),
      );
  render(() => <Menu id="alignment" label="Actions" dir={dir} class="session-menu" items={rows} />);
  await openMenu("alignment");
  const menu = surface("alignment");
  await expect.element(page.elementLocator(menu)).toBeVisible();
  const ends = [...menu.querySelectorAll<HTMLElement>(".session-menu__shortcut")].map((element) => {
    const bounds = element.getBoundingClientRect();
    return dir === "rtl" ? bounds.left : bounds.right;
  });
  expect(Math.max(...ends) - Math.min(...ends)).toBeLessThan(1);
  if (iconsOnly) {
    for (const row of menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
      const bounds = row.getBoundingClientRect();
      const icon = row.querySelector(".oc-menu-item__icon")!.getBoundingClientRect();
      const hint = row.querySelector(".shortcut-kbd")!.getBoundingClientRect();
      const [start, end] =
        dir === "rtl"
          ? [bounds.right - icon.right, hint.left - bounds.left]
          : [icon.left - bounds.left, bounds.right - hint.right];
      expect(Math.abs(end - start)).toBeLessThan(1);
    }
  }
});

it("keeps Layout shortcuts aligned across style loads and hidden on mobile", async () => {
  await page.viewport(1000, 800);
  render(() => (
    <ChatPaneLayoutMenu
      paneId="layout-alignment"
      narrow={false}
      panelMenuActions={[
        panelAction("terminal", "terminal", { key: "Backquote", modifiers: ["ctrl"] }),
        panelAction("browser", "globe", { key: "u", modifiers: ["mod", "alt", "shift"] }),
        panelAction("files", "fileText", { key: "b", modifiers: ["mod", "shift"] }, false),
        panelAction("review", "diff", { key: "e", modifiers: ["mod", "alt", "shift"] }, true),
      ]}
    />
  ));
  await userEvent.click(page.getByRole("button", { name: "Layout", exact: true }));
  const menu = page.getByRole("menu", { name: "Layout", exact: true }).element();
  await waitForSolid(() => {
    expect(menu.getAttribute("data-phase")).toBe("open");
    // The opening transition scales DOM bounds; measure its final geometry.
    expect(getComputedStyle(menu).scale).toBe("1");
  });
  await Promise.all(menu.getAnimations().map((animation) => animation.finished));
  const hints = [...menu.querySelectorAll<HTMLElement>(".shortcut-kbd")];
  expect(hints).toHaveLength(4);
  const bounds = () => hints.map((hint) => hint.getBoundingClientRect());
  const before = bounds();
  expect(
    Math.max(...before.map((rect) => rect.right)) - Math.min(...before.map((rect) => rect.right)),
  ).toBeLessThan(1);
  await import("../../styles/chat/side-panel.css");
  const after = bounds();
  // WebKit can retain ~0.03px rounding; a real style-induced shift is whole pixels.
  for (const [index, rect] of after.entries()) {
    expect(Math.abs(rect.right - before[index]!.right)).toBeLessThan(0.5);
    expect(Math.abs(rect.width - before[index]!.width)).toBeLessThan(0.5);
  }
  const check = menu.querySelector<HTMLElement>('[aria-checked="true"] > .oc-menu-item__check')!;
  expect(check.getBoundingClientRect().left).toBeGreaterThan(before[3]!.right);
  await page.viewport(390, 800);
  for (const hint of hints) {
    expect(hint.getBoundingClientRect().width).toBe(0);
  }
});
