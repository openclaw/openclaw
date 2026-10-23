import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./browser-panel.ts";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  stubScreenshotMedia,
  openBrowserActions,
} from "./browser-panel-controller-test-support.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";
import { createBrowserPageClient } from "./test-helpers/browser-page.ts";

function attachAnnotationOverlay(panel: HTMLElement) {
  const stage = panel.querySelector<HTMLElement>(".bp-stage")!;
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  });
  const overlay = stage.querySelector("canvas")!;
  const capturedPointers = new Set<number>();
  overlay.setPointerCapture = vi.fn((pointerId) => capturedPointers.add(pointerId));
  overlay.hasPointerCapture = vi.fn((pointerId) => capturedPointers.has(pointerId));
  overlay.releasePointerCapture = vi.fn((pointerId) => capturedPointers.delete(pointerId));

  const dispatchPointer = (
    type: "pointerdown" | "pointermove" | "pointerup",
    clientX: number,
    clientY: number,
  ) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
    Object.defineProperty(event, "pointerId", { configurable: true, value: 7 });
    overlay.dispatchEvent(event);
  };
  return { capturedPointers, dispatchPointer };
}

describe("normalizeBrowserUrlDraft", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("prefixes bare hosts with https", () => {
    expect(normalizeBrowserUrlDraft("example.com")).toBe("https://example.com/");
    expect(normalizeBrowserUrlDraft("  github.com/openclaw/openclaw ")).toBe(
      "https://github.com/openclaw/openclaw",
    );
  });

  it("rejects empty and non-http(s) inputs", () => {
    expect(normalizeBrowserUrlDraft("   ")).toBeNull();
    expect(normalizeBrowserUrlDraft("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrlDraft("file:///etc/passwd")).toBeNull();
  });

  it("restores persisted open state when a mounted tag upgrades lazily", async () => {
    localStorage.setItem(
      "openclaw.browser.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
    const tagName = `test-lazy-browser-panel-${crypto.randomUUID()}`;
    const element = document.createElement(tagName) as HTMLElement & { available: boolean };
    element.available = true;
    mountSolid(() => element);

    const BrowserPanel = customElements.get("openclaw-browser-panel");
    if (!BrowserPanel) {
      throw new Error("expected browser panel registration");
    }
    class LazyUpgradeBrowserPanel extends BrowserPanel {}
    customElements.define(tagName, LazyUpgradeBrowserPanel);
    const panel = element as unknown as HTMLElement & {
      browserPanelIsOpen(): boolean;
      updateComplete: Promise<unknown>;
    };
    await panel.updateComplete;
    expect(panel.browserPanelIsOpen()).toBe(true);
  });

  it("renders the initial asynchronous refresh and retains the page while its screenshot updates", async () => {
    stubScreenshotMedia();
    const response = createDeferred<unknown>();
    let refreshed = false;
    const url = "https://example.test/page";
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.client = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return response.promise;
      }
      if (envelope.path === "/screenshot") {
        return { path: refreshed ? "/fresh.png" : "/old.png", targetId: "raw-tab-a", url };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(url, refreshed ? "Updated page" : "First page");
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    }).client;
    mountSolid(() => panel);
    await waitForSolid(() => {
      expect(panel.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
      expect(panel.querySelector(".bp-viewport")?.getAttribute("aria-busy")).toBe("true");
    });

    response.resolve({
      running: true,
      tabs: [createBrowserPanelTestTab("tab-a", url, "First page")],
    });
    await waitForSolid(() => {
      expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
      expect(panel.querySelector(".bp-shot")?.getAttribute("alt")).toBe("First page");
    });
    const stage = panel.querySelector(".bp-stage");
    const image = panel.querySelector(".bp-shot");
    const input = panel.querySelector(".bp-input");
    const previousSource = image?.getAttribute("src");
    refreshed = true;
    panel.handleToggleRequest(
      new CustomEvent("openclaw:browser-toggle", { detail: { open: true } }),
    );
    await waitForSolid(() => {
      expect(image?.getAttribute("src")).not.toBe(previousSource);
      expect(image?.getAttribute("alt")).toBe("Updated page");
    });
    expect(panel.querySelector(".bp-stage")).toBe(stage);
    expect(panel.querySelector(".bp-shot")).toBe(image);
    expect(panel.querySelector(".bp-input")).toBe(input);
  });

  it.each([true])(
    "keeps refresh feedback out of an existing page (retained: %s)",
    async (retained) => {
      stubScreenshotMedia();
      const response = createDeferred<unknown>();
      const gateway = createBrowserPageClient("tab-a");
      const panel = document.createElement("openclaw-browser-panel");
      panel.available = true;
      panel.embedded = true;
      panel.presented = true;
      panel.client = gateway.client;
      mountSolid(() => panel);
      await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
      gateway.request.mockImplementation(async () => response.promise);
      const preview = panel.querySelector(".bp-shot");
      const input = panel.querySelector<HTMLTextAreaElement>(".bp-input");
      input?.focus();
      panel.handleToggleRequest(
        new CustomEvent("openclaw:browser-toggle", { detail: { open: true } }),
      );
      await panel.updateComplete;

      expect(panel.querySelector(".bp-shot")).toBe(preview);
      expect(panel.querySelector("openclaw-panel-loading-skeleton") !== null).toBe(!retained);
      const reload = panel.querySelector('button[aria-label="Reload"]');
      expect(reload?.getAttribute("aria-busy")).toBe("true");
      expect(panel.querySelector(".bp-viewport")?.getAttribute("aria-busy")).toBe("true");
      if (retained) {
        expect(document.activeElement).toBe(input);
      }

      response.reject(new Error("Refresh connection interrupted"));
      await waitForSolid(() => expect(reload?.getAttribute("aria-busy")).toBe("false"));

      expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
      expect(panel.querySelector(".bp-shot")).toBe(preview);
      expect(reload?.getAttribute("aria-busy")).toBe("false");
      expect(panel.querySelector('[role="alert"]')?.textContent).toContain(
        "Refresh connection interrupted",
      );
    },
  );

  it("keeps an open dock's reservation while an embedded panel renders and unmounts", async () => {
    localStorage.setItem(
      "openclaw.browser.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
    type TestPanel = HTMLElement & {
      available: boolean;
      presented: boolean;
      handleToggleRequest: (event: Event) => void;
      updateComplete: Promise<unknown>;
    };
    const dock = document.createElement("openclaw-browser-panel") as unknown as TestPanel;
    const embedded = document.createElement("openclaw-browser-panel") as unknown as TestPanel;
    // Chat side panels mount their Browser with the static `embedded` attribute.
    embedded.setAttribute("embedded", "");
    dock.available = embedded.available = true;
    mountSolid(() => [dock, embedded]);
    await Promise.all([dock.updateComplete, embedded.updateComplete]);
    const reservation = () =>
      document.documentElement.style.getPropertyValue("--oc-browser-reserve-right");
    expect(reservation()).toBe("560px");

    embedded.presented = true;
    await embedded.updateComplete;
    expect(reservation()).toBe("560px");
    embedded.remove();
    expect(reservation()).toBe("560px");

    dock.handleToggleRequest(
      new CustomEvent("openclaw:browser-toggle", { detail: { open: false } }),
    );
    expect(reservation()).toBe("0px");
  });

  it("waits for availability before restoring after suppression", async () => {
    localStorage.setItem(
      "openclaw.browser.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      available: boolean;
      suppressed: boolean;
      browserPanelIsOpen(): boolean;
      updateComplete: Promise<unknown>;
    };
    panel.suppressed = true;
    mountSolid(() => panel);
    await panel.updateComplete;

    panel.suppressed = false;
    await panel.updateComplete;
    expect(panel.browserPanelIsOpen()).toBe(false);

    panel.available = true;
    await waitForSolid(() => expect(panel.browserPanelIsOpen()).toBe(true));
  });

  it("mounts closed inside a takeover instead of refreshing a hidden dock", async () => {
    localStorage.setItem(
      "openclaw.browser.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
    const requests: string[] = [];
    const client = {
      request: async <T>(method: string) => {
        requests.push(method);
        return {} as T;
      },
    } as GatewayBrowserClient;
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      client: GatewayBrowserClient | null;
      available: boolean;
      suppressed: boolean;
      browserPanelIsOpen(): boolean;
      updateComplete: Promise<unknown>;
    };
    panel.client = client;
    panel.available = true;
    panel.suppressed = true;
    mountSolid(() => panel);
    await panel.updateComplete;
    await Promise.resolve();

    expect(panel.browserPanelIsOpen()).toBe(false);
    expect(requests).toEqual([]);

    panel.suppressed = false;
    await waitForSolid(() => expect(panel.browserPanelIsOpen()).toBe(true));
  });

  it("undoes one annotation and clears the rest across retained panel updates", async () => {
    stubScreenshotMedia();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.client = createBrowserPageClient("target-1").client;
    mountSolid(() => panel);
    await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
    (await openBrowserActions(panel))
      .querySelector<HTMLElement>('[role="menuitem"][aria-label="Annotate page"]')!
      .click();
    await panel.updateComplete;
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>(".bp-annotatebar button")];
    const undo = buttons[0]!;
    const clear = buttons[1]!;
    expect(buttons.map((button) => button.title || button.textContent?.trim())).toEqual([
      "Undo",
      "Clear",
      "Exit annotate mode",
      "Send to chat",
    ]);
    const { dispatchPointer } = attachAnnotationOverlay(panel);
    for (const retained of [false, true]) {
      if (retained) {
        panel.tabsInHeader = true;
        await panel.updateComplete;
        expect([...panel.querySelectorAll(".bp-annotatebar button")]).toEqual(buttons);
      }
      expect(undo.disabled).toBe(true);
      expect(clear.disabled).toBe(true);
      for (const x of [10, 30]) {
        dispatchPointer("pointerdown", x, 20);
        dispatchPointer("pointermove", x + 10, 40);
        dispatchPointer("pointerup", x + 10, 40);
      }
      await panel.updateComplete;
      expect(undo.disabled).toBe(false);
      expect(clear.disabled).toBe(false);
      undo.click();
      await panel.updateComplete;
      expect(undo.disabled).toBe(false);
      expect(clear.disabled).toBe(false);
      clear.click();
      await panel.updateComplete;
      expect(undo.disabled).toBe(true);
      expect(clear.disabled).toBe(true);
    }
  });

  it.each(["close", "suppress", "disconnect"] as const)(
    "ends an active annotation gesture on panel %s",
    async (transition) => {
      localStorage.setItem(
        "openclaw.browser.panel.v1",
        JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
      );
      stubScreenshotMedia();
      const paint = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
      const panel = document.createElement("openclaw-browser-panel");
      panel.available = true;
      panel.client = createBrowserPageClient("target-1").client;
      mountSolid(() => panel);
      await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
      (await openBrowserActions(panel))
        .querySelector<HTMLElement>('[role="menuitem"][aria-label="Annotate page"]')!
        .click();
      await panel.updateComplete;
      const { capturedPointers, dispatchPointer } = attachAnnotationOverlay(panel);
      dispatchPointer("pointerdown", 10, 20);
      expect(capturedPointers.has(7)).toBe(true);

      if (transition === "close") {
        panel.handleToggleRequest(
          new CustomEvent("openclaw:browser-toggle", { detail: { open: false } }),
        );
      } else if (transition === "suppress") {
        panel.suppressed = true;
        await panel.updateComplete;
      } else {
        panel.remove();
        await waitForSolid(() => expect(capturedPointers.has(7)).toBe(false));
      }

      expect(capturedPointers.has(7)).toBe(false);
      paint.mockClear();
      dispatchPointer("pointermove", 30, 40);
      expect(paint).not.toHaveBeenCalled();
    },
  );

  it("settles a pending render when the panel is disposed", async () => {
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    const mounted = mountSolid(() => panel);
    await panel.updateComplete;
    panel.tabsInHeader = true;
    const pending = panel.updateComplete;
    mounted.unmount();
    await expect(pending).resolves.toBe(false);
  });

  it("starts a fresh browser tab draft when an embedded panel receives a new-tab request", async () => {
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      available: boolean;
      embedded: boolean;
      presented: boolean;
      handleToggleRequest: (event: Event) => void;
      updateComplete: Promise<unknown>;
    };
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    mountSolid(() => panel);
    await panel.updateComplete;

    panel.handleToggleRequest(
      new CustomEvent("openclaw:browser-toggle", { detail: { open: true, newTab: true } }),
    );
    await panel.updateComplete;
    await Promise.resolve();

    expect(document.activeElement).toBe(panel.querySelector(".bp-url"));
  });
});
