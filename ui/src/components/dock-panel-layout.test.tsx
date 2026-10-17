/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { DockResizer } from "./dock-layout-solid.tsx";
import { createDockLayout, type DockLayout } from "./dock-layout.ts";
import { createDockPanelLayout, type DockPanelPlacement } from "./dock-panel-layout.ts";

function createNotifications() {
  return { notify: vi.fn() };
}

function createLayout(defaultDock: Exclude<DockPanelPlacement, "main">) {
  return createDockPanelLayout({
    storageKey: `test.dock-panel.${defaultDock}`,
    minHeight: 140,
    minWidth: 320,
    defaultDock,
    supportedDocks: ["bottom", "left", "right"],
    defaultHeight: 320,
    defaultWidth: 520,
  });
}

function mountResizer<TDock extends DockPanelPlacement>(
  host: ReturnType<typeof createNotifications>,
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

describe("createDockPanelLayout", () => {
  it("uses the caller's default dock for missing or invalid storage", () => {
    const bottom = createLayout("bottom");
    const right = createLayout("right");

    expect(bottom.load()).toEqual(bottom.defaults);
    localStorage.setItem("test.dock-panel.right", "{invalid");
    expect(right.load()).toEqual(right.defaults);
  });

  it("restores valid layout fields and rejects invalid sizes", () => {
    const layout = createLayout("bottom");
    localStorage.setItem(
      "test.dock-panel.bottom",
      JSON.stringify({ open: true, dock: "right", height: 100, width: Number.NaN }),
    );

    expect(layout.load()).toEqual({
      open: true,
      dock: "right",
      height: layout.defaults.height,
      width: layout.defaults.width,
    });
  });

  it("rejects docks unsupported by a consumer", () => {
    const layout = createDockPanelLayout({
      storageKey: "test.dock-panel.side-only",
      minHeight: 140,
      minWidth: 320,
      defaultDock: "right",
      supportedDocks: ["bottom", "right"],
      defaultHeight: 320,
      defaultWidth: 520,
    });
    localStorage.setItem(
      "test.dock-panel.side-only",
      JSON.stringify({ open: true, dock: "left", height: 320, width: 420 }),
    );

    expect(layout.load().dock).toBe("right");
  });
});

describe("DockLayout open intent", () => {
  it("reads saved intent once per attachment and preserves explicit choices across suppression", () => {
    const layout = createLayout("right");
    layout.save({ ...layout.defaults, open: true });
    const load = vi.spyOn(layout, "load");
    let available = false;
    const controller = createDockLayout({
      ...createNotifications(),
      layout,
      reservationPrefix: "test-intent",
      isAvailable: () => available,
    });
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
});

it("clamps to viewport changes only while attached", () => {
  let width = 520;
  const dock = createDockLayout({
    ...createNotifications(),
    layout: createLayout("right"),
    reservationPrefix: "test-resize-lifetime",
    isAvailable: () => true,
    maxWidth: () => width,
  });
  dock.connect();
  dock.setOpen(true);
  width = 420;
  window.dispatchEvent(new Event("resize"));
  expect(dock.width).toBe(420);
  expect(
    document.documentElement.style.getPropertyValue("--oc-test-resize-lifetime-reserve-right"),
  ).toBe("420px");
  dock.dispose();
  width = 320;
  window.dispatchEvent(new Event("resize"));
  expect(dock.width).toBe(420);
  expect(
    document.documentElement.style.getPropertyValue("--oc-test-resize-lifetime-reserve-right"),
  ).toBe("0px");
});

describe("DockLayout inline columns", () => {
  it.each([
    { dock: "bottom", hostKind: "element", reserved: { bottom: "320px", right: "0px" } },
  ] as const)(
    "lets only the standalone $dock dock own the viewport reservation with an embedded $hostKind",
    ({ dock, reserved }) => {
      const layout = createLayout("right");
      layout.save({ open: true, dock, height: 320, width: 520 });
      const embeddedHost = { ...createNotifications(), isEmbedded: () => true };
      // Both instances of one panel share its layout store and reservation properties.
      const options = { layout, reservationPrefix: "test-shared", isAvailable: () => true };
      const standalone = createDockLayout({ ...createNotifications(), ...options });
      const embedded = createDockLayout({ ...embeddedHost, ...options });
      const reservation = () => ({
        bottom: document.documentElement.style.getPropertyValue("--oc-test-shared-reserve-bottom"),
        right: document.documentElement.style.getPropertyValue("--oc-test-shared-reserve-right"),
      });
      const cleared = { bottom: "0px", right: "0px" };

      standalone.connect();
      embedded.connect();
      standalone.syncReservation();
      embedded.syncReservation();
      expect(reservation()).toEqual(reserved);

      standalone.setOpen(false);
      embedded.syncReservation();
      expect(reservation()).toEqual(cleared);

      standalone.setOpen(true);
      embedded.dispose();
      expect(reservation()).toEqual(reserved);

      standalone.dispose();
      expect(reservation()).toEqual(cleared);
    },
  );

  it("resizes and restores a width without reserving the global viewport", async () => {
    const layout = createDockPanelLayout({
      storageKey: "test.dock-panel.inline",
      minHeight: 140,
      minWidth: 260,
      defaultDock: "right",
      supportedDocks: ["right"],
      defaultHeight: 320,
      defaultWidth: 280,
    });
    const reservation = "--oc-test-inline-reserve-right";
    document.documentElement.style.setProperty(reservation, "17px");
    const host = { ...createNotifications(), isEmbedded: () => true };
    const controller = createDockLayout({
      ...host,
      layout,
      reservationPrefix: "test-inline",
      isAvailable: () => true,
      maxWidth: () => 420,
    });

    controller.connect();
    const { container, unmount } = mountResizer(host, controller);
    flush();
    const separator = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "resizable-divider",
    )!;
    await separator.updateComplete;
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

    const restored = createDockLayout({
      ...createNotifications(),
      isEmbedded: () => true,
      layout,
      reservationPrefix: "test-inline",
      isAvailable: () => true,
      maxWidth: () => 420,
    });
    restored.connect();
    expect(restored.width).toBe(380);
    restored.dispose();
    controller.dispose();
    unmount();
    document.documentElement.style.removeProperty(reservation);
  });

  it("exposes keyboard-operable separator semantics for right and bottom docks", async () => {
    const layout = createLayout("right");
    const host = createNotifications();
    const controller = createDockLayout({
      ...host,
      layout,
      reservationPrefix: "test-keyboard",
      isAvailable: () => true,
    });
    controller.connect();

    const { container, unmount } = mountResizer(host, controller);
    flush();
    let separator = container.querySelector("resizable-divider")!;
    await separator.updateComplete;
    expect(separator.getAttribute("role")).toBe("separator");
    expect(separator.getAttribute("tabindex")).toBe("0");
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");

    separator.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }),
    );
    expect(controller.width).toBeLessThan(520);

    controller.setDock("bottom", false);
    flush();
    separator = container.querySelector("resizable-divider")!;
    await separator.updateComplete;
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");

    separator.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowUp" }),
    );
    expect(controller.height).toBeGreaterThan(320);

    controller.dispose();
    unmount();
  });
});
