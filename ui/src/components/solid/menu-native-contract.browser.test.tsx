import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { createSignal, createStore, flush, untrack } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  ChatPaneLayoutMenu,
  type HeaderPanelAction,
} from "../../pages/chat/components/chat-header-panel-actions.tsx";
import "../../styles.css";
import { afterModalHidden, nextFrame } from "../../test-helpers/modal-dialog.ts";
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
import { ModalDialog, type OpenClawModalDialog } from "../modal-dialog.tsx";
import { Icon } from "./icon.tsx";
import { Kbd } from "./kbd.tsx";
import { LazyViewError } from "./lazy-view-error.tsx";
import { keyFocus, mountControls, update } from "./menu-contract.test-support.tsx";
import { createMenuControls, Menu, type MenuItem } from "./menu.tsx";
import "../../styles/session-menu.css";
import "../kbd.css";
import "../../styles/chat/layout.css";
import "../../styles/chat/split-view.css";

function clickLink(link: HTMLAnchorElement, options: MouseEventInit = {}) {
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...options }));
}
function entries(prefix: string, count: number, padded = false): MenuItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix.toLowerCase()}-${index}`,
    label: `${prefix[0]!.toUpperCase()}${prefix.slice(1)} ${padded ? String(index + 1).padStart(2, "0") : index + 1}`,
  }));
}

const extraNodes: Element[] = [];
const documentRoot = document.documentElement;
const originalAttributes = ["dir", "data-theme", "data-theme-mode"].map(
  (name) => [name, documentRoot.getAttribute(name)] as const,
);
const originalStyle = documentRoot.style.cssText;
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  extraNodes.splice(0).forEach((node) => node.remove());
  documentRoot.style.cssText = originalStyle;
  for (const [name, value] of originalAttributes) {
    if (value === null) {
      documentRoot.removeAttribute(name);
    } else {
      documentRoot.setAttribute(name, value);
    }
  }
  await page.viewport(originalViewport.width, originalViewport.height);
});

it("keeps disabled leaf explanations reachable without enabling activation", async () => {
  const select = vi.fn();
  const click = vi.fn();
  mountMenu({
    items: [
      { id: "disabled", label: "Unavailable default", disabled: true },
      {
        id: "reason",
        label: "Unavailable explained",
        disabled: true,
        focusableWhenDisabled: true,
        attributes: { title: "Connect to continue", onClick: click },
      },
      {
        id: "branch",
        label: "Unavailable submenu",
        disabled: true,
        children: [{ id: "child", label: "Child" }],
      },
      { id: "allowed", label: "Allowed" },
    ],
    onSelect: select,
  });
  await openMenu();
  const explained = item("Unavailable explained");
  await expect.poll(() => document.activeElement).toBe(explained);
  expect(explained.disabled).toBe(false);
  expect(explained.getAttribute("aria-disabled")).toBe("true");
  expect(item("Unavailable default").disabled).toBe(true);
  expect(item("Unavailable submenu").disabled).toBe(true);
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement).toBe(item("Allowed"));
  await userEvent.keyboard("{ArrowUp}");
  await expect.poll(() => document.activeElement).toBe(explained);
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard(" ");
  explained.click();
  explained.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(click).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(surface().matches(":popover-open")).toBe(true);
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(select).toHaveBeenCalledOnce();
  expect(select.mock.calls[0]?.[0].id).toBe("allowed");
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
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(received).toEqual([false]);
  update(() => setOpen(true));
  expect(untrack(open)).toBe(false);
  expect(received).toEqual([false, false]);
  vetoShow = false;
  update(() => setOpen(true));
  await phase(surface(), "open");
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(received).toEqual([false, false, true]);
  update(() => setOpen(false));
  expect(untrack(open)).toBe(true);
  expect(surface().matches(":popover-open")).toBe(true);
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(received).toEqual([false, false, true, true]);
  vetoHide = false;
  update(() => setOpen(false));
  await phase(surface(), "hidden");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(received).toEqual([false, false, true, true, false]);
});

it("retains submenu content and identity across label updates", async () => {
  const icon = document.createElement("span"),
    details = document.createElement("span");
  const [props, setProps] = createStore({
    id: "people",
    label: "People actions",
    lazy: true,
    items: [
      {
        id: "assign",
        label: "Assign to",
        icon,
        details,
        children: () => [{ id: "ada", label: "Ada Rivera" }],
      },
    ],
  });
  mountMenu(props);
  const root = surface();
  const button = trigger();
  await openMenu();
  expect(surface("people-assign").querySelector('[role="menuitem"]')).toBeNull();
  const assignment = trigger("people-assign");
  await openMenu("people-assign");
  const child = surface("people-assign");
  const ada = item("Ada Rivera", "people-assign");
  update(() =>
    setProps((draft) => {
      draft.id = "replacement-id";
      draft.label = "Updated actions";
      draft.items[0]!.label = "Updated assignment";
    }),
  );
  expect(surface()).toBe(root);
  expect([icon, details].every((node) => assignment.contains(node))).toBe(true);
  expect(trigger()).toBe(button);
  expect(button.getAttribute("aria-controls")).toBe(root.id);
  expect(root.getAttribute("aria-label")).toBe("Updated actions");
  expect(child.getAttribute("aria-label")).toBe("Updated assignment");
  expect(document.getElementById("replacement-id:content")).toBeNull();
  await userEvent.keyboard("{ArrowLeft}{Escape}");
  await phase(root, "hidden");
  await openMenu();
  await openMenu("people-assign");
  expect(item("Ada Rivera", "people-assign")).toBe(ada);
  expect(document.activeElement).toBe(ada);
});

it("updates root placement and RTL submenu geometry", async () => {
  await page.viewport(1280, 800);
  const [position, setPosition] = createStore<{
    placement: "bottom-start" | "top-end";
    dir: "ltr" | "rtl";
  }>({ placement: "bottom-start", dir: "ltr" });
  mountMenu(position);
  positionTrigger({ left: "500px", top: "350px" });
  await openMenu();
  const button = trigger().getBoundingClientRect();
  expect(surface().getBoundingClientRect().top).toBeGreaterThanOrEqual(button.bottom);
  update(() => setPosition((draft) => Object.assign(draft, { placement: "top-end" })));
  await nextFrame();
  expect(surface().dataset.placement).toBe("top-end");
  expect(surface().getBoundingClientRect().bottom).toBeLessThanOrEqual(button.top);
  await openMenu("people-assign");
  expect(surface("people-assign").getBoundingClientRect().left).toBeGreaterThanOrEqual(
    trigger("people-assign").getBoundingClientRect().right,
  );
  update(() => setPosition((draft) => Object.assign(draft, { dir: "rtl" })));
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
  positionTrigger({ left: position.left, bottom: "12px" });
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
  const view = mountControls((controls) => ({
    get items() {
      return items();
    },
    children: children?.(controls),
  }));
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
] as const)("aligns shortcut rails in %s (submenu: %s)", async (dir, submenu) => {
  await page.viewport(1000, 700);
  const items: MenuItem[] = ["plain", "branch"].map((id) => ({
    id,
    label: id,
    icon: <Icon name="copy" />,
    children: submenu && id === "branch" ? [{ id: "child", label: "Child" }] : undefined,
    details: (
      <Kbd class="session-menu__shortcut" keys={id === "plain" ? "B" : "Ctrl+Alt+Shift+U"} inline />
    ),
  }));
  render(() => (
    <Menu id="alignment" label="Actions" dir={dir} class="session-menu" items={items} />
  ));
  await openMenu("alignment");
  const menu = surface("alignment");
  await expect.element(page.elementLocator(menu)).toBeVisible();
  const ends = [...menu.querySelectorAll(".shortcut-kbd")].map(
    (hint) => hint.getBoundingClientRect()[dir === "rtl" ? "left" : "right"],
  );
  expect(Math.max(...ends) - Math.min(...ends)).toBeLessThan(1);
  if (submenu) {
    return;
  }
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
});

it.each(["ltr", "rtl"] as const)(
  "keeps Layout shortcuts aligned across style loads and mobile in %s",
  async (dir) => {
    document.documentElement.dir = dir;
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
      expect(menu.querySelectorAll(".shortcut-kbd")).toHaveLength(4);
    });
    await Promise.all(menu.getAnimations().map((animation) => animation.finished));
    const hints = [...menu.querySelectorAll<HTMLElement>(".shortcut-kbd")];
    expect(hints).toHaveLength(4);
    const bounds = () => hints.map((hint) => hint.getBoundingClientRect());
    const before = bounds();
    const edge = dir === "rtl" ? "left" : "right";
    expect(
      Math.max(...before.map((rect) => rect[edge])) - Math.min(...before.map((rect) => rect[edge])),
    ).toBeLessThan(1);
    await import("../../styles/chat/side-panel.css");
    const after = bounds();
    // WebKit can retain ~0.03px rounding; a real style-induced shift is whole pixels.
    for (const [index, rect] of after.entries()) {
      expect(Math.abs(rect[edge] - before[index]![edge])).toBeLessThan(0.5);
      expect(Math.abs(rect.width - before[index]!.width)).toBeLessThan(0.5);
    }
    const check = menu.querySelector<HTMLElement>('[aria-checked="true"] > .oc-menu-item__check')!;
    if (dir === "rtl") {
      expect(check.getBoundingClientRect().right).toBeLessThan(before[3]!.left);
    } else {
      expect(check.getBoundingClientRect().left).toBeGreaterThan(before[3]!.right);
    }
    await page.viewport(390, 800);
    for (const hint of hints) {
      expect(hint.getBoundingClientRect().width).toBe(0);
    }
  },
);

function positionTrigger(style: Partial<CSSStyleDeclaration>) {
  Object.assign(trigger().style, { position: "fixed" }, style);
}

const modalDialog = (host: OpenClawModalDialog) =>
  host.querySelector<HTMLDialogElement>(":scope > .oc-modal-dialog")!;
const makeElement = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), props);

async function tabCycle(order: HTMLElement[], active?: () => Element | null) {
  order[0]!.focus();
  for (const next of [...order.slice(1), order[0]!]) {
    await keyFocus("{Tab}", next, active);
  }
  for (const next of [...order.slice(1).toReversed(), order[0]!]) {
    await keyFocus("{Shift>}{Tab}{/Shift}", next, active);
  }
}

function renderModal(
  label: string,
  content: () => JSX.Element,
  initialFocus?: () => HTMLElement,
  container?: HTMLElement,
) {
  let handle!: OpenClawModalDialog;
  const view = render(
    () => (
      <ModalDialog label={label} initialFocus={initialFocus} ref={(value) => (handle = value)}>
        {content()}
      </ModalDialog>
    ),
    container ? { container } : undefined,
  );
  flush();
  return { view, handle, dialog: modalDialog(handle) };
}
it("keeps shadow-hosted modal focus through Tab, vetoed Escape, and dismissal", async () => {
  const opener = document.createElement("button");
  const container = document.createElement("div");
  document.body.append(opener, container);
  extraNodes.push(opener, container);
  const mount = document.createElement("div");
  const shadow = container.attachShadow({ mode: "open" });
  shadow.append(mount);
  opener.focus();
  const name = makeElement("input", { autofocus: true });
  const notes = makeElement("textarea");
  const { handle, dialog } = renderModal(
    "Edit details",
    () => [name, notes],
    () => name,
    mount,
  );
  const active = () => shadow.activeElement;
  notes.focus();
  await keyFocus("{Tab}", name, active);
  await keyFocus("{Shift>}{Tab}{/Shift}", notes, active);
  name.focus();
  await keyFocus("{Tab}", notes, active);

  const preventTab = (event: KeyboardEvent) => {
    if (event.key === "Tab") {
      event.preventDefault();
    }
  };
  notes.addEventListener("keydown", preventTab);
  await keyFocus("{Tab}", notes, active);
  notes.removeEventListener("keydown", preventTab);

  notes.value = "Unsaved draft";
  const veto = (event: Event) => event.preventDefault();
  document.addEventListener("modal-cancel", veto);
  try {
    await userEvent.keyboard("{Escape}");
    expect(modalDialog(handle).matches(":modal")).toBe(true);
    expect(handle.open).toBe(true);
    expect(shadow.activeElement).toBe(notes);
    expect(notes.value).toBe("Unsaved draft");
  } finally {
    document.removeEventListener("modal-cancel", veto);
  }
  const hidden = afterModalHidden(handle);
  await userEvent.keyboard("{Escape}");
  expect(handle.open).toBe(false);
  expect(dialog.inert).toBe(true);
  await hidden;
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(opener);
});

it.each([false, true])("Tabs through descendant shadow roots (only=%s)", async (shadowOnly) => {
  const before = makeElement("input", { ariaLabel: "Before shadow" });
  const host = makeElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const [first, slotted, last] = [makeElement("input"), makeElement("input"), makeElement("input")];
  host.append(slotted);
  shadow.append(first, makeElement("slot"), last);
  renderModal("Shadow fields", () => [!shadowOnly && before, host]);
  const order = shadowOnly ? [first, slotted, last] : [before, first, slotted, last];
  const active = () => shadow.activeElement ?? document.activeElement;
  await tabCycle(order, active);
});

it.each(["summary", "editable"])(
  "wraps native %s content without an explicit tabindex",
  async (kind) => {
    const target =
      kind === "summary"
        ? makeElement("summary", { textContent: "Details" })
        : makeElement("div", { contentEditable: "true", textContent: "Draft" });
    const content = kind === "summary" ? makeElement("details") : target;
    if (kind === "summary") {
      content.append(target, "Content");
    }
    const { dialog } = renderModal("Native content", () => content);
    await tabCycle([target]);
    target.tabIndex = -1;
    dialog.focus();
    await keyFocus("{Tab}", dialog);
    await keyFocus("{Shift>}{Tab}{/Shift}", dialog);
  },
);

it("stretches modal error-panel actions", async () => {
  let retried = 0;
  const { view, dialog } = renderModal("Load settings", () => (
    <LazyViewError
      error={new Error("Fixture module load failed")}
      subtitle="Settings"
      onRetry={() => retried++}
      onClose={() => {}}
    />
  ));
  await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  for (const width of [1440, 320]) {
    await page.viewport(width, 1000);
    expect(dialog.clientHeight).toBeLessThanOrEqual(window.innerHeight);
    const panel = view.container.querySelector<HTMLElement>(".lazy-view-error")!;
    const actions = panel.querySelector<HTMLElement>(".lazy-view-error__actions")!;
    const bounds = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    expect(actions.getBoundingClientRect()).toMatchObject({
      left: expect.closeTo(bounds.left + Number.parseFloat(style.paddingLeft), 0),
      right: expect.closeTo(bounds.right - Number.parseFloat(style.paddingRight), 0),
    });
  }
  await userEvent.click(view.getByRole("button", { name: /^Retry$/ }));
  expect(retried).toBe(1);
});
