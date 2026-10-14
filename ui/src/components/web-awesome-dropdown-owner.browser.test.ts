import { afterEach, describe, expect, it } from "vitest";
import { duringElementAnimation } from "../test-helpers/web-awesome-animation.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "./web-awesome.ts";

type Item = HTMLElementTagNameMap["wa-dropdown-item"];
type RenderedElement = HTMLElement & { readonly updateComplete: Promise<unknown> };

function rendered(element: RenderedElement, ...rest: RenderedElement[]) {
  return rest.length === 0
    ? element.updateComplete
    : Promise.all([element, ...rest].map((entry) => entry.updateComplete));
}

function submenu(item: Item) {
  return item.submenuElement;
}

async function expectSubmenuFlippedRight(item: Item) {
  await expect.poll(() => submenu(item).getAttribute("data-placement")).toMatch(/^right/);
}

async function rootClosed(dropdown: HTMLElementTagNameMap["wa-dropdown"]) {
  await expect.poll(() => dropdown.shadowRoot?.querySelector("wa-popup")?.active).toBe(false);
}

function openSubmenu(item: Item) {
  return item.openSubmenu();
}

function closeSubmenu(item: Item) {
  return item.closeSubmenu();
}

function duringSubmenuTransition(
  item: Item,
  phase: "show" | "hide",
  request: () => unknown,
  action: () => void | Promise<void>,
) {
  return duringElementAnimation(submenu(item), phase, request, action);
}

function expectSubmenuInTopLayer(item: Item) {
  expect(submenu(item).matches(":popover-open")).toBe(true);
}

async function submenuConnected(item: Item) {
  await expect.poll(() => submenu(item)?.isConnected).toBe(true);
}

async function submenuRemoved(item: Item, previous: HTMLElement) {
  await expect.poll(() => item.hasSubmenu).toBe(false);
  await expect.poll(() => previous.isConnected).toBe(false);
}

function expectNotPresented(surface: HTMLElement) {
  expect(surface.matches(":popover-open")).toBe(false);
}

function menuItem(label: string, ...children: Item[]) {
  const element = document.createElement("wa-dropdown-item");
  element.append(label);
  for (const child of children) {
    child.slot = "submenu";
    element.append(child);
  }
  return element;
}

async function fixture(shadow = false) {
  const leaf = menuItem("Deep action");
  const inner = menuItem("Inner", leaf);
  const middle = menuItem("Middle", inner);
  const alternateLeaf = menuItem("Alternate action");
  const alternate = menuItem("Alternate", alternateLeaf);
  const parent = menuItem("More", middle, alternate);
  const otherLeaf = menuItem("Other action");
  const other = menuItem("Other", otherLeaf);
  const first = menuItem("Web search");
  const disabled = menuItem("Unavailable");
  disabled.disabled = true;
  const dropdown = document.createElement("wa-dropdown");
  const trigger = document.createElement("button");
  trigger.slot = "trigger";
  trigger.textContent = "Actions";
  dropdown.append(trigger, first, disabled, parent, other);
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  const host = document.createElement("div");
  const root = shadow ? host.attachShadow({ mode: "open" }) : host;
  root.append(dropdown, outside);
  document.body.append(host);
  const items = [
    first,
    disabled,
    parent,
    middle,
    inner,
    leaf,
    alternate,
    alternateLeaf,
    other,
    otherLeaf,
  ];
  await rendered(dropdown);
  await Promise.all(items.map((entry) => rendered(entry)));
  const { page } = await import("vitest/browser");
  // An inherited pointer can hover a submenu as keyboard-opened popovers appear.
  await page.elementLocator(trigger).hover();
  dropdown.open = true;
  await expect.poll(() => root.querySelector("wa-dropdown")?.open).toBe(true);
  await expect.poll(() => focused()).toBe(first);
  return {
    host,
    root,
    dropdown,
    trigger,
    outside,
    first,
    disabled,
    parent,
    middle,
    inner,
    leaf,
    alternate,
    alternateLeaf,
    other,
    otherLeaf,
  };
}

