/* @vitest-environment jsdom */

import "@awesome.me/webawesome/dist/components/popup/popup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeDropdownKeyboardDismissal,
  syncDropdownItemRadio,
  trackDropdownKeyboardDismissal,
} from "./web-awesome.ts";

type DropdownElement = HTMLElement & { readonly updateComplete: Promise<unknown> };
const domRoots = ["light", "shadow"] as const;
type Lifecycle = "show" | "hide" | "after-hide" | "reposition";

function rendered(element: DropdownElement) {
  return element.updateComplete;
}

function lifecycleEvent(phase: Lifecycle, cancelable = false) {
  return new CustomEvent(`wa-${phase}`, { bubbles: true, composed: true, cancelable });
}

function dispatchLifecycle(element: EventTarget, phase: Lifecycle, cancelable = false) {
  return element.dispatchEvent(lifecycleEvent(phase, cancelable));
}

function onLifecycle(
  element: EventTarget,
  phase: Lifecycle,
  listener: EventListener,
  options?: AddEventListenerOptions,
) {
  const type = `wa-${phase}`;
  element.addEventListener(type, listener, options);
  return () => element.removeEventListener(type, listener, options);
}

function menuLabel(element: Element, submenu = false) {
  return element.shadowRoot
    ?.querySelector(submenu ? '[part="submenu"]' : '[part="menu"]')
    ?.getAttribute("aria-label");
}

function expectMenuInteractive(dropdown: Element, interactive: boolean) {
  expect(dropdown.shadowRoot?.querySelector('[part="menu"]')?.hasAttribute("inert")).toBe(
    !interactive,
  );
}

function announceSubmenuOpening(item: Element) {
  item.dispatchEvent(
    new CustomEvent("submenu-opening", { bubbles: true, composed: true, detail: { item } }),
  );
}

async function labelsSettled() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function createDropdown(label?: string, domRoot: (typeof domRoots)[number] = "light") {
  const dropdown = document.createElement("wa-dropdown") as DropdownElement;
  if (label) {
    dropdown.setAttribute("aria-label", label);
  }
  const trigger = document.createElement("button");
  trigger.slot = "trigger";
  trigger.textContent = "Actions";
  const item = document.createElement("wa-dropdown-item");
  item.textContent = "Open";
  dropdown.append(trigger, item);
  const root =
    domRoot === "shadow"
      ? document.body.appendChild(document.createElement("div")).attachShadow({ mode: "open" })
      : document.body;
  root.append(dropdown);
  await rendered(dropdown);
  dispatchLifecycle(dropdown, "show");
  return { dropdown, trigger };
}

async function createSubmenuDropdown(itemLabel = "Specific owner") {
  const dropdown = document.createElement("wa-dropdown") as DropdownElement;
  dropdown.setAttribute("aria-label", "Filter & sort");
  const trigger = document.createElement("button");
  trigger.slot = "trigger";
  trigger.textContent = "Filter & sort";
  const item = document.createElement("wa-dropdown-item") as DropdownElement;
  item.setAttribute("aria-label", itemLabel);
  item.textContent = "Specific owner";
  const owner = document.createElement("wa-dropdown-item");
  owner.slot = "submenu";
  owner.textContent = "Ada";
  item.append(owner);
  dropdown.append(trigger, item);
  document.body.append(dropdown);
  dispatchLifecycle(dropdown, "show");
  await Promise.all([rendered(dropdown), rendered(item)]);
  await labelsSettled();
  await rendered(item);
  announceSubmenuOpening(item);
  await Promise.resolve();
  return { dropdown, item };
}

afterEach(() => document.body.replaceChildren());

