import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const indexHtmlPath = path.resolve(
  process.cwd(),
  path.basename(process.cwd()) === "ui" ? "index.html" : "ui/index.html",
);
type TestWindow = Window & typeof globalThis;
const mountTimeoutMs = 12_000;

let html: string;
beforeEach(async () => {
  html = await readFile(indexHtmlPath, "utf8");
});

function createIsolatedWindow(url?: string, fetch?: TestWindow["fetch"]): TestWindow {
  const frame = document.createElement("iframe");
  if (url) {
    frame.src = url;
  }
  document.body.append(frame);
  const win = frame.contentWindow as TestWindow | null;
  if (!win) {
    throw new Error("failed to create isolated frame window");
  }
  if (url) {
    win.document.open();
    win.document.write("<!doctype html><html><head></head><body></body></html>");
    win.document.close();
  }
  if (fetch) {
    Object.defineProperty(win, "fetch", { configurable: true, value: fetch });
  }
  return win;
}

function installShell(window: TestWindow, marker = "openclaw-mount-fallback"): void {
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  window.document.head.innerHTML = parsed.head.innerHTML;
  window.document.body.innerHTML = parsed.body.innerHTML;

  const script = Array.from(parsed.querySelectorAll<HTMLScriptElement>("script:not([src])")).find(
    (candidate) => candidate.textContent?.includes(marker),
  );
  if (!script?.textContent) {
    throw new Error(`Expected inline ${marker} script in index.html`);
  }
  window.eval(script.textContent);
}

function fallbackElement(win: TestWindow) {
  const element = win.document.getElementById("openclaw-mount-fallback");
  expect(element).toBeInstanceOf(win.HTMLElement);
  return element!;
}

function boot(fetch?: TestWindow["fetch"], url?: string, ready?: DocumentReadyState) {
  const win = createIsolatedWindow(url, fetch);
  if (ready) {
    vi.spyOn(win.document, "readyState", "get").mockReturnValue(ready);
  }
  installShell(win);
  return win;
}

const rendered = (win: TestWindow) =>
  win.dispatchEvent(new win.Event("openclaw-control-ui-rendered"));

function pendingProbe(stalled = true) {
  const win = createIsolatedWindow();
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((_url: string, init?: RequestInit) => {
    if (!stalled) {
      return Promise.reject(new Error("gateway unavailable"));
    }
    const signal = init?.signal;
    if (!(signal instanceof win.AbortSignal)) {
      throw new Error("Expected recovery abort signal");
    }
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
    });
  });
  Object.defineProperty(win, "fetch", { configurable: true, value: fetch });
  return { win, fetch, signals };
}

describe("Control UI document shell", () => {
  it.each(["load", "error"])("activates the nonblocking entry stylesheet on %s", (eventType) => {
    const win = createIsolatedWindow();
    installShell(win, "__zod_globalConfig");
    const link = win.document.createElement("link");
    link.id = "openclaw-boot-styles";
    link.rel = "stylesheet";
    link.media = "print";
    win.document.head.append(link);
    link.dispatchEvent(new win.Event(eventType));
    expect(link.media).toBe("all");
  });

  it("requests the web app manifest with credentials", async () => {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const manifest = parsed.querySelector<HTMLLinkElement>('link[rel="manifest"]');

    expect(manifest?.getAttribute("crossorigin")).toBe("use-credentials");
  });
});

