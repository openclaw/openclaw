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

function mockFullscreen() {
  let current: Element | null = null;
  const properties: readonly (readonly [object, string])[] = [
    [document, "fullscreenElement"],
    [document, "fullscreenEnabled"],
    [document, "exitFullscreen"],
    [Element.prototype, "requestFullscreen"],
  ];
  const descriptors = properties.map(([object, property]) => ({
    object,
    property,
    descriptor: Object.getOwnPropertyDescriptor(object, property),
  }));
  const change = (element: Element | null) => {
    current = element;
    document.dispatchEvent(new Event("fullscreenchange"));
  };
  const exit = vi.fn(async () => change(null));
  const request = vi.fn(async function (this: Element) {
    change(this);
  });
  Object.defineProperties(document, {
    fullscreenElement: { configurable: true, get: () => current },
    fullscreenEnabled: { configurable: true, value: true },
    exitFullscreen: { configurable: true, value: exit },
  });
  Object.defineProperty(Element.prototype, "requestFullscreen", {
    configurable: true,
    value: request,
  });
  return {
    change,
    exit,
    request,
    restore: () => {
      for (const { object, property, descriptor } of descriptors) {
        if (descriptor) {
          Object.defineProperty(object, property, descriptor);
        } else {
          Reflect.deleteProperty(object, property);
        }
      }
    },
  };
}

