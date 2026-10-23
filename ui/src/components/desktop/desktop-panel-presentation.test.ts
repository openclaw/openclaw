/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../panel-toggle-contract.ts";
import type { DesktopClient } from "./desktop-client.ts";
import {
  clickPanelButton,
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  desktopEnvironment,
  selectSizing,
  sizingMenu,
  mountPanel,
  unmountPanel,
  updatePanel,
} from "./desktop-panel.test-support.ts";

const restore: (() => void)[] = [];
type Panel = ReturnType<typeof createPanel>;
const observed = { transport: "rfb", wsPath: "/desktop/observe", control: false };
const connecting = (handle = createConnectionHandle()) =>
  vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
    options.onConnect?.();
    return handle;
  });
async function toggle(panel: Panel, detail: { open: boolean; environmentId?: string }) {
  window.dispatchEvent(new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, { detail }));
  await panel.updateComplete;
}
function expectRequests(request: { mock: { calls: unknown[][] } }, method: string, count: number) {
  expect(request.mock.calls.filter(([name]) => name === method)).toHaveLength(count);
}
async function update(panel: Panel, changes: Partial<Panel>) {
  updatePanel(panel, changes);
  await panel.updateComplete;
}
async function viewer(options: Partial<Panel> = {}) {
  const request = vi.fn(async (method: string) =>
    method === (options.requestedSource ? "environments.status" : "environments.list")
      ? options.requestedSource
        ? desktopEnvironment
        : { environments: [desktopEnvironment] }
      : observed,
  );
  const handle = createConnectionHandle();
  const connect = connecting(handle);
  const panel = await mount(request, connect, options);
  if (!options.requestedSource) {
    await waitForSolid(() =>
      expect(panel.querySelector(".desktop-environment button")).not.toBeNull(),
    );
    clickPanelButton(panel);
  }
  await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
  await panel.updateComplete;
  return { request, handle, connect, panel };
}

async function mount(
  request: unknown,
  connect: DesktopClient["connect"],
  options: Partial<Panel> = {},
) {
  const panel = createPanel();
  updatePanel(panel, {
    client: createGatewayClient(request).client,
    available: true,
    embedded: true,
    presented: true,
    desktopClientFactory: () => ({ connect }),
    ...options,
  });
  await mountPanel(panel);
  return panel;
}

async function openStandalone(panel: Panel) {
  updatePanel(panel, { available: true });
  await mountPanel(panel);
  await toggle(panel, { open: true });
  return panel.querySelector<HTMLButtonElement>(".desktop-fullscreen-button")!;
}

function define(object: object, descriptors: PropertyDescriptorMap) {
  for (const property of Object.keys(descriptors)) {
    const original = Object.getOwnPropertyDescriptor(object, property);
    restore.push(() => {
      if (original) {
        Object.defineProperty(object, property, original);
      } else {
        Reflect.deleteProperty(object, property);
      }
    });
  }
  Object.defineProperties(object, descriptors);
}

function mockFullscreen(native = true) {
  let current: Element | null = null;
  const change = (element: Element | null) => {
    current = element;
    document.dispatchEvent(new Event("fullscreenchange"));
  };
  const exit = vi.fn(async () => change(null));
  const request = vi.fn(async function (this: Element) {
    change(this);
  });
  define(document, {
    fullscreenElement: { configurable: true, get: () => current },
    exitFullscreen: { configurable: true, value: exit },
  });
  if (native) {
    define(document, { fullscreenEnabled: { configurable: true, value: true } });
    define(Element.prototype, { requestFullscreen: { configurable: true, value: request } });
  }
  return { change, exit, request };
}

