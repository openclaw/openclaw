import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import "./chat-detail-panel.tsx";

const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
const required = <T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string) =>
  expectDefined(root.querySelector<T>(selector), selector);
function mockFetch(...responses: (Response | Promise<Response>)[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchMock.mockReturnValueOnce(Promise.resolve(response));
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
async function mountAttachment(src = "/notes.md") {
  let notify: (() => void) | undefined;
  const source = { src, update: () => expectDefined(notify, "Source update callback")() };
  const container = document.createElement("div");
  container.className = "side-panel__panel";
  container.style.cssText = "display:flex;width:480px;height:600px;";
  const panel = document.createElement("openclaw-chat-detail-panel");
  panel.className = "chat-sidebar";
  panel.content = {
    kind: "attachment",
    title: "notes.md",
    mimeType: "text/markdown",
    sourceIdentity: "attachment:notes",
    resolveSource: (update) => {
      notify = update;
      return { status: "ready", src: source.src };
    },
  };
  container.append(panel);
  document.body.append(container);
  await panel.updateComplete;
  const query: typeof panel.querySelector = panel.querySelector.bind(panel);
  return { container, panel, query, source };
}

async function pageDown(scroller: HTMLElement) {
  const scrollEnd = new Promise<void>((resolve) => {
    scroller.addEventListener("scrollend", () => resolve(), { once: true });
  });
  await userEvent.keyboard("{PageDown}");
  await scrollEnd;
}
beforeAll(async () => {
  if (browserMode) {
    ({ userEvent } = await import("vitest/browser"));
  }
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.runIf(browserMode)(
  "keeps native raw-reader focus and scrolling through a transport refresh",
  async () => {
    const text = Array.from({ length: 140 }, (_, i) => `## Heading ${i}\nLine ${i}.`).join("\n");
    const refreshed = createDeferred<Response>();
    const fetchMock = mockFetch(new Response(text), refreshed.promise);
    const { container, panel, query, source } = await mountAttachment("/notes.md?ticket=first");
    const keys: { key: string; target: EventTarget | null; trusted: boolean }[] = [];
    const onKey = (event: KeyboardEvent) => {
      keys.push({ key: event.key, target: event.target, trusted: event.isTrusted });
    };
    document.addEventListener("keydown", onKey);
    try {
      await panel.updateComplete;
      const attachment = expectDefined(query("openclaw-chat-text-attachment"), "Text attachment");
      await attachment.updateComplete;
      await expect.poll(() => query("article")).not.toBeNull();
      const raw = expectDefined(
        [...panel.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "View Raw Text",
        ),
        "Raw view action",
      );
      await userEvent.click(raw);
      await expect.poll(() => query("pre")).not.toBeNull();
      const reader = required(panel, "pre");
      const scroller = required(panel, ".sidebar-content");
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      await userEvent.click(reader);
      expect(document.activeElement).toBe(reader);
      await pageDown(scroller);
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(keys.at(-1)).toEqual({ key: "PageDown", target: reader, trusted: true });
      source.update();
      await panel.updateComplete;
      expect(document.activeElement).toBe(reader);
      expect(fetchMock).toHaveBeenCalledOnce();
      source.src = "/notes.md?ticket=second";
      source.update();
      await expect.poll(() => fetchMock.mock.calls.length).toBe(2);
      expect(reader.isConnected).toBe(true);
      expect(document.activeElement).toBe(reader);
      const beforePendingKey = scroller.scrollTop;
      await pageDown(scroller);
      expect(scroller.scrollTop).toBeGreaterThan(beforePendingKey);
      expect(keys.at(-1)).toEqual({ key: "PageDown", target: reader, trusted: true });
      const refreshResponse = new Response(text);
      refreshed.resolve(refreshResponse);
      await expect.poll(() => refreshResponse.bodyUsed && !refreshResponse.body?.locked).toBe(true);
      await attachment.updateComplete;
      expect(query("pre")).toBe(reader);
      expect(reader.textContent).toBe(text);
      expect(document.activeElement).toBe(reader);
      const beforeLoadedKey = scroller.scrollTop;
      await userEvent.keyboard("{PageDown}");
      await expect.poll(() => scroller.scrollTop).toBeGreaterThan(beforeLoadedKey);
      expect(keys.at(-1)).toEqual({ key: "PageDown", target: reader, trusted: true });
    } finally {
      refreshed.resolve(new Response(text));
      document.removeEventListener("keydown", onKey);
      container.remove();
    }
  },
);

it
  .runIf(browserMode)
  .each(["transport", "identity", "contents", "failed refresh", "oversized metadata"] as const)(
  "initializes deferred controls and refreshes the attachment %s",
  async (change) => {
    const observed = new Map<ResizeObserver, Set<Element>>();
    const NativeResizeObserver = ResizeObserver;
    vi.stubGlobal(
      "ResizeObserver",
      class extends NativeResizeObserver {
        override observe(target: Element, options?: ResizeObserverOptions) {
          const targets = observed.get(this) ?? new Set<Element>();
          targets.add(target);
          observed.set(this, targets);
          super.observe(target, options);
        }
        override unobserve(target: Element) {
          observed.get(this)?.delete(target);
          super.unobserve(target);
        }
        override disconnect() {
          observed.get(this)?.clear();
          super.disconnect();
        }
      },
    );
    const isObserved = (target: Element) =>
      [...observed.values()].some((targets) => targets.has(target));
    const response = createDeferred<Response>();
    const refreshed = createDeferred<Response>();
    const recovered = createDeferred<Response>();
    const fetchMock = mockFetch(response.promise, refreshed.promise, recovered.promise);
    const { container, panel, query, source } = await mountAttachment();
    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    expect(query(".code-block-wrapper")).toBeNull();

    const text = `\`\`\`ts\nconst longLine = "${"notes ".repeat(80)}";\n${"// another line\n".repeat(20)}\`\`\``;
    response.resolve(new Response(text));
    await expect.poll(() => query(".code-block-wrapper.has-horizontal-overflow")).not.toBeNull();
    const viewport = required(panel, ".code-block-viewport");
    const expand = required(panel, ".code-block-expand");
    const wrap = required(panel, ".code-block-wrap");
    expect(viewport.id).not.toBe("");
    expect(expand.getAttribute("aria-controls")).toBe(viewport.id);
    expand.click();
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(getComputedStyle(wrap).display).not.toBe("none");
    wrap.click();
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
    expect(query(".code-block-wrapper.is-wrapped")).not.toBeNull();

    const reader = required(panel, "article");
    let observedViewport = viewport;
    const nextText = change === "contents" ? text.replace("longLine", "updatedLine") : text;
    try {
      if (change === "oversized metadata") {
        panel.content = { ...panel.content, sizeBytes: 256 * 1024 + 1 };
        await expect.poll(() => panel.textContent).toContain("Download it to read the full file");
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(reader.checkVisibility()).toBe(false);
        expect(isObserved(viewport)).toBe(false);
        panel.content = { ...panel.content, sizeBytes: undefined };
      } else {
        source.src = "/refreshed-notes.md";
        if (change === "identity") {
          panel.content = { ...panel.content, sourceIdentity: "attachment:other-notes" };
        }
        source.update();
      }
      await expect.poll(() => fetchMock.mock.calls.length).toBe(2);
      const retainsPendingReader = change !== "identity" && change !== "oversized metadata";
      await expect.poll(() => reader.checkVisibility()).toBe(retainsPendingReader);
      expect(isObserved(viewport)).toBe(retainsPendingReader);
      expect(query('[role="status"]:not([hidden])') === null).toBe(retainsPendingReader);

      const nextResponse = new Response(nextText);
      if (change === "failed refresh") {
        refreshed.resolve(new Response("Temporarily unavailable", { status: 503 }));
        await expect.poll(() => panel.textContent).toContain("Download it to read the full file");
        expect(reader.checkVisibility()).toBe(false);
        expect(isObserved(viewport)).toBe(false);
        source.src = "/retried-notes.md";
        source.update();
        await expect.poll(() => fetchMock.mock.calls.length).toBe(3);
        recovered.resolve(nextResponse);
      } else {
        refreshed.resolve(nextResponse);
      }
      await expect.poll(() => nextResponse.bodyUsed && !nextResponse.body?.locked).toBe(true);
      await query("openclaw-chat-text-attachment")?.updateComplete;
      await expect
        .poll(() => query("article code")?.textContent)
        .toContain(change === "contents" ? "updatedLine" : "longLine");
      const nextReader = required(panel, "article");
      const retained = change === "transport";
      expect(nextReader === reader).toBe(retained);
      const nextExpand = required(nextReader, ".code-block-expand");
      const nextWrap = required(nextReader, ".code-block-wrap");
      expect(nextExpand.getAttribute("aria-expanded")).toBe(String(retained));
      expect(nextWrap.getAttribute("aria-pressed")).toBe(String(retained));
      const classes = required(nextReader, ".code-block-wrapper").classList;
      expect([classes.contains("is-expanded"), classes.contains("is-wrapped")]).toEqual([
        retained,
        retained,
      ]);
      const nextViewport = required(nextReader, ".code-block-viewport");
      observedViewport = nextViewport;
      await expect.poll(() => isObserved(nextViewport)).toBe(true);
      await expect.poll(() => nextViewport.id).not.toBe("");
      expect(nextExpand.getAttribute("aria-controls")).toBe(nextViewport.id);
      nextExpand.click();
      nextWrap.click();
      expect(nextWrap.getAttribute("aria-pressed")).toBe(String(!retained));
    } finally {
      refreshed.resolve(new Response(nextText));
      recovered.resolve(new Response(nextText));
      container.remove();
      await expect.poll(() => isObserved(observedViewport)).toBe(false);
    }
  },
);
