/* @vitest-environment jsdom */
import { createContext, runInContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { browserFaviconScript } from "./browser-favicon-script.ts";

function readFavicon(
  fetch: ReturnType<typeof vi.fn>,
  colorScheme?: "light" | "dark",
  matchMedia: (query: string) => EventTarget & { matches: boolean } = () =>
    Object.assign(new EventTarget(), { matches: false }),
  // One context is one document's script world; reads of the same document share it.
  page: object = {},
): Promise<string | null> {
  const context = createContext(
    Object.assign(page, {
      document,
      location,
      URL,
      fetch,
      FileReader,
      AbortController,
      matchMedia,
      colorScheme,
      setTimeout,
      clearTimeout,
    }),
  );
  return runInContext(`(${browserFaviconScript})(1, 10_000, colorScheme)`, context);
}

function iconResponse(type = "image/png", content = "x") {
  return { ok: true, blob: async () => new Blob([content], { type }) };
}

afterEach(() => {
  document.head.replaceChildren();
  vi.useRealTimers();
});

it("waits until the page sees an appearance that WebKit already applied before reading its icon", async () => {
  const icon = document.createElement("link");
  icon.rel = "icon";
  icon.href = "/dark.png";
  document.head.append(icon);
  const dark = Object.assign(new EventTarget(), { matches: true });
  const light = Object.assign(new EventTarget(), { matches: false });
  const media = (query: string) => (query === "(prefers-color-scheme: dark)" ? dark : light);
  const page = {};
  const fetchIcon = vi.fn().mockResolvedValue(iconResponse());
  expect(await readFavicon(fetchIcon, "dark", media, page)).toBe("data:image/png;base64,eA==");

  // WebKit evaluates the new appearance before it reports the change to page listeners.
  dark.matches = false;
  light.matches = true;
  const result = readFavicon(fetchIcon, "light", media, page);
  // A zero-delay task runs after any read the script deferred by one task, so an early
  // read would show here; fake timers would also stall jsdom's FileReader.
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(fetchIcon).toHaveBeenCalledOnce();

  dark.dispatchEvent(new Event("change"));
  icon.href = "/light.png";
  expect(await result).toBe("data:image/png;base64,eA==");
  expect(fetchIcon.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/dark.png",
    "/light.png",
  ]);
});

it("uses the matching media-qualified icon instead of the first equally sized link", async () => {
  document.head.innerHTML = `<link rel="icon" sizes="32x32" media="(prefers-color-scheme: dark)" href="/dark.png">
    <link rel="icon" sizes="32x32" media="(prefers-color-scheme: light)" href="/light.png">`;
  const fetchIcon = vi.fn().mockResolvedValue(iconResponse());
  const media = (query: string) =>
    Object.assign(new EventTarget(), { matches: query === "(prefers-color-scheme: light)" });
  expect(await readFavicon(fetchIcon, "light", media)).toBe("data:image/png;base64,eA==");
  expect(fetchIcon.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/light.png"]);
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
