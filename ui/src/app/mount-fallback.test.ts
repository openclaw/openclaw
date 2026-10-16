// Control UI tests cover mount fallback behavior.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const indexHtmlPath = path.resolve(
  process.cwd(),
  path.basename(process.cwd()) === "ui" ? "index.html" : "ui/index.html",
);
type TestWindow = Window & typeof globalThis;
const mountTimeoutMs = 12_000;

async function readIndexHtml(): Promise<string> {
  return readFile(indexHtmlPath, "utf8");
}

function createIsolatedWindow(url?: string): TestWindow {
  const frame = document.createElement("iframe");
  if (url) {
    frame.src = url;
  }
  document.body.append(frame);
  const frameWindow = frame.contentWindow as TestWindow | null;
  if (!frameWindow) {
    throw new Error("failed to create isolated frame window");
  }
  if (url) {
    frameWindow.document.open();
    frameWindow.document.write("<!doctype html><html><head></head><body></body></html>");
    frameWindow.document.close();
  }
  return frameWindow;
}

function installStartupPaintShell(window: TestWindow, html: string): void {
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  window.document.head.innerHTML = parsed.head.innerHTML;
  window.document.body.innerHTML = parsed.body.innerHTML;

  const startupScript = Array.from(
    parsed.querySelectorAll<HTMLScriptElement>("script:not([src])"),
  ).find((script) => script.textContent?.includes("var THEMES = {"));
  if (!startupScript?.textContent) {
    throw new Error("Expected inline startup theme script in index.html");
  }
  window.eval(startupScript.textContent);
}

function installFallbackShell(window: TestWindow, html: string): void {
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  window.document.head.innerHTML = parsed.head.innerHTML;
  window.document.body.innerHTML = parsed.body.innerHTML;

  const sentinel = Array.from(parsed.querySelectorAll<HTMLScriptElement>("script:not([src])")).find(
    (script) => script.textContent?.includes("openclaw-mount-fallback"),
  );
  if (!sentinel?.textContent) {
    throw new Error("Expected inline mount fallback script in index.html");
  }
  window.eval(sentinel.textContent);
}

function requireElementById<T extends HTMLElement>(
  window: TestWindow,
  id: string,
  constructor: new () => T,
): T {
  const element = window.document.getElementById(id);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected #${id}`);
  }
  return element;
}

describe("Control UI document shell", () => {
  it("requests the web app manifest with credentials", async () => {
    const parsed = new DOMParser().parseFromString(await readIndexHtml(), "text/html");
    const manifest = parsed.querySelector<HTMLLinkElement>('link[rel="manifest"]');

    expect(manifest?.getAttribute("crossorigin")).toBe("use-credentials");
  });
});