describe("Web Awesome adapters", () => {
  it.each(domRoots)("syncs an explicit menu label only while open in %s DOM", async (domRoot) => {
    const { dropdown } = await createDropdown("Message actions", domRoot);

    expect(menuLabel(dropdown)).toBe("Message actions");

    dropdown.setAttribute("aria-label", "Updated actions");
    await labelsSettled();
    expect(menuLabel(dropdown)).toBe("Updated actions");
    dispatchLifecycle(dropdown, "after-hide");
    dropdown.setAttribute("aria-label", "Closed actions");
    await Promise.resolve();
    expect(menuLabel(dropdown)).toBe("Updated actions");
  });

  it("labels a dropdown menu from its trigger", async () => {
    const { dropdown } = await createDropdown();

    expect(menuLabel(dropdown)).toBe("Actions");
  });

  it("labels a submenu from its parent item", async () => {
    const { item } = await createSubmenuDropdown("Specific owner: Ada");

    expect(menuLabel(item, true)).toBe("Specific owner: Ada");
  });

  it.each(domRoots)("makes closing menus inert and restores them in %s DOM", async (domRoot) => {
    const { dropdown } = await createDropdown(undefined, domRoot);
    expectMenuInteractive(dropdown, true);

    dispatchLifecycle(dropdown, "hide", true);

    await Promise.resolve();
    expectMenuInteractive(dropdown, false);
    dispatchLifecycle(dropdown, "show", true);
    expectMenuInteractive(dropdown, true);
  });

  it("keeps a dropdown interactive when a later document listener cancels its hide", async () => {
    const { dropdown } = await createDropdown();
    const cancelHide = (event: Event) => {
      if (event.target === dropdown) {
        event.preventDefault();
      }
    };
    const stopCanceling = onLifecycle(document, "hide", cancelHide);

    try {
      expect(dispatchLifecycle(dropdown, "hide", true)).toBe(false);
      await Promise.resolve();

      expectMenuInteractive(dropdown, true);
    } finally {
      stopCanceling();
    }
  });

  it("restores a durable trigger only after keyboard dismissal", async () => {
    const { dropdown } = await createDropdown();
    dropdown.addEventListener("keydown", trackDropdownKeyboardDismissal);

    expect(consumeDropdownKeyboardDismissal(lifecycleEvent("after-hide"))).toBe(false);

    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    let restoreFocus = false;
    onLifecycle(dropdown, "after-hide", (event) => {
      restoreFocus = consumeDropdownKeyboardDismissal(event);
    });
    dispatchLifecycle(dropdown, "after-hide");
    expect(restoreFocus).toBe(true);
  });

  it("restores the durable trigger before native Tab navigation", async () => {
    const durableTrigger = document.createElement("button");
    document.body.append(durableTrigger);
    const { dropdown } = await createDropdown();
    dropdown.addEventListener("keydown", (event) =>
      trackDropdownKeyboardDismissal(event, () => durableTrigger.focus()),
    );

    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    expect(document.activeElement).toBe(durableTrigger);
  });

  it("restores radio semantics after a dropdown item updates", async () => {
    const item = document.createElement("wa-dropdown-item") as DropdownElement;
    item.setAttribute("type", "normal");
    document.body.append(item);

    syncDropdownItemRadio(item, true);
    await rendered(item);
    await Promise.resolve();

    expect(item.getAttribute("role")).toBe("menuitemradio");
    expect(item.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Web Awesome popup lifecycle", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    "mount",
    "overlapping anchor changes",
    "removal during reposition",
    "reconnection during reposition",
    "anchor change during reposition",
    "deactivation during reposition",
  ] as const)("releases popup resize listeners after %s", async (scenario) => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const anchor = document.createElement("button");
    const replacement = document.createElement("button");
    const newest = document.createElement("button");
    const popup = document.createElement("wa-popup");
    popup.anchor = anchor;
    popup.active = true;
    popup.textContent = "Popup lifecycle";
    const onReposition = vi.fn(() => {
      if (scenario === "removal during reposition") {
        popup.remove();
      } else if (scenario === "reconnection during reposition") {
        popup.remove();
        document.body.append(popup);
      } else if (scenario === "anchor change during reposition") {
        popup.anchor = replacement;
      } else if (scenario === "deactivation during reposition") {
        popup.active = false;
      }
    });
    onLifecycle(popup, "reposition", onReposition, { once: true });
    document.body.append(anchor, replacement, newest, popup);
    await rendered(popup);
    await vi.advanceTimersByTimeAsync(16);

    if (scenario === "overlapping anchor changes") {
      popup.anchor = replacement;
      await rendered(popup);
      popup.anchor = newest;
      await rendered(popup);
      await vi.advanceTimersByTimeAsync(16);
    }

    expect(onReposition).toHaveBeenCalledOnce();
    popup.remove();
    await rendered(popup);
    await vi.advanceTimersByTimeAsync(16);

    const added = new Set(
      addListener.mock.calls.filter(([type]) => type === "resize").map(([, listener]) => listener),
    );
    const removed = new Set(
      removeListener.mock.calls
        .filter(([type]) => type === "resize")
        .map(([, listener]) => listener),
    );
    expect(added.size).toBeGreaterThan(0);
    expect([...added].filter((listener) => !removed.has(listener))).toEqual([]);
  });

  it.each(["coalesced activation", "reposition event"] as const)(
    "releases resize work when disconnected after %s",
    async (transition) => {
      const add = vi.spyOn(window, "addEventListener");
      const remove = window.removeEventListener.bind(window);
      const frames = new Map<number, FrameRequestCallback>();
      let frameId = 0;
      const raf = vi.fn((callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
      vi.stubGlobal("requestAnimationFrame", raf);
      vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      const anchor = document.createElement("button");
      const popup = document.createElement("wa-popup");
      const reposition = vi.spyOn(popup, "reposition");
      popup.anchor = anchor;
      popup.active = true;
      const repositioned = vi.fn();
      onLifecycle(popup, "reposition", repositioned);
      const positioned = new Promise<void>((resolve) => {
        onLifecycle(popup, "reposition", () => resolve(), { once: true });
      });
      try {
        document.body.append(anchor, popup);
        await rendered(popup);
        await positioned;
        repositioned.mockClear();
        reposition.mockClear();
        window.dispatchEvent(new Event("resize"));
        expect(repositioned).toHaveBeenCalled();
        expect(reposition).toHaveBeenCalled();

        if (transition === "reposition event") {
          onLifecycle(popup, "reposition", () => popup.remove(), { once: true });
        }
        // Reactive changes can coalesce before the next Lit update.
        popup.active = false;
        popup.active = true;
        await rendered(popup);
        popup.remove();
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(performance.now()));
        await Promise.resolve();
        repositioned.mockClear();
        reposition.mockClear();

        window.dispatchEvent(new Event("resize"));

        expect(repositioned).not.toHaveBeenCalled();
        expect(reposition).not.toHaveBeenCalled();
      } finally {
        popup.remove();
        anchor.remove();
        // Keep a failing regression from leaking its own listeners into later tests.
        for (const [type, listener] of add.mock.calls) {
          if ((type === "resize" || type === "scroll") && listener) {
            remove(type, listener);
          }
        }
        frames.clear();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    },
  );
});