describe("desktop panel presentation lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(async () => {
    for (const panel of document.querySelectorAll("openclaw-desktop-panel")) {
      await unmountPanel(panel);
    }
    for (const cleanup of restore.splice(0)) {
      cleanup();
    }
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["desktop", "mobile"] as const)(
    "keeps the remote surface through control changes and retries through the %s host",
    async (platform) => {
      const request = vi.fn(async (method: string, params?: { control?: boolean }) => {
        if (method === "environments.status") {
          return desktopEnvironment;
        }
        if (method === "desktop.observe") {
          return { ...observed, control: params?.control === true };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const connect = vi.fn(async (_options: Parameters<DesktopClient["connect"]>[0]) =>
        createConnectionHandle(),
      );
      const panel = await mount(request, connect, {
        requestedSource: desktopEnvironment.id,
        presentation: { platform },
      });
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      const surface = panel.querySelector(".desktop-surface");
      expect(surface).not.toBeNull();
      connect.mock.calls[0]![0].onConnect?.();
      await panel.updateComplete;
      const control = panel.querySelector<HTMLButtonElement>(".desktop-rail__control")!;
      expect(control.disabled).toBe(false);
      expect(control.textContent).toContain("Take control");
      control.click();
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(2));
      expect(request).toHaveBeenLastCalledWith(
        "desktop.observe",
        expect.objectContaining({ control: true }),
      );
      expect(panel.querySelector(".desktop-surface")).toBe(surface);
      expect(panel.querySelector<HTMLButtonElement>(".desktop-rail__control")!.disabled).toBe(true);
      connect.mock.calls[1]![0].onConnect?.();
      await panel.updateComplete;
      expect(panel.querySelector(".desktop-surface")).toBe(surface);
      expect(panel.querySelector(".desktop-rail__control")?.textContent).toContain(
        platform === "mobile" ? "View only" : "Back to viewing",
      );
      connect.mock.calls[1]![0].onDisconnect?.({ clean: false, reason: "Synthetic link loss" });
      await panel.updateComplete;
      expect(panel.textContent).toContain("Synthetic link loss");
      expect(panel.querySelector(".desktop-surface")).toBeNull();
      const retry = [...panel.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Reconnect",
      )!;
      expect(retry).toBeDefined();
      retry.click();
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(3));
      expect(request).toHaveBeenLastCalledWith(
        "desktop.observe",
        expect.objectContaining({ control: true }),
      );
    },
  );
  it("receives global toggles only while mounted as a standalone panel", async () => {
    const request = vi.fn(async () => ({ environments: [] }));
    const panel = createPanel();
    updatePanel(panel, { available: true, client: createGatewayClient(request).client });
    await mountPanel(panel);
    await toggle(panel, { open: true });
    expect(panel.querySelector("section.bp")).not.toBeNull();

    await update(panel, { embedded: true, presented: true });
    request.mockClear();
    await toggle(panel, { open: true, environmentId: "ignored-global-target" });
    expect(request).not.toHaveBeenCalled();

    await update(panel, { embedded: false });
    await toggle(panel, { open: false });
    expect(panel.querySelector("section.bp")).toBeNull();

    await unmountPanel(panel);
    request.mockClear();
    await toggle(panel, { open: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("admits one same-turn launch and retires pending feedback with the panel", async () => {
    let launch = createDeferred();
    restore.push(() => launch.resolve());
    const environment = {
      ...desktopEnvironment,
      worker: { ...desktopEnvironment.worker, desktopApps: ["browser"] },
    };
    const request = vi.fn(async (method: string, params?: { environmentId?: string }) => {
      if (method === "environments.status") {
        return { ...environment, id: params?.environmentId ?? environment.id };
      }
      if (method === "desktop.observe") {
        return observed;
      }
      if (method === "desktop.launch") {
        return launch.promise;
      }
      throw new Error(`Unexpected Desktop request: ${method}`);
    });
    const connect = connecting();
    const panel = await mount(request, connect, {
      requestedSource: environment.id,
    });
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    const button = panel.querySelector<HTMLButtonElement>(".desktop-app-button")!;
    const surface = panel.querySelector(".desktop-surface");
    button.click();
    button.click();
    expectRequests(request, "desktop.launch", 1);
    await waitForSolid(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    launch.reject(new Error("App launch unavailable"));
    await waitForSolid(() => {
      expect(panel.textContent).toContain("App launch unavailable");
      expect(button.disabled).toBe(false);
      expect(panel.querySelector(".desktop-app-button")).toBe(button);
      expect(panel.querySelector(".desktop-surface")).toBe(surface);
    });

    launch = createDeferred();
    button.click();
    await waitForSolid(() => {
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(panel.textContent).not.toContain("App launch unavailable");
    });
    await update(panel, { requestedSource: "another-workstation" });
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("environments.status", {
        environmentId: "another-workstation",
      }),
    );
    await unmountPanel(panel);
    launch.reject(new Error("Retired launch failure"));
    await launch.promise.catch(() => {});
    await waitForSolid(() => expect(panel.childElementCount).toBe(0));
  });

  it("preserves the desktop panel and returns focus after native fullscreen exits", async () => {
    const fullscreen = mockFullscreen();
    const panel = createPanel();
    const button = await openStandalone(panel);
    const section = panel.querySelector("section.bp");
    button.click();
    await waitForSolid(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    expect(document.fullscreenElement).toBe(section);
    expect(panel.querySelector("section.bp")).toBe(section);
    expect(panel.querySelector("resizable-divider")).toBeNull();

    button.blur();
    await document.exitFullscreen();
    await waitForSolid(() => expect(button.getAttribute("aria-pressed")).toBe("false"));
    expect(document.activeElement).toBe(button);
    expect(panel.querySelector("resizable-divider")).not.toBeNull();

    fullscreen.change(button);
    await panel.updateComplete;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await unmountPanel(panel);
    expect(fullscreen.exit).toHaveBeenCalledOnce();
  });

  it("reports fullscreen failures and exits owned fullscreen when unmounted", async () => {
    const fullscreen = mockFullscreen();
    const panel = createPanel();
    const button = await openStandalone(panel);
    const section = panel.querySelector("section.bp");
    fullscreen.request.mockRejectedValueOnce(new Error("Fullscreen permission denied"));
    button.click();
    await waitForSolid(() => expect(panel.textContent).toContain("Fullscreen permission denied"));
    expect(panel.querySelector(".desktop-fullscreen-button")).toBe(button);
    expect(panel.querySelector("section.bp")).toBe(section);
    const retry = createDeferred();
    fullscreen.request.mockImplementationOnce(async function (this: Element) {
      await retry.promise;
      fullscreen.change(this);
    });
    button.click();
    await waitForSolid(() =>
      expect(panel.textContent).not.toContain("Fullscreen permission denied"),
    );
    expect(panel.querySelector("section.bp")).toBe(section);
    retry.resolve();
    await waitForSolid(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    expect(panel.textContent).not.toContain("Fullscreen permission denied");
    await unmountPanel(panel);
    expect(fullscreen.exit).toHaveBeenCalledOnce();
    expect(document.fullscreenElement).toBeNull();
  });

  it("does not claim fullscreen while its section is unrendered", async () => {
    const fullscreen = mockFullscreen(false);
    const panel = createPanel();
    await mountPanel(panel);
    await panel.updateComplete;
    expect(panel.querySelector("section.bp")).toBeNull();

    document.dispatchEvent(new Event("fullscreenchange"));
    updatePanel(panel, { available: true });
    await toggle(panel, { open: true });
    const button = panel.querySelector(".desktop-fullscreen-button");
    expect(button).not.toBeNull();
    expect.soft(button?.getAttribute("aria-pressed")).toBe("false");

    await update(panel, { available: false });
    expect(panel.querySelector("section.bp")).toBeNull();
    await unmountPanel(panel);
    expect(fullscreen.exit).not.toHaveBeenCalled();
  });

  it("preserves Disconnect during source lookup across tab switches until Reconnect", async () => {
    const inventory = createDeferred<unknown>();
    const request = vi.fn((method: string) =>
      method === "environments.status" ? inventory.promise : Promise.resolve(observed),
    );
    const connect = vi.fn(async () => createConnectionHandle());
    const panel = await mount(request, connect, {
      sessionKey: "main",
      requestedSource: desktopEnvironment.id,
    });
    await panel.updateComplete;
    clickPanelButton(panel, "[aria-label='Disconnect']");
    await panel.updateComplete;
    inventory.resolve(desktopEnvironment);
    await panel.updateComplete;
    expect(panel.querySelector(".desktop-status > div")?.textContent?.trim()).toBe(
      "Desktop disconnected",
    );
    expect(panel.querySelector("[aria-busy='true']")).toBeNull();
    expect(panel.querySelector(".desktop-status button")?.textContent).toContain("Reconnect");
    await update(panel, { presented: false });
    await update(panel, { presented: true });
    expect(request.mock.calls).toHaveLength(1);
    clickPanelButton(panel, ".desktop-status button");
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    expectRequests(request, "environments.status", 2);
  });

  it("reuses a briefly hidden viewer and releases it after 30 seconds away", async () => {
    const { request, connect, panel, handle } = await viewer();
    const { disconnect } = handle;
    expectRequests(request, "environments.list", 1);
    const surface = panel.querySelector(".desktop-surface");
    selectSizing(panel, "actual");
    vi.useFakeTimers();

    await update(panel, { presented: false });

    expect(disconnect).not.toHaveBeenCalled();
    expect(panel.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(29_000);

    await update(panel, { presented: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(disconnect).not.toHaveBeenCalled();
    expect(panel.querySelector(".desktop-surface")).toBe(surface);
    expect(sizingMenu(panel).value).toBe("actual");
    expectRequests(request, "environments.list", 1);
    expectRequests(request, "desktop.observe", 1);
    expect(connect).toHaveBeenCalledOnce();

    await update(panel, { presented: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(panel.querySelector(".desktop-surface")).toBeNull();
    await update(panel, { presented: true });
    await vi.advanceTimersByTimeAsync(0);
    expectRequests(request, "environments.list", 2);
    expect(panel.querySelector(".desktop-picker")).not.toBeNull();
  });

  it("keeps disconnect recovery live when a hide and show share one update", async () => {
    const { handle, connect, panel } = await viewer();

    updatePanel(panel, { presented: false });
    updatePanel(panel, { presented: true });
    await panel.updateComplete;

    expect(handle.disconnect).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    connect.mock.calls[0]![0].onDisconnect?.({ clean: false, reason: "Desktop connection lost" });
    await panel.updateComplete;
    expect(panel.textContent).toContain("Desktop connection lost");
    expect(panel.querySelector(".desktop-surface")).toBeNull();
    expect(panel.querySelector(".desktop-status button")?.textContent).toContain("Reconnect");
  });

  it.each([
    ["session", { sessionKey: "other" }],
    ["source", { requestedSource: "node:other" }],
    ["client", "client"],
    ["unavailable", { available: false }],
    ["unmount", "unmount"],
  ] as const)("immediately releases a hidden viewer on %s change", async (_name, change) => {
    const { request, handle, connect, panel } = await viewer({
      sessionKey: "main",
      requestedSource: desktopEnvironment.id,
    });
    vi.useFakeTimers();
    await update(panel, { presented: false });
    expect(handle.disconnect).not.toHaveBeenCalled();
    expect(handle.setPresented).toHaveBeenCalledWith(false);
    if (change === "unmount") {
      await unmountPanel(panel);
    } else {
      updatePanel(
        panel,
        change === "client" ? { client: createGatewayClient(request).client } : change,
      );
    }
    await panel.updateComplete;
    expect(handle.disconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.disconnect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });
});
