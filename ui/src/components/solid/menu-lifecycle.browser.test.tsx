import { cleanup } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
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
import { createMenuControls, type MenuItem, type MenuItemBindings } from "./menu.tsx";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function finishHover() {
  await vi.advanceTimersByTimeAsync(300);
  flush();
}

function renderSpy() {
  return vi.fn((attributes: MenuItemBindings) => <button {...attributes} />);
}

function people(render: MenuItem["render"]): MenuItem[] {
  return Array.from({ length: 40 }, (_, id) => ({
    id: String(id),
    label: `Person ${id}`,
    render,
  }));
}

function branch(
  id: string,
  children: MenuItem["children"],
  extra: Partial<MenuItem> = {},
): MenuItem {
  return { id, label: id, children, ...extra };
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
  const update = (next: readonly MenuItem[]) => {
    setItems(next);
    flush();
  };
  return { ...view, update };
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

  it("prepares closed branches in idle slices after readiness and finishes synchronously on open", async () => {
    const frames: FrameRequestCallback[] = [];
    const idle = new Map<number, IdleRequestCallback>();
    let nextIdle = 0;
    const animation = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => frames.push(callback));
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      idle.set(++nextIdle, callback);
      return nextIdle;
    });
    vi.stubGlobal("cancelIdleCallback", (id: number) => idle.delete(id));
    const runFrames = () => frames.splice(0).forEach((callback) => callback(0));
    const runIdle = () => {
      expect(idle.size).toBeGreaterThan(0);
      const [id, callback] = [...idle][0]!;
      idle.delete(id);
      callback({ didTimeout: false, timeRemaining: () => 10 });
      flush();
    };
    const [ready, setReady] = createSignal(false);
    const avatar = renderSpy();
    const unopened = vi.fn(() => <button>Other content</button>);
    const view = mountMenu({
      lazy: true,
      get prewarm() {
        return ready();
      },
      items: [
        branch("assign", () => people(avatar), { prewarm: true }),
        branch("other", [{ id: "other-content", label: "Other content", render: unopened }]),
      ],
    });
    expect(idle.size).toBe(0);
    setReady(true);
    flush();
    runFrames();
    runFrames();
    runIdle();
    expect(avatar).not.toHaveBeenCalled();
    runFrames();
    runFrames();
    runIdle();
    expect(avatar.mock.calls.length).toBeGreaterThan(0);
    expect(avatar.mock.calls.length).toBeLessThan(40);
    const retained = item("Person 0", "people-assign");
    expect(surface("people-assign").matches(":popover-open")).toBe(false);
    animation.mockRestore();
    expect(view.handle.open()).toBe(true);
    await openMenu("people-assign");
    expect(idle.size).toBe(0);
    expect(avatar).toHaveBeenCalledTimes(40);
    expect(unopened).not.toHaveBeenCalled();
    expect(item("Person 0", "people-assign")).toBe(retained);
    await userEvent.keyboard("{Escape}");
    await phase(surface("people-assign"), "hidden");
    await openMenu("people-assign");
    expect(item("Person 0", "people-assign")).toBe(retained);
    expect(avatar).toHaveBeenCalledTimes(40);
  });

  it("uses the timer fallback and cancels unfinished preparation on unmount", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    vi.stubGlobal("requestIdleCallback", undefined);
    const avatar = renderSpy();
    const view = mountMenu({
      lazy: true,
      prewarm: true,
      items: people(avatar),
    });
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    await vi.advanceTimersByTimeAsync(50);
    flush();
    expect(avatar.mock.calls.length).toBeGreaterThan(0);
    expect(avatar.mock.calls.length).toBeLessThan(40);
    const constructed = avatar.mock.calls.length;
    view.unmount();
    await vi.runAllTimersAsync();
    expect(avatar).toHaveBeenCalledTimes(constructed);
  });

  it.each(["array", "factory"] as const)(
    "materializes %s submenus on open and retains their controls across closes",
    async (kind) => {
      const renderAda = renderSpy();
      const entries = [{ id: "ada", label: "Ada Rivera", render: renderAda }];
      mountMenu({
        lazy: true,
        items: [branch("assign", kind === "array" ? entries : () => entries)],
      });
      expect(renderAda).not.toHaveBeenCalled();
      await openMenu();
      expect(renderAda).not.toHaveBeenCalled();
      expect(surface("people-assign").querySelector('[role="menuitem"]')).toBeNull();
      await openMenu("people-assign");
      const ada = item("Ada Rivera", "people-assign");
      expect(renderAda).toHaveBeenCalledTimes(1);
      await userEvent.keyboard("{Escape}");
      await phase(surface("people-assign"), "hidden");
      await openMenu("people-assign");
      expect(item("Ada Rivera", "people-assign")).toBe(ada);
      expect(renderAda).toHaveBeenCalledTimes(1);
    },
  );

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
      expect(surface("people-assign").matches(":popover-open")).toBe(false);
      expect(document.activeElement).toBe(item("Engineering", "people-move"));
      await userEvent.keyboard(dir === "ltr" ? "{ArrowLeft}" : "{ArrowRight}");
      expect(document.activeElement).toBe(trigger("people-move"));
      expect(trigger("people-move").getAttribute("aria-expanded")).toBe("false");
      expect(surface("people-move").inert).toBe(true);
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(item("Archive"));
      await phase(surface("people-move"), "hidden");
      expect(openSurfaces()).toEqual([surface()]);
    },
  );

  it("retires nested descendants when replacing, unmounting, and remounting a branch", async () => {
    const nested = branch("browser", [
      branch("advanced", [{ id: "network", label: "Network access" }]),
    ]);
    const files = branch("files", [{ id: "read", label: "Read file" }]);
    const view = liveMenu([nested, files]);
    await openMenu();
    await openMenu("people-browser");
    await openMenu("people-browser-advanced");
    await openMenu("people-files");
    expect(surface("people-browser").matches(":popover-open")).toBe(false);
    expect(surface("people-browser-advanced").matches(":popover-open")).toBe(false);
    await openMenu("people-browser");
    await openMenu("people-browser-advanced");
    view.update([files]);
    await Promise.resolve();
    expect(document.getElementById("people-browser:content")).toBeNull();
    expect(openSurfaces()).toEqual([surface()]);
    trigger("people-files").focus();
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(trigger("people-files"));
    view.update([nested, files]);
    await openMenu("people-browser");
    await openMenu("people-browser-advanced");
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
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(surface(), { attributes: true, attributeFilter: ["inert", "data-phase"] });
    try {
      view.container.append(document.createElement("span"));
      await Promise.resolve();
      mutations.push(...observer.takeRecords());
      expect(mutations).toHaveLength(0);
    } finally {
      observer.disconnect();
    }
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

  it("resolves a late document veto before retiring a branch or changing focus", async () => {
    const view = mountMenu();
    const outside = document.createElement("input");
    outside.setAttribute("aria-label", "Outside input");
    Object.assign(outside.style, { position: "fixed", right: "8px", bottom: "8px" });
    view.container.append(outside);
    await openMenu();
    await openMenu("people-assign");
    const veto = (event: Event) => event.preventDefault();
    document.addEventListener("overlay-hide", veto);
    try {
      await userEvent.keyboard("{Escape}");
      expect(surface().matches(":popover-open")).toBe(true);
      expect(surface("people-assign").matches(":popover-open")).toBe(true);
      expect(document.activeElement).toBe(item("Ada Rivera", "people-assign"));
      expect(surface("people-assign").inert).toBe(false);
      await userEvent.click(outside);
      expect(openSurfaces()).toHaveLength(2);
      expect(document.activeElement).toBe(outside);
    } finally {
      document.removeEventListener("overlay-hide", veto);
    }
    trigger("people-assign").focus();
    await userEvent.click(outside);
    await phase(surface(), "hidden");
    expect(openSurfaces()).toHaveLength(0);
  });
});
