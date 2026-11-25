/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { DockResizer } from "./dock-layout-solid.tsx";
import { createDockLayout, type DockLayout } from "./dock-layout.ts";
import { createDockPanelLayout, type DockPanelPlacement } from "./dock-panel-layout.ts";

function createLayout(
  defaultDock: Exclude<DockPanelPlacement, "main">,
  options: Partial<Parameters<typeof createDockPanelLayout<DockPanelPlacement>>[0]> = {},
) {
  return createDockPanelLayout({
    storageKey: `test.dock-panel.${defaultDock}`,
    minHeight: 140,
    minWidth: 320,
    defaultDock,
    supportedDocks: ["bottom", "left", "right"],
    defaultHeight: 320,
    defaultWidth: 520,
    ...options,
  });
}

function createDock(
  reservationPrefix: string,
  options: Partial<Parameters<typeof createDockLayout<DockPanelPlacement>>[0]> = {},
) {
  return createDockLayout({
    notify: vi.fn(),
    layout: createLayout("right"),
    isAvailable: () => true,
    ...options,
    reservationPrefix,
  });
}

function save(key: string, value: unknown) {
  localStorage.setItem(`test.dock-panel.${key}`, JSON.stringify(value));
}

function reserve(prefix: string, side = "right") {
  return document.documentElement.style.getPropertyValue(`--oc-${prefix}-reserve-${side}`);
}

function keydown(separator: HTMLElement, key: string) {
  separator.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
}

async function separatorIn(container: HTMLElement) {
  flush();
  const separator = container.querySelector("resizable-divider")!;
  await separator.updateComplete;
  return separator;
}

