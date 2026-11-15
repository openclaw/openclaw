/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createFrameClock } from "../../test-helpers/animation-frame-clock.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { DesktopClient } from "./desktop-client.ts";
import * as panels from "./desktop-panel.test-support.ts";

function toggle(panel: ReturnType<typeof panels.createPanel>, open: boolean) {
  const detail = open ? { open, environmentId: "gateway" } : { open };
  panel.handleToggleRequest(new CustomEvent("openclaw:desktop-toggle", { detail }));
}

async function setup(mode: "mirror" | "pending" | "denied" = "mirror", docked = false) {
  const framesClock = createFrameClock();
  const frames = framesClock.frames;

  const popup = Object.assign(new EventTarget(), {
    document: document.implementation.createHTMLDocument(),
    innerWidth: 640,
    innerHeight: 400,
    devicePixelRatio: 1,
    closed: false,
    close: vi.fn(() => {
      popup.closed = true;
    }),
    requestAnimationFrame: vi.fn(framesClock.request),
    cancelAnimationFrame: vi.fn(framesClock.cancel),
  });
  const pending = createDeferred<Window>();
  const requestWindow = vi.fn(async () => {
    if (mode === "denied") {
      throw new DOMException("denied", "NotAllowedError");
    }
    return mode === "pending" ? pending.promise : popup;
  });
  vi.stubGlobal("documentPictureInPicture", { requestWindow });
  const drawImage = vi.fn();
  if (mode === "mirror") {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
  }
  const environment = { id: "gateway", type: "local", status: "available", desktop: true };
  const request = vi.fn(async (method: string) =>
    method === "environments.status"
      ? environment
      : method === "environments.list"
        ? { environments: [environment] }
        : { transport: "rfb", wsPath: "/desktop/observe?token=fixture", control: false },
  );
  const disconnect = vi.fn();
  const connection = panels.createConnectionHandle({ disconnect });
  const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
    options.target.append(document.createElement("canvas"));
    options.onConnect?.();
    return connection;
  });
  const panel = panels.createPanel();
  panels.updatePanel(panel, {
    client: { request, addEventListener: () => () => {} } as unknown as GatewayBrowserClient,
    available: true,
    embedded: !docked,
    presented: true,
    requestedSource: "gateway",
    desktopClientFactory: () => ({ connect }),
  });
  await panels.mountPanel(panel);
  if (docked) {
    toggle(panel, true);
  }
  await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
  await panel.updateComplete;
  const button = () =>
    panel.querySelector<HTMLButtonElement>(".desktop-picture-in-picture-button")!;
  const canvas = () => popup.document.querySelector("canvas");
  return {
    panel,
    popup,
    request,
    connect,
    requestWindow,
    drawImage,
    frames,
    button,
    canvas,
    alert: () => panel.querySelector('[role="alert"]'),
    disconnect,
    callbacks: connect.mock.calls[0]![0],
    state: () => ({
      busy: button().getAttribute("aria-busy"),
      pressed: button().getAttribute("aria-pressed"),
    }),
    resolve: () => pending.resolve(popup as unknown as Window),
    open: async () => {
      button().click();
      await waitForSolid(() => expect(canvas()).not.toBeNull());
    },
    tick: (now: number) => {
      framesClock.flush(now);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("isSecureContext", true);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("accepts a native close before the Solid panel mounts", () => {
  const panel = document.createElement("openclaw-desktop-panel");
  expect(() => toggle(panel, false)).not.toThrow();
});

it("mirrors dock without reconnecting or changing control; browser close preserves the viewer", async () => {
  const f = await setup("mirror", true);
  const source = f.panel.querySelector("canvas")!;
  f.button().click();
  // The native request must retain the click's user activation.
  expect(f.requestWindow).toHaveBeenCalledOnce();
  await waitForSolid(() => expect(f.state()).toMatchObject({ pressed: "true" }));
  f.tick(0);
  f.tick(40);
  expect(f.drawImage).toHaveBeenCalledTimes(2);
  expect(f.drawImage).toHaveBeenLastCalledWith(source, 0, 0, 300, 150);
  expect(source.isConnected).toBe(true);
  expect(f.canvas()?.getAttribute("role")).toBe("img");
  expect(f.request.mock.calls.filter(([method]) => method === "desktop.observe")).toHaveLength(1);
  expect([f.connect.mock.calls.length, f.disconnect.mock.calls.length]).toEqual([1, 0]);
  f.popup.dispatchEvent(new Event("pagehide"));
  await waitForSolid(() => expect(f.state()).toMatchObject({ pressed: "false" }));
  expect([f.frames.size, f.canvas(), f.disconnect.mock.calls.length]).toEqual([0, null, 0]);
});

it("mirrors the published opener palette only while PiP is open", async () => {
  const root = document.documentElement;
  const original = ["style", "data-theme"].map((key) => [key, root.getAttribute(key)] as const);
  const dark = ["dark", "rgb(23 39 45)", "rgb(221 242 239)"] as const;
  const light = ["light", "rgb(233 246 238)", "rgb(25 51 36)"] as const;
  const custom = ["light", "rgb(234 216 240)", "rgb(55 22 66)"] as const;
  type Palette = readonly [string, string, string];
  const publish = ([mode, bg, text]: Palette) => {
    root.dataset.theme = mode;
    root.style.colorScheme = mode;
    root.style.setProperty("--bg", bg);
    root.style.setProperty("--text", text);
  };
  try {
    publish(dark);
    const f = await setup();
    const style = f.popup.document.documentElement.style;
    const check = (palette: Palette) =>
      expect(["color-scheme", "--bg", "--text"].map((key) => style.getPropertyValue(key))).toEqual(
        palette,
      );
    const change = async (palette: Palette, expected = palette) => {
      publish(palette);
      await Promise.resolve();
      check(expected);
    };
    expect(f.connect.mock.calls[0]?.[0].background).toBe("var(--bg)");
    await f.open();
    check(dark);
    await change(light);
    // Same mode and theme ID, different custom palette.
    await change(custom);
    f.popup.dispatchEvent(new Event("pagehide"));
    await change(dark, custom);
    f.popup.closed = false;
    await f.panel.updateComplete;
    await f.open();
    check(dark);
    await panels.unmountPanel(f.panel);
    await change(light, dark);
    expect(f.connect).toHaveBeenCalledOnce();
  } finally {
    for (const [key, value] of original) {
      if (value === null) {
        root.removeAttribute(key);
      } else {
        root.setAttribute(key, value);
      }
    }
  }
});

it("reports denial without disrupting the connection and permits a retry", async () => {
  const f = await setup("denied");
  const button = f.button();
  const surface = f.panel.querySelector(".desktop-surface");
  button.click();
  button.click();
  expect(f.requestWindow).toHaveBeenCalledOnce();
  await waitForSolid(() => expect(f.alert()?.textContent).toContain("Check browser permissions"));
  expect(f.button().disabled).toBe(false);
  expect(f.button()).toBe(button);
  expect(f.panel.querySelector(".desktop-surface")).toBe(surface);
  const retry = createDeferred<Window>();
  f.requestWindow.mockImplementationOnce(() => retry.promise);
  f.button().click();
  expect([f.requestWindow.mock.calls.length, f.disconnect.mock.calls.length]).toEqual([2, 0]);
  await waitForSolid(() => {
    expect(f.alert()).toBeNull();
    expect(button.disabled).toBe(true);
  });
  retry.reject(new DOMException("denied", "NotAllowedError"));
  await waitForSolid(() => expect(f.alert()?.textContent).toContain("Check browser permissions"));
});

type Fixture = Awaited<ReturnType<typeof setup>>;
it.each<[string, (fixture: Fixture) => void | Promise<void>]>([
  ["browser close", (f) => f.popup.close()],
  ["disconnect", (f) => f.callbacks.onDisconnect?.({ clean: false })],
  ["source switch", (f) => panels.updatePanel(f.panel, { requestedSource: "another-machine" })],
  [
    "session switch",
    (f) => panels.updatePanel(f.panel, { sessionKey: "agent:main:another-session" }),
  ],
  [
    "hidden",
    async (f) => {
      panels.updatePanel(f.panel, { presented: false });
      await waitForSolid(() => expect(f.state()).toMatchObject({ busy: "true" }));
    },
  ],
  ["unmount", (f) => panels.unmountPanel(f.panel)],
])("closes late PiP completions after %s", async (reason, invalidate) => {
  const f = await setup("pending");
  f.button().click();
  f.button().click();
  expect(f.requestWindow).toHaveBeenCalledOnce();
  await waitForSolid(() => expect(f.state()).toMatchObject({ busy: "true" }));
  await invalidate(f);
  await f.panel.updateComplete;
  f.resolve();
  await waitForSolid(() =>
    expect(f.popup.close).toHaveBeenCalledTimes(reason === "browser close" ? 2 : 1),
  );
  expect(f.canvas()).toBeNull();
  if (reason === "browser close") {
    await waitForSolid(() => expect(f.state()).toEqual({ busy: "false", pressed: "false" }));
    expect(f.alert()).toBeNull();
    expect(f.disconnect).not.toHaveBeenCalled();
  }
});

it("closes an active mirror on disconnect and stops failed frame copies instead of showing stale pixels", async () => {
  const f = await setup();
  await f.open();
  f.drawImage.mockImplementation(() => {
    throw new Error("copy failed");
  });
  f.tick(0);
  expect([f.popup.closed, f.frames.size, f.disconnect.mock.calls.length]).toEqual([true, 0, 0]);
  await waitForSolid(() => expect(f.alert()?.textContent).toContain("Check browser permissions"));
  f.popup.closed = false;
  f.drawImage.mockReset();
  await f.panel.updateComplete;
  await f.open();
  f.callbacks.onDisconnect?.({ clean: false });
  expect([f.popup.closed, f.frames.size, f.canvas()]).toEqual([true, 0, null]);
});