describe("Control UI mount fallback", () => {
  it("removes only the native-auth navigation hint before the app starts", async () => {
    const win = boot(
      undefined,
      "http://localhost:3000/settings/connection?openclaw_http_auth=1&view=compact#details",
    );
    expect(win.location).toMatchObject({
      pathname: "/settings/connection",
      search: "?view=compact",
      hash: "#details",
    });
    rendered(win);
  });
  beforeEach(() => {
    // JSDOM's iframe timers use the host timer functions.
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("paints Dash light before the app stylesheet loads", async () => {
    const win = createIsolatedWindow();
    win.localStorage.clear();
    win.localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({ theme: "dash", themeMode: "light" }),
    );
    installShell(win, "var THEMES = {");

    expect(win.document.documentElement.dataset.theme).toBe("dash-light");
    expect(
      [win.document.documentElement, win.document.body].map(
        (element) => win.getComputedStyle(element).backgroundColor,
      ),
    ).toEqual(["rgb(247, 242, 236)", "rgb(247, 242, 236)"]);
  });

  it("keeps the fallback visible until the app completes its first render", async () => {
    const win = boot();
    if (!win.customElements.get("openclaw-app")) {
      win.customElements.define("openclaw-app", class extends win.HTMLElement {});
    }
    await win.customElements.whenDefined("openclaw-app");
    await vi.advanceTimersByTimeAsync(mountTimeoutMs);

    const fallback = fallbackElement(win);
    expect(fallback.hidden).toBe(false);
    expect([...win.document.body.classList]).toEqual(["openclaw-mount-fallback-active"]);

    rendered(win);

    expect(fallback.hidden).toBe(true);
    expect([...win.document.body.classList]).toEqual([]);
  });

  it("probes a cache-busted current document when the original bundle did not start", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false });
    const win = boot(fetch);

    await vi.advanceTimersByTimeAsync(mountTimeoutMs);
    expect(fetch).toHaveBeenCalledOnce();

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("openclaw_mount_recovery="),
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        signal: expect.any(win.AbortSignal),
      }),
    );
  });

  it("gives a slow module download a fresh grace window after DOMContentLoaded", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    const win = createIsolatedWindow(undefined, fetch);
    const readyState = vi.spyOn(win.document, "readyState", "get").mockReturnValue("loading");
    installShell(win);
    await vi.advanceTimersByTimeAsync(mountTimeoutMs + 1_000);
    expect(fetch).not.toHaveBeenCalled();
    readyState.mockReturnValue("interactive");
    win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
    await vi.advanceTimersByTimeAsync(mountTimeoutMs - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("waits for the entry stylesheet before starting failed-mount recovery", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    const win = boot(fetch, undefined, "loading");
    const styles = win.document.createElement("link");
    styles.id = "openclaw-boot-styles";
    styles.media = "print";
    win.document.head.append(styles);
    win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
    await vi.advanceTimersByTimeAsync(mountTimeoutMs + 1_000);
    expect(fetch).not.toHaveBeenCalled();
    styles.dispatchEvent(new win.Event("load"));
    await vi.advanceTimersByTimeAsync(mountTimeoutMs);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([2, 3])("bounds recovery navigations after attempt %s", async (attempt) => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    boot(fetch, `http://localhost:3000/?openclaw_mount_recovery=${attempt}`, "complete");
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
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const win = boot(fetch);

    win.dispatchEvent(new win.Event("openclaw-control-ui-unsupported-browser"));
    await vi.advanceTimersByTimeAsync(mountTimeoutMs * 3);

    expect(fetch).not.toHaveBeenCalled();
    expect(win.document.getElementById("openclaw-mount-fallback")?.hidden).toBe(true);
  });

  it.each(["Keep waiting", "first render", "unsupported browser"])(
    "retires a pending recovery probe on %s",
    async (action) => {
      const { win, fetch } = pendingProbe();
      installShell(win);
      await vi.advanceTimersByTimeAsync(mountTimeoutMs);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

      if (action === "Keep waiting") {
        win.document.getElementById("openclaw-mount-wait")?.click();
      } else {
        win.dispatchEvent(
          new win.Event(
            action === "first render"
              ? "openclaw-control-ui-rendered"
              : "openclaw-control-ui-unsupported-browser",
          ),
        );
      }
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(fetch).toHaveBeenCalledOnce();
      expect(win.document.getElementById("openclaw-mount-fallback")?.hidden).toBe(true);
    },
  );

  it.each([false, true])("keeps retrying beyond six failures (stalled: %s)", async (stalled) => {
    const { win, fetch, signals } = pendingProbe(stalled);
    const unregister = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi.fn().mockResolvedValue([{ unregister }]);
    Object.defineProperty(win.navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistrations },
    });
    installShell(win);
    await vi.advanceTimersByTimeAsync(stalled ? 200_000 : 120_000);
    expect(fetch.mock.calls.length).toBeGreaterThan(6);
    expect(unregister).not.toHaveBeenCalled();
    expect(getRegistrations).not.toHaveBeenCalled();
    if (stalled) {
      expect(signals.slice(0, 6).every((signal) => signal.aborted)).toBe(true);
    } else {
      const summary = win.document.getElementById("openclaw-mount-fallback-summary");
      expect(summary).toBeInstanceOf(win.HTMLParagraphElement);
      expect(summary?.textContent).toContain("will keep retrying");
    }
    rendered(win);
    if (stalled) {
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    }
  });
});
