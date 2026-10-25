import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { renderPublicSessionDocument } from "./control-ui-public-session-render.js";

const message = (id: string) => ({ role: "assistant", __openclaw: { id }, content: id });
const widgetUrls = new Map([
  ["cv_first", "/share/session/media?widget=first"],
  ["cv_second", "/share/session/media?widget=second"],
]);
const messages = [
  message("first"),
  message("second"),
  {
    role: "assistant",
    content: [{ type: "toolCall", name: "read", arguments: { path: "example.ts" } }],
  },
  message("last"),
];
type Page = Partial<Parameters<typeof renderPublicSessionDocument>[0]>;
const widget = {
  ...message("widget"),
  content: '[embed ref="cv_first" title="First" /] [embed ref="cv_second" title="Second" /]',
};
function render(overrides: Page = {}) {
  return renderPublicSessionDocument({
    messages,
    title: "Shared",
    truncated: false,
    latestUrl: "/chat/main/topic",
    cardUrl: "https://example.test/card.png",
    assetBasePath: "/control",
    entryUrl: "/__openclaw__/session-entry?path=topic",
    ...overrides,
  });
}
afterEach(() => vi.useRealTimers());

function fixture(overrides: Page = {}, initialRowHeight = 400) {
  vi.useFakeTimers();
  const dom = new JSDOM(render(overrides), { url: "https://example.test/chat/main/topic" });
  onTestFinished(() => dom.window.close());
  const { document } = dom.window;
  // The protected login probe is covered separately; exercise the shipped reader lifecycle.
  document.getElementById("session-login")?.remove();
  let hidden = false;
  Object.defineProperty(document, "hidden", { get: () => hidden });
  const window = {
    scrollY: 0,
    innerHeight: 600,
    scrollTo: vi.fn(({ top }: { top: number }) => {
      window.scrollY = top;
    }),
    addEventListener: dom.window.addEventListener.bind(dom.window),
  };
  // DOM behavior is real; only browser layout is deterministic in this Node test.
  let rowHeight = initialRowHeight;
  dom.window.Element.prototype.getBoundingClientRect = function () {
    if (this.matches(".reader-controls")) {
      return new dom.window.DOMRect(0, 528, 400, 56);
    }
    const rows = Array.from(document.querySelectorAll(".transcript > *"));
    const index = rows.indexOf(this);
    const top = this.matches(".transcript") ? 300 : 300 + Math.max(0, index) * rowHeight;
    const bottom = this.matches(".transcript") ? 300 + rows.length * rowHeight : top + rowHeight;
    return new dom.window.DOMRect(0, top - window.scrollY, 720, bottom - top);
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const response = (status: number, body = "updated", etag = '"revision-1"') =>
    new Response(
      status === 304
        ? null
        : render(
            body === "revoked"
              ? { title: "Conversation unavailable", unavailable: true, messages: [] }
              : {
                  ...overrides,
                  title: body,
                  messages: [...(overrides.messages ?? messages), message(body)],
                },
          ),
      { status, headers: { ETag: etag } },
    );
  fetch.mockResolvedValue(response(200));
  let resized: () => void = () => {};
  runInNewContext(document.querySelector("script")!.textContent!, {
    document,
    window,
    fetch,
    location: dom.window.location,
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    Date,
    AbortSignal,
    setTimeout,
    clearTimeout,
    DOMParser: dom.window.DOMParser,
    ResizeObserver: class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  });
  const event = (name: string) => dom.window.dispatchEvent(new dom.window.Event(name));
  return {
    document,
    window,
    fetch,
    response,
    event,
    find: <E extends Element = HTMLElement>(selector: string) =>
      document.querySelector<E>(selector)!,
    all: <E extends Element = HTMLElement>(selector: string) =>
      document.querySelectorAll<E>(selector),
    text: (selector: string) => document.querySelector(selector)?.textContent,
    respond: (page: Page) => fetch.mockResolvedValue(new Response(render(page))),
    refresh: async () => {
      event("online");
      await vi.advanceTimersByTimeAsync(0);
    },
    visibility: (value: boolean) => {
      hidden = value;
      document.dispatchEvent(new dom.window.Event("visibilitychange"));
    },
    scroll: (top: number) => {
      window.scrollY = top;
      event("scroll");
    },
    resize: (height: number) => {
      rowHeight = height;
      resized();
    },
  };
}

it("replaces surrounding rows and page content while preserving widget state and heights", async () => {
  const f = fixture({
    messages: [{ ...message("old"), role: "user" }, widget, message("old tail")],
    widgetUrls,
  });
  const main = f.find("main");
  const frames = f.all<HTMLIFrameElement>("iframe");
  const frameWindow = frames[0]!.contentWindow!;
  frameWindow.name = "widget interaction state";
  frames[0]!.style.height = "730px";
  frames[1]!.style.height = "280px";
  f.respond({
    messages: [{ ...message("new"), role: "user" }, widget, message("new tail")],
    title: "Earlier conversation",
    isLatest: false,
    olderUrl: "/chat/main/topic?before=earlier",
    widgetUrls,
  });
  await f.refresh();
  expect(f.find("main")).toBe(main);
  expect(main.dataset.publicRefresh).toBe("false");
  expect(f.all("iframe")[0]).toBe(frames[0]);
  expect(f.all("iframe")[1]).toBe(frames[1]);
  expect(frames[0]!.contentWindow).toBe(frameWindow);
  expect(frameWindow.name).toBe("widget interaction state");
  expect(Array.from(f.all("iframe"), (frame) => frame.style.height)).toEqual(["730px", "280px"]);
  expect(f.all(".transcript > *")).toHaveLength(3);
  expect(f.text(".transcript")).toContain("new tail");
  expect(f.text(".transcript")).not.toContain("old");
  expect(f.text(".article-head h1")).toBe("Earlier conversation");
  expect(f.all(".pagination")).toHaveLength(2);
  expect(f.document.title).toBe("Earlier conversation · OpenClaw");
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it("replaces a changed widget row and carries its measured height", async () => {
  const first = { ...message("widget"), content: '[embed ref="cv_first" /]' };
  const f = fixture({ messages: [first], widgetUrls });
  const frame = f.find<HTMLIFrameElement>("iframe");
  frame.style.height = "730px";
  f.respond({ messages: [{ ...first, content: 'Changed [embed ref="cv_first" /]' }], widgetUrls });
  await f.refresh();
  expect(f.find("iframe")).not.toBe(frame);
  expect(f.find<HTMLIFrameElement>("iframe").style.height).toBe("730px");
  expect(f.text(".transcript")).toContain("Changed");
});

it.each(["reorder", "duplicate", "unkeyed"])("replaces the document for %s rows", async (mode) => {
  const page = { messages: ["first", "second", "third"].map(message) };
  const f = fixture(page);
  const original = f.find("main");
  const next = new JSDOM(render(page));
  onTestFinished(() => next.window.close());
  const transcript = next.window.document.querySelector(".transcript")!;
  if (mode === "reorder") {
    // Leave the first row unchanged; swapping two continued rows retains their full rendered HTML.
    transcript.insertBefore(transcript.children[2]!, transcript.children[1]!);
  } else if (mode === "duplicate") {
    transcript.children[1]!.setAttribute(
      "data-public-item",
      transcript.children[0]!.getAttribute("data-public-item")!,
    );
  } else {
    transcript.children[1]!.removeAttribute("data-public-item");
  }
  f.fetch.mockResolvedValue(new Response(next.serialize()));
  await f.refresh();
  expect(f.find("main")).not.toBe(original);
});

it("jitters conditional reads, retains ETag manually, and catches up only when visible", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.document.title).toBe("updated · OpenClaw");
  f.fetch.mockResolvedValue(f.response(304));
  await vi.advanceTimersByTimeAsync(16500);
  expect(f.fetch).toHaveBeenLastCalledWith(
    "https://example.test/chat/main/topic",
    expect.objectContaining({
      cache: "no-store",
      redirect: "error",
      headers: { "If-None-Match": '"revision-1"' },
    }),
  );
  expect(f.text(".transcript")).toContain("updated");
  f.visibility(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.fetch).toHaveBeenCalledTimes(2);
  f.visibility(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.fetch).toHaveBeenCalledTimes(3);
});
it("replaces a revoked publication with the generic login page and stops polling", async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(f.response(404, "revoked"));
  await vi.advanceTimersByTimeAsync(16500);
  expect(f.document.title).toBe("Conversation unavailable · OpenClaw");
  expect(f.document.querySelector("[data-entry-pending]")).toBeNull();
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
it("does not publish a read that settles after the tab becomes hidden", async () => {
  const f = fixture();
  const pending = createDeferred<Response>();
  f.fetch.mockReturnValue(pending.promise);
  await vi.advanceTimersByTimeAsync(16500);
  f.visibility(true);
  pending.resolve(f.response(200));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.text(".transcript")).not.toContain("updated");
  expect(f.document.title).toBe("Shared · OpenClaw");
});
it("honors Retry-After without replacing the readable transcript", async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(
    new Response("busy", { status: 429, headers: { "Retry-After": "60" } }),
  );
  await vi.advanceTimersByTimeAsync(16500);
  f.visibility(true);
  f.visibility(false);
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.document.title).toBe("Shared · OpenClaw");
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.fetch).toHaveBeenCalledTimes(2);
});
it("follows new messages and late layout only at the transcript end, not in the colophon", async () => {
  const f = fixture();
  f.scroll(1300);
  await vi.advanceTimersByTimeAsync(16500);
  expect(f.window.scrollY).toBe(1788);
  f.resize(500);
  expect(f.window.scrollY).toBe(2288);
  f.scroll(3000);
  f.window.scrollTo.mockClear();
  f.fetch.mockResolvedValue(f.response(200, "more", '"revision-2"'));
  await vi.advanceTimersByTimeAsync(16500);
  expect(f.window.scrollTo).not.toHaveBeenCalled();
});
it("follows a short visible conversation", async () => {
  const f = fixture({}, 40);
  await vi.advanceTimersByTimeAsync(16500);
  f.resize(200);
  expect(f.window.scrollY).toBe(788);
});
it("keeps the visible message and expanded tools when the latest page rolls forward", async () => {
  const f = fixture();
  f.scroll(750);
  f.document.querySelector("details")!.open = true;
  f.respond({ messages: [...messages.slice(1), message("new")] });
  await vi.advanceTimersByTimeAsync(16500);
  expect(f.window.scrollY).toBe(350);
  expect(f.document.querySelector("details")!.open).toBe(true);
});
it("offers top/latest controls and refreshes manually without a navigation", async () => {
  const f = fixture();
  f.scroll(800);
  const top = f.document.querySelector<HTMLButtonElement>("[data-public-top]");
  expect(top).not.toBeNull();
  top!.click();
  expect(f.window.scrollY).toBe(0);
  f.find<HTMLButtonElement>("[data-public-latest]").click();
  expect(f.window.scrollY).toBe(1388);
  f.find<HTMLAnchorElement>("[data-public-refresh-now]").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.text("[data-public-refresh-status]")).toBe("Up to date");
  expect(f.window.scrollY).toBe(1788);
});
it("refreshes legacy links in place and clears a plain revoked response", async () => {
  const f = fixture({ entryUrl: undefined });
  await vi.advanceTimersByTimeAsync(16500);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  f.fetch.mockResolvedValue(new Response("This public session is unavailable.", { status: 404 }));
  await vi.advanceTimersByTimeAsync(16500);
  expect(f.document.querySelector(".transcript")).toBeNull();
  expect(f.document.body.textContent).toContain("no longer publicly available");
  expect(f.document.querySelector(".reader-controls")?.hasAttribute("hidden")).toBe(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.fetch).toHaveBeenCalledTimes(2);
});
it("retains readable content and visibly recovers from a failed update", async () => {
  const f = fixture();
  f.fetch.mockRejectedValueOnce(new Error("offline"));
  await vi.advanceTimersByTimeAsync(16500);
  expect(f.text(".transcript")).toContain("first");
  expect(f.text("[data-public-refresh-status]")).toContain("Could not refresh");
  await f.refresh();
  expect(f.document.title).toBe("updated · OpenClaw");
});
it("catches up on reconnect without overlapping requests, and keeps older pages still", async () => {
  const f = fixture();
  const pending = createDeferred<Response>();
  f.fetch.mockReturnValue(pending.promise);
  await f.refresh();
  await f.refresh();
  expect(f.fetch).toHaveBeenCalledTimes(1);
  pending.resolve(f.response(200));
  await vi.advanceTimersByTimeAsync(0);
  const older = fixture({ isLatest: false });
  older.event("online");
  await vi.advanceTimersByTimeAsync(60000);
  expect(older.fetch).not.toHaveBeenCalled();
});
