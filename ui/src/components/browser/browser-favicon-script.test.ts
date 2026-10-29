/* @vitest-environment jsdom */
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { browserFaviconScript } from "./browser-favicon-script.ts";

function readFavicon(fetch: ReturnType<typeof vi.fn>): Promise<string | null> {
  return runInNewContext(`(${browserFaviconScript})(1, 10_000)`, {
    document,
    location,
    URL,
    fetch,
    FileReader,
    AbortController,
    setTimeout,
    clearTimeout,
  });
}

function iconResponse(type = "image/png", content = "x") {
  return { ok: true, blob: async () => new Blob([content], { type }) };
}

afterEach(() => {
  document.head.replaceChildren();
  vi.useRealTimers();
});

it("reads the preferred 32x32 icon once as a bounded image data URL", async () => {
  document.head.innerHTML = `<link rel="icon">
      <link rel="icon" href="/first.png">
      <link rel="shortcut icon" sizes="16x16 32x32" href="/preferred.png">`;
  const fetchIcon = vi.fn().mockResolvedValue(iconResponse());
  expect(await readFavicon(fetchIcon)).toBe("data:image/png;base64,eA==");
  expect(fetchIcon).toHaveBeenCalledExactlyOnceWith(new URL("/preferred.png", location.href).href, {
    credentials: "same-origin",
    mode: "cors",
    signal: expect.any(AbortSignal),
  });
});

it.each([
  { type: "image/svg+xml; charset=utf-8", expected: "data:image/svg+xml;base64,eA==" },
  { type: "image/invalid type; charset=utf-8", expected: null },
])("normalizes and validates the MIME type $type", async ({ type, expected }) => {
  expect(await readFavicon(vi.fn().mockResolvedValue(iconResponse(type)))).toBe(expected);
});

it("falls through failed, non-image and oversized candidates in page order", async () => {
  document.head.innerHTML = `<link rel="icon" href="/large.png">
      <link rel="icon" sizes="32x32" href="/missing.png">
      <link rel="icon" href="/blocked.png">
      <link rel="apple-touch-icon" href="/not-image">`;
  const fetchIcon = vi
    .fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce(iconResponse("image/png", "xx"))
    .mockRejectedValueOnce(new TypeError("CORS"))
    .mockResolvedValueOnce(iconResponse("text/html"))
    .mockResolvedValueOnce(iconResponse());
  expect(await readFavicon(fetchIcon)).toBe("data:image/png;base64,eA==");
  expect(fetchIcon.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(
    "/missing.png /large.png /blocked.png /not-image /favicon.ico".split(" "),
  );
});

it("aborts a stalled fetch at the deadline and resolves null", async () => {
  vi.useFakeTimers();
  const fetchIcon = vi.fn(
    (_url: string, { signal }: RequestInit) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }),
  );
  const result = readFavicon(fetchIcon);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toBeNull();
  expect(fetchIcon).toHaveBeenCalledOnce();
  expect(fetchIcon.mock.calls[0]?.[1].signal?.aborted).toBe(true);
});