function focused(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

async function hidden(...items: Item[]) {
  await expect
    .poll(() =>
      items.every(
        (entry) =>
          !entry.submenuOpen && submenu(entry).hidden && !submenu(entry).matches(":popover-open"),
      ),
    )
    .toBe(true);
}

async function back(key: string, trigger: Item) {
  const { userEvent } = await import("vitest/browser");
  await userEvent.keyboard(`{${key}}`);
  expect(focused()).toBe(trigger);
  expect(trigger.active).toBe(true);
}

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("Web Awesome submenu owner", () => {
  it.each(["ltr", "rtl"] as const)(
    "returns to root after sibling replacement (%s)",
    async (dir) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      f.dropdown.dir = dir;
      await openSubmenu(f.parent);
      await openSubmenu(f.other);
      await hidden(f.parent);
      expect(focused()).toBe(f.otherLeaf);
      if (dir === "rtl") {
        // Placement flips at the left viewport edge; backward navigation stays RTL.
        await expectSubmenuFlippedRight(f.other);
      }
      await back(dir === "rtl" ? "ArrowRight" : "ArrowLeft", f.other);
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.first);
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.parent);
      await userEvent.keyboard("{End}");
      expect(focused()).toBe(f.other);
      await userEvent.keyboard("{Home}");
      expect(focused()).toBe(f.first);
      await userEvent.keyboard("o");
      expect(focused()).toBe(f.other);
    },
  );

  it("preserves three ancestors, then retires only the replaced nested branch", async () => {
    const f = await fixture();
    await openSubmenu(f.parent);
    await openSubmenu(f.middle);
    await openSubmenu(f.inner);
    expect([f.parent.submenuOpen, f.middle.submenuOpen, f.inner.submenuOpen]).toEqual([
      true,
      true,
      true,
    ]);
    f.inner.disabled = true;
    await openSubmenu(f.alternate);
    expect(f.parent.submenuOpen).toBe(true);
    await hidden(f.middle, f.inner);
    expect(focused()).toBe(f.alternateLeaf);
    await back("ArrowLeft", f.alternate);
    await back("ArrowLeft", f.parent);
  });

  it("keeps the open child branch when an ancestor is opened repeatedly", async () => {
    const f = await fixture();
    await openSubmenu(f.parent);
    await openSubmenu(f.middle);
    await openSubmenu(f.parent);
    // A batched property reversal notifies again without actually closing the ancestor.
    f.parent.submenuOpen = false;
    f.parent.submenuOpen = true;
    await rendered(f.parent);
    await openSubmenu(f.parent);
    expect(f.middle.submenuOpen).toBe(true);
    await back("ArrowLeft", f.middle);
    await back("ArrowLeft", f.parent);
  });

  it.each(["method", "property", "hover"] as const)(
    "retires a standalone %s close before navigation",
    async (reason) => {
      const { page, userEvent } = await import("vitest/browser");
      const f = await fixture();
      await openSubmenu(f.other);
      if (reason === "method") {
        await closeSubmenu(f.other);
      } else if (reason === "property") {
        f.other.submenuOpen = false;
      } else {
        await page.elementLocator(f.outside).hover();
      }
      f.outside.focus();
      await hidden(f.other);
      expect(focused()).toBe(f.outside);
      f.other.focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.first);
    },
  );

  it.each(["ancestor", "root", "disconnect"] as const)(
    "closes disabled descendants on %s retirement and remount",
    async (reason) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      await openSubmenu(f.parent);
      await openSubmenu(f.middle);
      f.middle.disabled = true;
      if (reason === "ancestor") {
        f.parent.submenuOpen = false;
      } else if (reason === "root") {
        f.dropdown.open = false;
      } else {
        f.parent.remove();
      }
      f.outside.focus();
      await hidden(f.parent, f.middle);
      expect(focused()).toBe(f.outside);
      if (reason === "disconnect") {
        f.other.before(f.parent);
      }
      if (reason === "root") {
        await rootClosed(f.dropdown);
        f.dropdown.open = true;
        await expect.poll(() => focused()).toBe(f.first);
      }
      f.middle.disabled = false;
      await openSubmenu(f.parent);
      expect(focused()).toBe(f.middle);
      await back("ArrowLeft", f.parent);
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.other);
    },
  );

  it("retires direct item disconnection before another submenu opens", async () => {
    const { userEvent } = await import("vitest/browser");
    const f = await fixture();
    await openSubmenu(f.other);
    f.other.remove();
    await hidden(f.other);
    f.parent.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(focused()).toBe(f.first);
    f.dropdown.append(f.other);
    await openSubmenu(f.other);
    await back("ArrowLeft", f.other);
    await userEvent.keyboard("{ArrowDown}");
    expect(focused()).toBe(f.first);
  });

  it("navigates sibling submenus through forwarded slots inside a shadow caller", async () => {
    const { userEvent } = await import("vitest/browser");
    const f = await fixture(true);
    // A slot in the caller's shadow tree forwards light-DOM children to the submenu.
    const forward = document.createElement("slot");
    forward.name = "forwarded";
    forward.slot = "submenu";
    f.parent.replaceChildren("More", forward);
    f.middle.slot = "forwarded";
    f.alternate.slot = "forwarded";
    f.host.append(f.middle, f.alternate);
    await rendered(f.parent);
    await openSubmenu(f.parent);
    expect(focused()).toBe(f.middle);
    await userEvent.keyboard("{ArrowRight}");
    expect(focused()).toBe(f.inner);
    await openSubmenu(f.alternate);
    await hidden(f.middle);
    await back("ArrowLeft", f.alternate);
    await userEvent.keyboard("{Home}");
    expect(focused()).toBe(f.middle);
    await back("ArrowLeft", f.parent);
    await userEvent.keyboard("{ArrowDown}");
    expect(focused()).toBe(f.other);
  });

  it("keeps the new sibling focused when replacement interrupts an opening animation", async () => {
    const f = await fixture();
    let opening: Promise<void> | undefined;
    let replacement: Promise<void> | undefined;
    await duringSubmenuTransition(
      f.parent,
      "show",
      () => {
        opening = openSubmenu(f.parent);
      },
      () => {
        expect(focused()).toBe(f.middle);
        replacement = openSubmenu(f.other);
      },
    );
    await Promise.all([opening, replacement]);
    await hidden(f.parent);
    await expect.poll(() => focused()).toBe(f.otherLeaf);
    await back("ArrowLeft", f.other);
  });

  it("does not let an interrupted close retire a reopened child branch", async () => {
    const f = await fixture();
    await openSubmenu(f.parent);
    await openSubmenu(f.middle);
    let closing: Promise<void> | undefined;
    let reopened: Promise<void> | undefined;
    await duringSubmenuTransition(
      f.parent,
      "hide",
      () => {
        closing = closeSubmenu(f.parent);
      },
      () => {
        reopened = openSubmenu(f.parent).then(() => openSubmenu(f.middle));
      },
    );
    await Promise.all([closing, reopened]);
    expectSubmenuInTopLayer(f.parent);
    expectSubmenuInTopLayer(f.middle);
    expect(focused()).toBe(f.inner);
    await back("ArrowLeft", f.middle);
    await back("ArrowLeft", f.parent);
  });

  it.each(["mouse", "touch", "pen"] as const)(
    "replaces siblings through %s input without hover opening on touch or pen",
    async (pointerType) => {
      const { page } = await import("vitest/browser");
      const f = await fixture();
      await openSubmenu(f.parent);
      if (pointerType === "mouse") {
        await page.elementLocator(f.other).hover();
      } else {
        f.other.dispatchEvent(new PointerEvent("pointerenter", { pointerType }));
        await rendered(f.other);
        expect(f.other.submenuOpen).toBe(false);
        f.other.click();
      }
      await hidden(f.parent);
      await expect.poll(() => focused()).toBe(f.otherLeaf);
      await back("ArrowLeft", f.other);
    },
  );

  it("rejects a pending child opening beneath a closing ancestor", async () => {
    const f = await fixture();
    await openSubmenu(f.parent);
    f.parent.submenuOpen = false;
    f.middle.submenuOpen = true;
    await hidden(f.parent, f.middle);
    await openSubmenu(f.other);
    expect(focused()).toBe(f.otherLeaf);
    await back("ArrowLeft", f.other);
  });

  it("returns to the surviving level before a property hide animation finishes", async () => {
    const f = await fixture();
    await openSubmenu(f.other);
    await duringSubmenuTransition(
      f.other,
      "hide",
      () => (f.other.submenuOpen = false),
      () => {
        f.other.focus();
        f.other.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true }),
        );
        expect(focused()).toBe(f.first);
      },
    );
    await hidden(f.other);
    expect(focused()).toBe(f.first);
  });

  it.each(["removal", "slot reassignment"] as const)(
    "retires an emptied submenu after last-child %s and supports restoration",
    async (change) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      await openSubmenu(f.other);
      const retiredSubmenu = submenu(f.other);
      if (change === "removal") {
        f.otherLeaf.remove();
      } else {
        f.otherLeaf.slot = "details";
      }
      await submenuRemoved(f.other, retiredSubmenu);
      f.other.focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.first);
      expect(f.other.submenuOpen).toBe(false);
      expectNotPresented(retiredSubmenu);

      f.otherLeaf.slot = "submenu";
      if (change === "removal") {
        f.other.append(f.otherLeaf);
      }
      await submenuConnected(f.other);
      await openSubmenu(f.other);
      expect(focused()).toBe(f.otherLeaf);
      expectSubmenuInTopLayer(f.other);
      await back("ArrowLeft", f.other);
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.first);
    },
  );
});