function mountResizer<TDock extends DockPanelPlacement>(
  host: { notify: ReturnType<typeof vi.fn> },
  controller: DockLayout<TDock>,
) {
  return mountSolid(() => {
    const [revision, setRevision] = createSignal(0);
    host.notify.mockImplementation(() => setRevision((value) => value + 1));
    return (
      <DockResizer controller={(revision(), controller)} classPrefix="test" label="Resize panel" />
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(() => {
  cleanupSolid();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it.each([
  [undefined, false, "right", 520],
  ["{invalid", false, "right", 520],
  [{ open: true, dock: "bottom", height: 100, width: Number.NaN }, true, "bottom", 520],
  [{ open: true, dock: "left", height: 320, width: 420 }, true, "right", 420],
])("loads %j layout storage", (stored, open, dock, width) => {
  const layout = createLayout("right", { supportedDocks: ["bottom", "right"] });
  if (typeof stored === "string") {
    localStorage.setItem("test.dock-panel.right", stored);
  } else if (stored) {
    save("right", stored);
  }
  expect(layout.load()).toEqual({ open, dock, height: 320, width });
});

it("reads saved intent once per attachment and preserves explicit choices across suppression", () => {
  const layout = createLayout("right");
  layout.save({ ...layout.defaults, open: true });
  const load = vi.spyOn(layout, "load");
  let available = false;
  const controller = createDock("test-intent", { layout, isAvailable: () => available });
  controller.connect();
  expect(controller.open).toBe(false);
  controller.setSuppressed(true);
  available = true;
  expect(controller.restoreOpenState()).toBe(false);
  expect(controller.setSuppressed(false)).toBe(true);
  expect(controller.open).toBe(true);
  controller.hideWithoutPersisting();
  expect(controller.restoreOpenState()).toBe(true);
  controller.setOpen(false);
  expect(controller.restoreOpenState()).toBe(false);
  controller.setSuppressed(true);
  expect(controller.setSuppressed(false)).toBe(false);
  expect(controller.restoreOpenState()).toBe(false);
  expect(load).toHaveBeenCalledOnce();
  controller.setOpen(true);
  controller.hideWithoutPersisting();
  expect(controller.restoreOpenState()).toBe(true);
  controller.dispose();
  // A new attachment captures the saved preference afresh.
  layout.save({ ...layout.defaults, open: false });
  controller.connect();
  expect(controller.open).toBe(false);
  expect(controller.restoreOpenState()).toBe(false);
  expect(load).toHaveBeenCalledTimes(2);
  controller.dispose();
});

it("clamps to viewport changes only while attached", () => {
  let width = 520;
  const layout = createLayout("right");
  vi.spyOn(layout, "maxWidth").mockImplementation(() => width);
  const dock = createDock("test-resize-lifetime", { layout });
  dock.connect();
  dock.setOpen(true);
  width = 420;
  window.dispatchEvent(new Event("resize"));
  expect(dock.width).toBe(420);
  expect(reserve("test-resize-lifetime")).toBe("420px");
  dock.dispose();
  width = 320;
  window.dispatchEvent(new Event("resize"));
  expect(dock.width).toBe(420);
  expect(reserve("test-resize-lifetime")).toBe("0px");
});

it("lets only the standalone bottom dock own the shared reservation", () => {
  const layout = createLayout("right");
  layout.save({ ...layout.defaults, open: true, dock: "bottom" });
  const standalone = createDock("test-shared", { layout });
  const embedded = createDock("test-shared", { isEmbedded: () => true, layout });
  const reservation = () => ({
    bottom: reserve("test-shared", "bottom"),
    right: reserve("test-shared"),
  });
  const cleared = { bottom: "0px", right: "0px" };
  standalone.connect();
  embedded.connect();
  standalone.syncReservation();
  embedded.syncReservation();
  expect(reservation()).toEqual({ bottom: "320px", right: "0px" });
  standalone.setOpen(false);
  embedded.syncReservation();
  expect(reservation()).toEqual(cleared);
  standalone.setOpen(true);
  embedded.dispose();
  expect(reservation()).toEqual({ bottom: "320px", right: "0px" });
  standalone.dispose();
  expect(reservation()).toEqual(cleared);
});

it("resizes and restores a width without reserving the global viewport", async () => {
  const layout = createLayout("right", {
    storageKey: "test.dock-panel.inline",
    minWidth: 260,
    supportedDocks: ["right"],
    defaultWidth: 280,
  });
  vi.spyOn(layout, "maxWidth").mockReturnValue(420);
  const reservation = "--oc-test-inline-reserve-right";
  document.documentElement.style.setProperty(reservation, "17px");
  const host = { notify: vi.fn(), isEmbedded: () => true };
  const controller = createDock("test-inline", { ...host, layout });
  controller.connect();
  const { container, unmount } = mountResizer(host, controller);
  const separator = await separatorIn(container);
  separator.dispatchEvent(
    new CustomEvent("resize", {
      bubbles: true,
      detail: { splitRatio: 1 - 380 / window.innerWidth },
    }),
  );
  expect(controller.width).toBe(380);
  expect(localStorage.getItem("test.dock-panel.inline")).toBeNull();
  separator.dispatchEvent(new CustomEvent("resize-end", { bubbles: true }));
  expect(JSON.parse(localStorage.getItem("test.dock-panel.inline") ?? "{}")).toMatchObject({
    width: 380,
  });
  expect(document.documentElement.style.getPropertyValue(reservation)).toBe("17px");
  const restored = createDock("test-inline", { ...host, layout, notify: vi.fn() });
  restored.connect();
  expect(restored.width).toBe(380);
  restored.dispose();
  controller.dispose();
  unmount();
  document.documentElement.style.removeProperty(reservation);
});

it("exposes keyboard-operable separator semantics for right and bottom docks", async () => {
  const host = { notify: vi.fn() };
  const controller = createDock("test-keyboard", host);
  controller.connect();
  const { container, unmount } = mountResizer(host, controller);
  flush();
  expect(container.querySelector("resizable-divider")).toBeNull();
  controller.setOpen(true);
  let separator = await separatorIn(container);
  expect(separator.getAttribute("aria-orientation")).toBe("vertical");
  keydown(separator, "ArrowRight");
  expect(controller.width).toBeLessThan(520);
  controller.setDock("bottom", false);
  separator = await separatorIn(container);
  expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
  keydown(separator, "ArrowUp");
  expect(controller.height).toBeGreaterThan(320);
  controller.setOpen(false);
  flush();
  expect(container.querySelector("resizable-divider")).toBeNull();
  controller.dispose();
  unmount();
});
