/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { DesktopClient } from "./desktop-client.ts";
import "./desktop-panel.ts";

type Panel = HTMLElementTagNameMap["openclaw-desktop-panel"];
const button = (panel: Panel) =>
  panel.renderRoot.querySelector<HTMLButtonElement>(".desktop-picture-in-picture-button")!;

function createPopup() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const popup = Object.assign(new EventTarget(), {
    document: document.implementation.createHTMLDocument(),
    innerWidth: 640,
    innerHeight: 400,
    devicePixelRatio: 1,
    closed: false,
    close: vi.fn(() => {
      popup.closed = true;
    }),
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    }),
    cancelAnimationFrame: vi.fn((frame: number) => frames.delete(frame)),
  });
  return {
    popup,
    tick: (now: number) => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) {
        callback(now);
      }
    },
    frames,
  };
}

async function setup(mode: "embedded" | "dock" | "document" = "embedded", connected = true) {
  const environment = { id: "gateway", type: "local", status: "available", desktop: true };
  const request = vi.fn(async (method: string) => {
    if (method === "environments.status") {
      return environment;
    }
    if (method === "environments.list") {
      return { environments: [environment] };
    }
    return { transport: "rfb", wsPath: "/desktop/observe?token=fixture", control: false };
  });
  const disconnect = vi.fn();
  let callbacks: Parameters<DesktopClient["connect"]>[0];
  const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
    callbacks = options;
    options.target.append(document.createElement("canvas"));
    if (connected) {
      options.onConnect?.();
    }
    return {
      disconnect,
      disableInput: vi.fn(),
      sendBackspace: vi.fn(),
      sendKeyboardEvent: vi.fn(),
      sendText: vi.fn(),
      setSizingMode: vi.fn(),
    };
  });
  const panel = document.createElement("openclaw-desktop-panel");
  panel.client = { request, addEventListener: () => () => {} } as unknown as GatewayBrowserClient;
  panel.available = true;
  panel.embedded = mode === "embedded";
  panel.presented = true;
  panel.documentMode = mode === "document";
  panel.requestedSource = "gateway";
  panel.desktopClientFactory = () => ({ connect });
  document.body.append(panel);
  if (mode === "dock") {
    panel.handleToggleRequest(
      new CustomEvent("openclaw:desktop-toggle", {
        detail: { open: true, environmentId: "gateway" },
      }),
    );
  }
  await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
  await panel.updateComplete;
  return { panel, request, connect, disconnect, callbacks: callbacks! };
}