describe("desktop panel presentation lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("receives global toggles only while mounted as a standalone panel", async () => {
    const request = vi.fn(async () => ({ environments: [] }));
    const panel = createPanel();
    updatePanel(panel, { available: true, client: createGatewayClient(request).client });
    await mountPanel(panel);
    const toggle = (detail: { open: boolean; environmentId?: string }) =>
      window.dispatchEvent(new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, { detail }));
    try {
      toggle({ open: true });
      await panel.updateComplete;
      expect(panel.querySelector("section.bp")).not.toBeNull();

      updatePanel(panel, { embedded: true, presented: true });
      await panel.updateComplete;
      request.mockClear();
      toggle({ open: true, environmentId: "ignored-global-target" });
      await panel.updateComplete;
      expect(request).not.toHaveBeenCalled();

      updatePanel(panel, { embedded: false });
      await panel.updateComplete;
      toggle({ open: false });
      await panel.updateComplete;
      expect(panel.querySelector("section.bp")).toBeNull();

      await unmountPanel(panel);
      request.mockClear();
      toggle({ open: true });
      await panel.updateComplete;
      expect(request).not.toHaveBeenCalled();
    } finally {
      await unmountPanel(panel);
    }
  });

  it("admits one same-turn launch and retires pending feedback with the panel", async () => {
    let launch = createDeferred();
    const environment = {
      ...desktopEnvironment,
      worker: { ...desktopEnvironment.worker, desktopApps: ["browser"] },
    };
    const request = vi.fn(async (method: string) => {
      if (method === "environments.status") {
        return environment;
      }
      if (method === "desktop.observe") {
        return {
          transport: "rfb",
          wsPath: "/desktop/observe?token=launch-test",
          expiresAtMs: 60_000,
          control: false,
        };
      }
      if (method === "desktop.launch") {
        return launch.promise;
      }
      throw new Error(`Unexpected Desktop request: ${method}`);
    });
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle();
    });
    const panel = createPanel();
    updatePanel(panel, {
      client: createGatewayClient(request).client,
      available: true,
      embedded: true,
      presented: true,
      requestedSource: environment.id,
      desktopClientFactory: () => ({ connect }),
    });
    await mountPanel(panel);
    try {
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      const button = panel.querySelector<HTMLButtonElement>(".desktop-app-button")!;
      button.click();
      button.click();
      expect(request.mock.calls.filter(([method]) => method === "desktop.launch")).toHaveLength(1);
      await waitForSolid(() => expect(button.getAttribute("aria-busy")).toBe("true"));
      launch.reject(new Error("App launch unavailable"));
      await waitForSolid(() => {
        expect(panel.textContent).toContain("App launch unavailable");
        expect(button.disabled).toBe(false);
      });

      launch = createDeferred();
      button.click();
      await waitForSolid(() => {
        expect(button.getAttribute("aria-busy")).toBe("true");
        expect(panel.textContent).not.toContain("App launch unavailable");
      });
      await unmountPanel(panel);
      launch.reject(new Error("Retired launch failure"));
      await launch.promise.catch(() => {});
      await waitForSolid(() => expect(panel.childElementCount).toBe(0));
    } finally {
      launch.resolve();
      await unmountPanel(panel);
    }
  });

  it("preserves the desktop panel and returns focus after native fullscreen exits", async () => {
    const fullscreen = mockFullscreen();
    const panel = createPanel();
    try {
      updatePanel(panel, { available: true });
      await mountPanel(panel);
      window.dispatchEvent(new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
      await panel.updateComplete;
      const section = panel.querySelector("section.bp");
      const button = panel.querySelector<HTMLButtonElement>(".desktop-fullscreen-button")!;
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
    } finally {
      await unmountPanel(panel);
      fullscreen.restore();
    }
  });

  it("reports fullscreen failures and exits owned fullscreen when unmounted", async () => {
    const fullscreen = mockFullscreen();
    const panel = createPanel();
    try {
      updatePanel(panel, { available: true });
      await mountPanel(panel);
      window.dispatchEvent(new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
      await panel.updateComplete;
      const button = panel.querySelector<HTMLButtonElement>(".desktop-fullscreen-button")!;
      fullscreen.request.mockRejectedValueOnce(new Error("Fullscreen permission denied"));
      button.click();
      await waitForSolid(() => expect(panel.textContent).toContain("Fullscreen permission denied"));
      button.click();
      await waitForSolid(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
      expect(panel.textContent).not.toContain("Fullscreen permission denied");
      await unmountPanel(panel);
      expect(fullscreen.exit).toHaveBeenCalledOnce();
      expect(document.fullscreenElement).toBeNull();
    } finally {
      await unmountPanel(panel);
      fullscreen.restore();
    }
  });

  it("does not claim fullscreen while its section is unrendered", async () => {
    const properties = ["fullscreenElement", "exitFullscreen"] as const;
    const original = properties.map((name) => Object.getOwnPropertyDescriptor(document, name));
    const exitFullscreen = vi.fn(async () => {});
    Object.defineProperties(document, {
      fullscreenElement: { configurable: true, value: null },
      exitFullscreen: { configurable: true, value: exitFullscreen },
    });
    const panel = createPanel();
    try {
      await mountPanel(panel);
      await panel.updateComplete;
      expect(panel.querySelector("section.bp")).toBeNull();

      document.dispatchEvent(new Event("fullscreenchange"));
      updatePanel(panel, { available: true });
      window.dispatchEvent(new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
      await panel.updateComplete;
      const button = panel.querySelector(".desktop-fullscreen-button");
      expect(button).not.toBeNull();
      expect.soft(button?.getAttribute("aria-pressed")).toBe("false");

      updatePanel(panel, { available: false });
      await panel.updateComplete;
      expect(panel.querySelector("section.bp")).toBeNull();
      await unmountPanel(panel);
      expect(exitFullscreen).not.toHaveBeenCalled();
    } finally {
      await unmountPanel(panel);
      for (const [index, name] of properties.entries()) {
        const descriptor = original[index];
        if (descriptor) {
          Object.defineProperty(document, name, descriptor);
        } else {
          Reflect.deleteProperty(document, name);
        }
      }
    }
  });

  it("preserves Disconnect during source lookup across tab switches until Reconnect", async () => {
    const inventory = createDeferred<unknown>();
    const request = vi.fn((method: string) =>
      method === "environments.status"
        ? inventory.promise
        : Promise.resolve({ transport: "rfb", wsPath: "/desktop/observe", control: false }),
    );
    const connect = vi.fn(async () => createConnectionHandle());
    const panel = createPanel();
    updatePanel(panel, {
      client: createGatewayClient(request).client,
      available: true,
      embedded: true,
      presented: true,
      sessionKey: "main",
      requestedSource: desktopEnvironment.id,
      desktopClientFactory: () => ({ connect }),
    });
    await mountPanel(panel);
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
    updatePanel(panel, { presented: false });
    await panel.updateComplete;
    updatePanel(panel, { presented: true });
    await panel.updateComplete;
    expect(request.mock.calls).toHaveLength(1);
    clickPanelButton(panel, ".desktop-status button");
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    expect(request.mock.calls.filter(([method]) => method === "environments.status")).toHaveLength(
      2,
    );
  });

  it("reuses a briefly hidden viewer and releases it after 30 seconds away", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "environments.list") {
        return { environments: [desktopEnvironment] };
      }
      return {
        transport: "rfb",
        wsPath: "/desktop/observe?token=unit",
        expiresAtMs: 60_000,
        control: false,
      };
    });
    const disconnect = vi.fn();
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle({ disconnect });
    });
    const panel = createPanel();
    updatePanel(panel, {
      client: createGatewayClient(request).client,
      available: true,
      embedded: true,
      presented: true,
      desktopClientFactory: () => ({ connect }),
    });
    await mountPanel(panel);

    await waitForSolid(() => {
      expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(
        1,
      );
      expect(panel.querySelector(".desktop-environment button")).not.toBeNull();
    });
    clickPanelButton(panel);
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    await panel.updateComplete;
    const surface = panel.querySelector(".desktop-surface");
    selectSizing(panel, "actual");
    vi.useFakeTimers();

    updatePanel(panel, { presented: false });
    await panel.updateComplete;

    expect(disconnect).not.toHaveBeenCalled();
    expect(panel.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(29_000);

    updatePanel(panel, { presented: true });
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(disconnect).not.toHaveBeenCalled();
    expect(panel.querySelector(".desktop-surface")).toBe(surface);
    expect(sizingMenu(panel).value).toBe("actual");
    expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "desktop.observe")).toHaveLength(1);
    expect(connect).toHaveBeenCalledOnce();

    updatePanel(panel, { presented: false });
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(panel.querySelector(".desktop-surface")).toBeNull();
    updatePanel(panel, { presented: true });
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(2);
    expect(panel.querySelector(".desktop-picker")).not.toBeNull();
  });

  it("keeps disconnect recovery live when a hide and show share one update", async () => {
    const request = vi.fn(async (method: string) =>
      method === "environments.list"
        ? { environments: [desktopEnvironment] }
        : { transport: "rfb", wsPath: "/desktop/observe", control: false },
    );
    const handle = createConnectionHandle();
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return handle;
    });
    const panel = createPanel();
    updatePanel(panel, {
      client: createGatewayClient(request).client,
      available: true,
      embedded: true,
      presented: true,
      desktopClientFactory: () => ({ connect }),
    });
    await mountPanel(panel);
    await waitForSolid(() =>
      expect(panel.querySelector(".desktop-environment button")).not.toBeNull(),
    );
    clickPanelButton(panel);
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    await panel.updateComplete;

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

  it.each(["session", "source", "client", "unavailable", "unmount"] as const)(
    "immediately releases a hidden viewer on %s change",
    async (change) => {
      const request = vi.fn(async (method: string) =>
        method === "environments.status"
          ? desktopEnvironment
          : { transport: "rfb", wsPath: "/desktop/observe", control: false },
      );
      const handle = createConnectionHandle();
      const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
        options.onConnect?.();
        return handle;
      });
      const panel = createPanel();
      updatePanel(panel, {
        client: createGatewayClient(request).client,
        available: true,
        embedded: true,
        presented: true,
        sessionKey: "main",
        requestedSource: desktopEnvironment.id,
        desktopClientFactory: () => ({ connect }),
      });
      await mountPanel(panel);
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      await panel.updateComplete;
      vi.useFakeTimers();
      updatePanel(panel, { presented: false });
      await panel.updateComplete;
      expect(handle.disconnect).not.toHaveBeenCalled();
      expect(handle.setPresented).toHaveBeenCalledWith(false);
      if (change === "session") {
        updatePanel(panel, { sessionKey: "other" });
      } else if (change === "source") {
        updatePanel(panel, { requestedSource: "node:other" });
      } else if (change === "client") {
        updatePanel(panel, { client: createGatewayClient(request).client });
      } else if (change === "unavailable") {
        updatePanel(panel, { available: false });
      } else {
        await unmountPanel(panel);
      }
      await panel.updateComplete;
      expect(handle.disconnect).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(handle.disconnect).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledOnce();
    },
  );
});
