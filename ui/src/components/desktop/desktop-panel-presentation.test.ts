/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { DesktopClient } from "./desktop-client.ts";
import {
  clickPanelButton,
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  desktopEnvironment,
  selectSizing,
  settleTasks,
  sizingMenu,
} from "./desktop-panel.test-support.ts";

describe("desktop panel presentation lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps one loading indicator mounted from source lookup through RFB authentication", async () => {
    const inventory = createDeferred<unknown>();
    const observe = createDeferred<unknown>();
    const request = vi.fn((method: string) =>
      method === "environments.status" ? inventory.promise : observe.promise,
    );
    const connect = vi.fn(async () => createConnectionHandle());
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.sessionKey = "main";
    panel.requestedSource = desktopEnvironment.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);
    await settleTasks();
    const loading = panel.renderRoot.querySelector("[role='status'][aria-busy='true']");
    expect(loading?.getAttribute("aria-label")).toBe("Connecting to desktop…");
    expect(loading?.shadowRoot?.textContent).toContain("Connecting to desktop…");
    expect(loading?.shadowRoot?.querySelector(".skeleton")).toBeNull();

    inventory.resolve(desktopEnvironment);
    await settleTasks();
    expect(request).toHaveBeenCalledWith("desktop.observe", expect.anything());
    expect(panel.renderRoot.querySelector("[role='status'][aria-busy='true']")).toBe(loading);
    observe.resolve({ transport: "rfb", wsPath: "/desktop/observe", control: false });
    await settleTasks();
    expect(connect).toHaveBeenCalledOnce();
    expect(panel.renderRoot.querySelector("[role='status'][aria-busy='true']")).toBe(loading);
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
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.sessionKey = "main";
    panel.requestedSource = desktopEnvironment.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);
    await settleTasks();
    clickPanelButton(panel, "[aria-label='Disconnect']");
    await settleTasks();
    inventory.resolve(desktopEnvironment);
    await settleTasks();
    expect(panel.renderRoot.querySelector("[aria-busy='true']")).toBeNull();
    expect(panel.renderRoot.querySelector(".desktop-status button")?.textContent).toContain(
      "Reconnect",
    );
    panel.presented = false;
    await panel.updateComplete;
    panel.presented = true;
    await panel.updateComplete;
    await settleTasks();
    expect(request.mock.calls).toHaveLength(1);
    clickPanelButton(panel, ".desktop-status button");
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
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
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() => {
      expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(
        1,
      );
    });
    clickPanelButton(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    await settleTasks();
    const surface = panel.renderRoot.querySelector(".desktop-surface");
    selectSizing(panel, "actual");
    vi.useFakeTimers();

    panel.presented = false;
    await panel.updateComplete;

    expect(disconnect).not.toHaveBeenCalled();
    expect(panel.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(29_000);

    panel.presented = true;
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(disconnect).not.toHaveBeenCalled();
    expect(panel.renderRoot.querySelector(".desktop-surface")).toBe(surface);
    expect(sizingMenu(panel).value).toBe("actual");
    expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "desktop.observe")).toHaveLength(1);
    expect(connect).toHaveBeenCalledOnce();

    panel.presented = false;
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(panel.renderRoot.querySelector(".desktop-surface")).toBeNull();
    panel.presented = true;
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(2);
    expect(panel.renderRoot.querySelector(".desktop-picker")).not.toBeNull();
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
      panel.client = createGatewayClient(request).client;
      panel.available = true;
      panel.embedded = true;
      panel.presented = true;
      panel.sessionKey = "main";
      panel.requestedSource = desktopEnvironment.id;
      panel.desktopClientFactory = () => ({ connect });
      document.body.append(panel);
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      await settleTasks();
      vi.useFakeTimers();
      panel.presented = false;
      await panel.updateComplete;
      expect(handle.disconnect).not.toHaveBeenCalled();
      expect(handle.setPresented).toHaveBeenCalledWith(false);
      if (change === "session") {
        panel.sessionKey = "other";
      } else if (change === "source") {
        panel.requestedSource = "node:other";
      } else if (change === "client") {
        panel.client = createGatewayClient(request).client;
      } else if (change === "unavailable") {
        panel.available = false;
      } else {
        panel.remove();
      }
      await panel.updateComplete;
      expect(handle.disconnect).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(handle.disconnect).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledOnce();
    },
  );
});