describe("Control UI mount fallback", () => {
  it("removes only the native-auth navigation hint before the app starts", async () => {
    const frameWindow = createIsolatedWindow(
      "http://localhost:3000/settings/connection?openclaw_http_auth=1&view=compact#details",
    );
    installFallbackShell(frameWindow, await readIndexHtml());
    expect(frameWindow.location.pathname).toBe("/settings/connection");
    expect(frameWindow.location.search).toBe("?view=compact");
    expect(frameWindow.location.hash).toBe("#details");
    frameWindow.dispatchEvent(new frameWindow.Event("openclaw-control-ui-rendered"));
  });
  beforeEach(() => {
    // JSDOM's iframe timers use the host timer functions.
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it.each([
    ["Dash light", { theme: "dash", themeMode: "light" }, "dash-light", "rgb(247, 242, 236)"],
  ])(
    "paints %s before the app stylesheet loads",
    async (_name, settings, expectedTheme, expectedBackground) => {
      const frameWindow = createIsolatedWindow();
      frameWindow.localStorage.clear();
      frameWindow.localStorage.setItem("openclaw.control.settings.v1", JSON.stringify(settings));
      installStartupPaintShell(frameWindow, await readIndexHtml());

      expect(frameWindow.document.documentElement.dataset.theme).toBe(expectedTheme);
      expect(
        frameWindow.getComputedStyle(frameWindow.document.documentElement).backgroundColor,
      ).toBe(expectedBackground);
      expect(frameWindow.getComputedStyle(frameWindow.document.body).backgroundColor).toBe(
        expectedBackground,
      );
    },
  );

  it("keeps the fallback visible until the app completes its first render", async () => {
    const frameWindow = createIsolatedWindow();
    installFallbackShell(frameWindow, await readIndexHtml());
    if (!frameWindow.customElements.get("openclaw-app")) {
      frameWindow.customElements.define("openclaw-app", class extends frameWindow.HTMLElement {});
    }
    await frameWindow.customElements.whenDefined("openclaw-app");
    await vi.advanceTimersByTimeAsync(mountTimeoutMs);

    const fallback = requireElementById(
      frameWindow,
      "openclaw-mount-fallback",
      frameWindow.HTMLElement,
    );
    expect(fallback.hidden).toBe(false);
    expect([...frameWindow.document.body.classList]).toEqual(["openclaw-mount-fallback-active"]);

    frameWindow.dispatchEvent(new frameWindow.Event("openclaw-control-ui-rendered"));

    expect(fallback.hidden).toBe(true);
    expect([...frameWindow.document.body.classList]).toEqual([]);
  });

  it("probes a cache-busted current document when the original bundle did not start", async () => {
    const frameWindow = createIsolatedWindow();
    const html = await readIndexHtml();
    const fetch = vi.fn().mockResolvedValue({ ok: false });
    Object.defineProperty(frameWindow, "fetch", { configurable: true, value: fetch });
    installFallbackShell(frameWindow, html);

    await vi.advanceTimersByTimeAsync(mountTimeoutMs);
    expect(fetch).toHaveBeenCalledOnce();

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("openclaw_mount_recovery="),
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        signal: expect.any(frameWindow.AbortSignal),
      }),
    );
  });

  it("gives a slow module download a fresh grace window after DOMContentLoaded", async () => {
    const frameWindow = createIsolatedWindow();
    const readyState = vi
      .spyOn(frameWindow.document, "readyState", "get")
      .mockReturnValue("loading");
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    Object.defineProperty(frameWindow, "fetch", { configurable: true, value: fetch });
    installFallbackShell(frameWindow, await readIndexHtml());
    await vi.advanceTimersByTimeAsync(mountTimeoutMs + 1_000);
    expect(fetch).not.toHaveBeenCalled();
    readyState.mockReturnValue("interactive");
    frameWindow.document.dispatchEvent(new frameWindow.Event("DOMContentLoaded"));
    await vi.advanceTimersByTimeAsync(mountTimeoutMs - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([2, 3])("bounds recovery navigations after attempt %s", async (attempt) => {
    const frameWindow = createIsolatedWindow(
      `http://localhost:3000/?openclaw_mount_recovery=${attempt}`,
    );
    vi.spyOn(frameWindow.document, "readyState", "get").mockReturnValue("complete");
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    Object.defineProperty(frameWindow, "fetch", { configurable: true, value: fetch });
    installFallbackShell(frameWindow, await readIndexHtml());
    await vi.advanceTimersByTimeAsync(mountTimeoutMs);
    if (attempt < 3) {
      expect(fetch).toHaveBeenCalledOnce();
      expect(new URL(fetch.mock.calls[0]![0]).searchParams.get("openclaw_mount_recovery")).toBe(
        String(attempt + 1),
      );
    } else {
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("does not begin recovery while the unsupported browser screen is loading", async () => {
    const frameWindow = createIsolatedWindow();
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(frameWindow, "fetch", { configurable: true, value: fetch });
    installFallbackShell(frameWindow, await readIndexHtml());

    frameWindow.dispatchEvent(new frameWindow.Event("openclaw-control-ui-unsupported-browser"));
    await vi.advanceTimersByTimeAsync(mountTimeoutMs * 3);

    expect(fetch).not.toHaveBeenCalled();
    expect(frameWindow.document.getElementById("openclaw-mount-fallback")?.hidden).toBe(true);
  });

  it("times out stalled recovery probes so automatic retries can continue", async () => {
    const frameWindow = createIsolatedWindow();
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof frameWindow.AbortSignal)) {
        throw new Error("Expected recovery probe to include an abort signal");
      }
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
      });
    });
    Object.defineProperty(frameWindow, "fetch", { configurable: true, value: fetch });
    installFallbackShell(frameWindow, await readIndexHtml());
    await vi.advanceTimersByTimeAsync(200_000);

    expect(fetch.mock.calls.length).toBeGreaterThan(6);
    expect(signals.slice(0, 6).every((signal) => signal.aborted)).toBe(true);
    frameWindow.dispatchEvent(new frameWindow.Event("openclaw-control-ui-rendered"));
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it.each(["Keep waiting", "first render", "unsupported browser"])(
    "retires a pending recovery probe on %s",
    async (action) => {
      const frameWindow = createIsolatedWindow();
      const fetch = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")));
          }),
      );
      Object.defineProperty(frameWindow, "fetch", { configurable: true, value: fetch });
      installFallbackShell(frameWindow, await readIndexHtml());
      await vi.advanceTimersByTimeAsync(mountTimeoutMs);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

      if (action === "Keep waiting") {
        frameWindow.document.getElementById("openclaw-mount-wait")?.click();
      } else {
        frameWindow.dispatchEvent(
          new frameWindow.Event(
            action === "first render"
              ? "openclaw-control-ui-rendered"
              : "openclaw-control-ui-unsupported-browser",
          ),
        );
      }
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(fetch).toHaveBeenCalledOnce();
      expect(frameWindow.document.getElementById("openclaw-mount-fallback")?.hidden).toBe(true);
    },
  );

  it("keeps probing beyond six failures while the gateway is unavailable", async () => {
    const frameWindow = createIsolatedWindow();
    const fetch = vi.fn().mockRejectedValue(new Error("gateway unavailable"));
    const unregister = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi.fn().mockResolvedValue([{ unregister }]);
    Object.defineProperty(frameWindow, "fetch", { configurable: true, value: fetch });
    Object.defineProperty(frameWindow.navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistrations },
    });
    installFallbackShell(frameWindow, await readIndexHtml());
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetch.mock.calls.length).toBeGreaterThan(6);
    expect(unregister).not.toHaveBeenCalled();
    expect(getRegistrations).not.toHaveBeenCalled();
    expect(
      requireElementById(
        frameWindow,
        "openclaw-mount-fallback-summary",
        frameWindow.HTMLParagraphElement,
      ).textContent,
    ).toContain("will keep retrying");
    frameWindow.dispatchEvent(new frameWindow.Event("openclaw-control-ui-rendered"));
  });
});