describe("Desktop Picture-in-Picture ownership", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("isSecureContext", true);
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["dock", "embedded", "document"] as const)(
    "mirrors %s without reconnecting or changing control; browser close preserves the viewer",
    async (mode) => {
      const { popup, tick, frames } = createPopup();
      const drawImage = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage,
      } as unknown as CanvasRenderingContext2D);
      const requestWindow = vi.fn(async () => popup);
      vi.stubGlobal("documentPictureInPicture", { requestWindow });
      const { panel, request, connect, disconnect } = await setup(mode);
      const source = panel.renderRoot.querySelector("canvas")!;
      button(panel).click();
      // Native request occurs synchronously, while the click still has user activation.
      expect(requestWindow).toHaveBeenCalledOnce();
      await panel.updateComplete;
      await waitForFast(() => expect(button(panel).getAttribute("aria-pressed")).toBe("true"));
      tick(0);
      tick(40);
      expect(drawImage).toHaveBeenCalledTimes(2);
      expect(drawImage).toHaveBeenLastCalledWith(source, 0, 0, 300, 150);
      expect(source.isConnected).toBe(true);
      expect(popup.document.querySelector("canvas")?.getAttribute("role")).toBe("img");
      expect(request.mock.calls.filter(([method]) => method === "desktop.observe")).toHaveLength(1);
      expect(connect).toHaveBeenCalledOnce();
      expect(disconnect).not.toHaveBeenCalled();
      popup.dispatchEvent(new Event("pagehide"));
      await panel.updateComplete;
      expect(button(panel).getAttribute("aria-pressed")).toBe("false");
      expect(frames.size).toBe(0);
      expect(popup.document.querySelector("canvas")).toBeNull();
      expect(disconnect).not.toHaveBeenCalled();
    },
  );

  it.each(["unsupported", "insecure", "connecting"])(
    "does not open PiP while %s",
    async (condition) => {
      const requestWindow = vi.fn();
      if (condition !== "unsupported") {
        vi.stubGlobal("documentPictureInPicture", { requestWindow });
      }
      if (condition === "insecure") {
        vi.stubGlobal("isSecureContext", false);
      }
      const { panel } = await setup("embedded", condition !== "connecting");
      expect(button(panel).disabled).toBe(true);
      button(panel).click();
      expect(requestWindow).not.toHaveBeenCalled();
    },
  );

  it("reports denial without disrupting the connection and permits a retry", async () => {
    const requestWindow = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("documentPictureInPicture", { requestWindow });
    const { panel, disconnect } = await setup();
    button(panel).click();
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector('[role="alert"]')?.textContent).toContain(
        "Check browser permissions",
      ),
    );
    expect(button(panel).disabled).toBe(false);
    button(panel).click();
    expect(requestWindow).toHaveBeenCalledTimes(2);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("does not mount a popup closed before requestWindow resolves", async () => {
    const pending = createDeferred<Window>();
    const { popup } = createPopup();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("documentPictureInPicture", { requestWindow: () => pending.promise });
    const { panel, disconnect } = await setup();
    button(panel).click();
    await panel.updateComplete;
    expect(button(panel).getAttribute("aria-busy")).toBe("true");
    popup.close();
    pending.resolve(popup as unknown as Window);
    await waitForFast(() => expect(button(panel).getAttribute("aria-busy")).toBe("false"));
    expect(button(panel).getAttribute("aria-pressed")).toBe("false");
    expect(popup.document.querySelector("canvas")).toBeNull();
    expect(panel.renderRoot.querySelector('[role="alert"]')).toBeNull();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "source switch", "session switch", "unmount"])(
    "closes late PiP completions after %s",
    async (reason) => {
      const pending = createDeferred<Window>();
      const { popup } = createPopup();
      const requestWindow = vi.fn(() => pending.promise);
      vi.stubGlobal("documentPictureInPicture", { requestWindow });
      const { panel, callbacks } = await setup();
      button(panel).click();
      button(panel).click();
      expect(requestWindow).toHaveBeenCalledOnce();
      if (reason === "disconnect") {
        callbacks.onDisconnect?.({ clean: false });
      } else if (reason === "source switch") {
        panel.requestedSource = "another-machine";
      } else if (reason === "session switch") {
        panel.sessionKey = "agent:main:another-session";
      } else {
        panel.remove();
      }
      await panel.updateComplete;
      pending.resolve(popup as unknown as Window);
      await waitForFast(() => expect(popup.close).toHaveBeenCalledOnce());
      expect(popup.document.querySelector("canvas")).toBeNull();
    },
  );

  it("closes an active mirror on disconnect and stops failed frame copies instead of showing stale pixels", async () => {
    const { popup, tick, frames } = createPopup();
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("documentPictureInPicture", { requestWindow: async () => popup });
    const { panel, callbacks, disconnect } = await setup();
    button(panel).click();
    await waitForFast(() => expect(popup.document.querySelector("canvas")).not.toBeNull());
    drawImage.mockImplementation(() => {
      throw new Error("copy failed");
    });
    tick(0);
    expect(popup.closed).toBe(true);
    expect(frames.size).toBe(0);
    expect(disconnect).not.toHaveBeenCalled();
    popup.closed = false;
    drawImage.mockReset();
    await panel.updateComplete;
    button(panel).click();
    await waitForFast(() => expect(popup.document.querySelector("canvas")).not.toBeNull());
    callbacks.onDisconnect?.({ clean: false });
    expect(popup.closed).toBe(true);
    expect(frames.size).toBe(0);
    expect(popup.document.querySelector("canvas")).toBeNull();
  });
});
