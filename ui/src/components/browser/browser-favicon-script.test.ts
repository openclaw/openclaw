/* @vitest-environment jsdom */
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserFaviconScript } from "./browser-favicon-script.ts";

// Exercise the same serialized function that WebKit receives.
function readFavicon(maxBytes: number, timeoutMs: number): Promise<string | null> {
  return runInNewContext(`(${browserFaviconScript})(maxBytes, timeoutMs)`, {
    document,
    location,
    URL,
    fetch,
    FileReader,
    AbortController,
    setTimeout,
    clearTimeout,
    maxBytes,
    timeoutMs,
  });
}

afterEach(() => {
  document.head.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("browser favicon page script", () => {
  it.each([
    {
      name: "32x32 icon",
      links:
        '<link rel="icon" href="/first.png"><link rel="shortcut icon" sizes="16x16 32x32" href="/preferred.png">',
      path: "/preferred.png",
    },
    {
      name: "first icon with href",
      links: '<link rel="icon"><link rel="icon" href="/first.png">',
      path: "/first.png",
    },
    {
      name: "Apple touch icon",
      links: '<link rel="apple-touch-icon" href="/apple.png">',
      path: "/apple.png",
    },
    { name: "root fallback", links: "", path: "/favicon.ico" },
  ])("reads the $name as a bounded image data URL", async ({ links, path }) => {
    document.head.innerHTML = links;
    const fetchIcon = vi
      .fn()
      .mockResolvedValue({ ok: true, blob: async () => new Blob(["x"], { type: "image/png" }) });
    vi.stubGlobal("fetch", fetchIcon);
    expect(await readFavicon(1, 10_000)).toBe("data:image/png;base64,eA==");
    expect(fetchIcon).toHaveBeenCalledExactlyOnceWith(new URL(path, location.href).href, {
      credentials: "same-origin",
      mode: "cors",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    { type: "image/svg+xml; charset=utf-8", expected: "data:image/svg+xml;base64,eA==" },
    { type: "text/html; charset=utf-8", expected: null },
    { type: "image/invalid type; charset=utf-8", expected: null },
  ])("normalizes and validates the MIME type $type", async ({ type, expected }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["x"], { type }) }),
    );
    expect(await readFavicon(1, 10_000)).toBe(expected);
  });

  it("falls through failed, non-image and oversized candidates in page order", async () => {
    document.head.innerHTML = `
      <link rel="icon" href="/large.png">
      <link rel="icon" sizes="32x32" href="/missing.png">
      <link rel="icon" href="/blocked.png">
      <link rel="apple-touch-icon" href="/not-image">
    `;
    const fetchIcon = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(["xx"], { type: "image/png" }),
      })
      .mockRejectedValueOnce(new TypeError("CORS"))
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["x"], { type: "text/html" }) })
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(["x"], { type: "image/png" }),
      });
    vi.stubGlobal("fetch", fetchIcon);
    expect(await readFavicon(1, 10_000)).toBe("data:image/png;base64,eA==");
    expect(fetchIcon.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/missing.png",
      "/large.png",
      "/blocked.png",
      "/not-image",
      "/favicon.ico",
    ]);
  });

  it("resolves null when all candidates fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network unavailable")));
    expect(await readFavicon(65_536, 10_000)).toBeNull();
  });

  it("aborts a stalled fetch at the deadline and resolves null", async () => {
    vi.useFakeTimers();
    const fetchIcon = vi.fn(
      (_url: string, { signal }: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchIcon);
    const result = readFavicon(65_536, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeNull();
    expect(fetchIcon).toHaveBeenCalledOnce();
    expect(fetchIcon.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });
});
