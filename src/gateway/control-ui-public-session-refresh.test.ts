import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
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
function render(overrides: Partial<Parameters<typeof renderPublicSessionDocument>[0]> = {}) {
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
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const close of dispose.splice(0)) {
    close();
  }
  vi.useRealTimers();
});

function fixture(
  overrides: Partial<Parameters<typeof renderPublicSessionDocument>[0]> = {},
  initialRowHeight = 400,
) {
  vi.useFakeTimers();
  const dom = new JSDOM(render(overrides), { url: "https://example.test/chat/main/topic" });
  dispose.push(() => dom.window.close());
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
    matchMedia: () => ({ matches: true }),
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
  const replaceWith = vi.spyOn(document.querySelector("main")!, "replaceWith");
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
    Number,
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
    replaceWith,
    event,
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

it("keeps unchanged widget frames, their state, and measured height on the first refresh", async () => {
  const f = fixture({
    messages: [
      { role: "assistant", content: '[embed ref="cv_first" /] [embed ref="cv_second" /]' },
    ],
    widgetUrls,
  });
  const frames = f.document.querySelectorAll("iframe");
  const frameWindow = frames[0]!.contentWindow!;
  frameWindow.name = "widget interaction state";
  frames[0]!.style.height = "730px";
  frames[1]!.style.height = "280px";
  f.fetch.mockResolvedValue(
    new Response(
      render({
        messages: [
          { role: "assistant", content: '[embed ref="cv_first" /] [embed ref="cv_second" /]' },
        ],
        widgetUrls,
      }),
    ),
  );
  f.event("online");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.document.querySelectorAll("iframe")[0]).toBe(frames[0]);
  expect(f.document.querySelectorAll("iframe")[1]).toBe(frames[1]);
  expect(frames[0]!.contentWindow).toBe(frameWindow);
  expect(frameWindow.name).toBe("widget interaction state");
  expect(Array.from(f.document.querySelectorAll("iframe"), (frame) => frame.style.height)).toEqual([
    "730px",
    "280px",
  ]);
});

it("appends a new message without detaching an existing widget", async () => {
  const f = fixture({
    messages: [{ ...message("widget"), content: '[embed ref="cv_first" title="First" /]' }],
    widgetUrls,
  });
  const frame = f.document.querySelector("iframe")!;
  const frameWindow = frame.contentWindow;
  f.event("online");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.document.querySelector("iframe")).toBe(frame);
  expect(frame.contentWindow).toBe(frameWindow);
  expect(f.document.querySelectorAll(".transcript > *")).toHaveLength(2);
  expect(f.document.querySelector(".transcript")!.textContent).toContain("updated");
});

it("replaces surrounding rows and page content without detaching a kept widget", async () => {
  const widget = { ...message("widget"), content: '[embed ref="cv_first" title="First" /]' };
  const f = fixture({
    messages: [{ ...message("old"), role: "user" }, widget, message("old tail")],
    widgetUrls,
  });
  const main = f.document.querySelector("main")!;
  const frame = f.document.querySelector("iframe")!;
  const frameWindow = frame.contentWindow;
  f.fetch.mockResolvedValue(
    new Response(
      render({
        messages: [{ ...message("new"), role: "user" }, widget, message("new tail")],
        title: "Earlier conversation",
        isLatest: false,
        olderUrl: "/chat/main/topic?before=earlier",
        widgetUrls,
      }),
    ),
  );
  f.event("online");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.document.querySelector("main")).toBe(main);
  expect(main.dataset.publicRefresh).toBe("false");
  expect(f.document.querySelector("iframe")).toBe(frame);
  expect(frame.contentWindow).toBe(frameWindow);
  expect(f.document.querySelector(".transcript")!.textContent).toContain("new tail");
  expect(f.document.querySelector(".transcript")!.textContent).not.toContain("old");
  expect(f.document.querySelector(".article-head h1")!.textContent).toBe("Earlier conversation");
  expect(f.document.querySelectorAll(".pagination")).toHaveLength(2);
  expect(f.document.title).toBe("Earlier conversation · OpenClaw");
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it("replaces a changed widget row and carries its measured height", async () => {
  const first = { ...message("widget"), content: '[embed ref="cv_first" /]' };
  const f = fixture({ messages: [first], widgetUrls });
  const frame = f.document.querySelector("iframe")!;
  frame.style.height = "730px";
  f.fetch.mockResolvedValue(
    new Response(
      render({
        messages: [{ ...first, content: 'Changed [embed ref="cv_first" /]' }],
        widgetUrls,
      }),
    ),
  );
  f.event("online");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.document.querySelector("iframe")).not.toBe(frame);
  expect(f.document.querySelector("iframe")!.style.height).toBe("730px");
  expect(f.document.querySelector(".transcript")!.textContent).toContain("Changed");
});

it.each(["reorder", "duplicate", "unkeyed"])("replaces the document for %s rows", async (mode) => {
  const f = fixture({ messages: [message("first"), message("second"), message("third")] });
  const original = f.document.querySelector("main");
  const next = new JSDOM(
    render({ messages: [message("first"), message("second"), message("third")] }),
  );
  dispose.push(() => next.window.close());
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
  f.event("online");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.document.querySelector("main")).not.toBe(original);
  expect(f.replaceWith).toHaveBeenCalledOnce();
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
  expect(f.document.querySelector(".transcript")!.textContent).toContain("updated");
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
  expect(f.replaceWith).not.toHaveBeenCalled();
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
it.each([false, true])(
  "follows a short visible conversation (explicit Latest: %s)",
  async (explicitLatest) => {
    const f = fixture({}, 40);
    if (explicitLatest) {
      f.document.querySelector<HTMLButtonElement>("[data-public-latest]")!.click();
      f.scroll(0);
    }
    await vi.advanceTimersByTimeAsync(16500);
    f.resize(200);
    expect(f.window.scrollY).toBe(788);
  },
);
it("keeps the visible message and expanded tools when the latest page rolls forward", async () => {
  const f = fixture();
  f.scroll(750);
  f.document.querySelector("details")!.open = true;
  const body = render({ messages: [...messages.slice(1), message("new")] });
  f.fetch.mockResolvedValue(new Response(body, { status: 200 }));
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
  f.document.querySelector<HTMLButtonElement>("[data-public-latest]")!.click();
  expect(f.window.scrollY).toBe(1388);
  f.document.querySelector<HTMLAnchorElement>("[data-public-refresh-now]")!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.document.querySelector("[data-public-refresh-status]")?.textContent).toBe("Up to date");
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
  expect(f.document.querySelector(".transcript")?.textContent).toContain("first");
  expect(f.document.querySelector("[data-public-refresh-status]")?.textContent).toContain(
    "Could not refresh",
  );
  f.event("online");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.document.title).toBe("updated · OpenClaw");
});
it("catches up on reconnect without overlapping requests, and keeps older pages still", async () => {
  const f = fixture();
  const pending = createDeferred<Response>();
  f.fetch.mockReturnValue(pending.promise);
  f.event("online");
  await vi.advanceTimersByTimeAsync(0);
  f.event("online");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  pending.resolve(f.response(200));
  await vi.advanceTimersByTimeAsync(0);
  const older = fixture({ isLatest: false });
  older.event("online");
  await vi.advanceTimersByTimeAsync(60000);
  expect(older.fetch).not.toHaveBeenCalled();
});
