import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import "./chat-detail-panel.tsx";

const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
beforeAll(async () => {
  if (browserMode) {
    ({ userEvent } = await import("vitest/browser"));
  }
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function mountAttachment(initialSource: string) {
  let src = initialSource;
  let update: (() => void) | undefined;
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
    resolveSource: (onChange) => {
      update = onChange;
      return { status: "ready", src };
    },
  };
  container.append(panel);
  document.body.append(container);
  return {
    container,
    panel,
    refresh(next = src) {
      src = next;
      expectDefined(update, "Source resolution callback")();
    },
    setSource(next: string) {
      src = next;
    },
    get: <T extends Element = HTMLElement>(selector: string) =>
      expectDefined(panel.querySelector<T>(selector), selector),
  };
}

describe.runIf(browserMode)("Markdown attachment controls", () => {
  it("keeps native raw-reader focus and scrolling through a transport refresh", async () => {
    const text = Array.from(
      { length: 140 },
      (_, i) => `## Heading ${i}\nSynthetic Markdown line ${i}.`,
    ).join("\n");
    const refreshed = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(text))
      .mockReturnValueOnce(refreshed.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { container, panel, refresh, get } = mountAttachment("/notes.md?ticket=first");
    const keys: { key: string; target: EventTarget | null; trusted: boolean }[] = [];
    const onKey = (event: KeyboardEvent) => {
      keys.push({ key: event.key, target: event.target, trusted: event.isTrusted });
    };
    document.addEventListener("keydown", onKey);
    try {
      await panel.updateComplete;
      const attachment = get<HTMLElementTagNameMap["openclaw-chat-text-attachment"]>(
        "openclaw-chat-text-attachment",
      );
      await attachment.updateComplete;
      await expect.poll(() => panel.querySelector("article")).not.toBeNull();
      const raw = expectDefined(
        [...panel.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "View Raw Text",
        ),
        "Raw view action",
      );
      await userEvent.click(raw);
      await expect.poll(() => panel.querySelector("pre")).not.toBeNull();
      const reader = get("pre");
      const scroller = get(".sidebar-content");
      const pageDown = async () => {
        const before = scroller.scrollTop;
        const ended = new Promise<void>((resolve) => {
          scroller.addEventListener("scrollend", () => resolve(), { once: true });
        });
        await userEvent.keyboard("{PageDown}");
        await ended;
        expect(scroller.scrollTop).toBeGreaterThan(before);
        expect(keys.at(-1)).toEqual({ key: "PageDown", target: reader, trusted: true });
      };
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      await userEvent.click(reader);
      expect(document.activeElement).toBe(reader);
      await pageDown();
      refresh();
      await panel.updateComplete;
      expect(document.activeElement).toBe(reader);
      expect(fetchMock).toHaveBeenCalledOnce();
      refresh("/notes.md?ticket=second");
      await expect.poll(() => fetchMock.mock.calls.length).toBe(2);
      expect(reader.isConnected).toBe(true);
      expect(document.activeElement).toBe(reader);
      await pageDown();
      const refreshResponse = new Response(text);
      refreshed.resolve(refreshResponse);
      await expect.poll(() => refreshResponse.bodyUsed && !refreshResponse.body?.locked).toBe(true);
      await attachment.updateComplete;
      expect(panel.querySelector("pre")).toBe(reader);
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
  });

  it.each(["transport", "identity", "contents", "failed refresh", "oversized metadata"] as const)(
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
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(response.promise)
        .mockReturnValueOnce(refreshed.promise)
        .mockReturnValueOnce(recovered.promise);
      vi.stubGlobal("fetch", fetchMock);
      const { container, panel, refresh, setSource, get } = mountAttachment("/notes.md");
      await panel.updateComplete;
      await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
      expect(panel.querySelector(".code-block-wrapper")).toBeNull();

      const text = [
        "```ts",
        `const longLine = "${"notes ".repeat(80)}";`,
        ...Array(20).fill("// another line"),
        "```",
      ].join("\n");
      response.resolve(new Response(text));
      await expect
        .poll(() => panel.querySelector(".code-block-wrapper.has-horizontal-overflow"))
        .not.toBeNull();
      const viewport = get(".code-block-viewport");
      const expand = get<HTMLButtonElement>(".code-block-expand");
      const wrap = get<HTMLButtonElement>(".code-block-wrap");
      expect(viewport.id).not.toBe("");
      expect(expand.getAttribute("aria-controls")).toBe(viewport.id);
      expand.click();
      expect(expand.getAttribute("aria-expanded")).toBe("true");
      expect(getComputedStyle(wrap).display).not.toBe("none");
      wrap.click();
      expect(wrap.getAttribute("aria-pressed")).toBe("true");
      expect(panel.querySelector(".code-block-wrapper.is-wrapped")).not.toBeNull();

      const reader = get("article");
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
          setSource("/refreshed-notes.md");
          if (change === "identity") {
            panel.content = { ...panel.content, sourceIdentity: "attachment:other-notes" };
          }
          refresh();
        }
        await expect.poll(() => fetchMock.mock.calls.length).toBe(2);
        const retainsPendingReader = change !== "identity" && change !== "oversized metadata";
        await expect.poll(() => reader.checkVisibility()).toBe(retainsPendingReader);
        expect(isObserved(viewport)).toBe(retainsPendingReader);
        expect(panel.querySelector('[role="status"]:not([hidden])') === null).toBe(
          retainsPendingReader,
        );

        const nextResponse = new Response(nextText);
        if (change === "failed refresh") {
          refreshed.resolve(new Response("Temporarily unavailable", { status: 503 }));
          await expect.poll(() => panel.textContent).toContain("Download it to read the full file");
          expect(reader.checkVisibility()).toBe(false);
          expect(isObserved(viewport)).toBe(false);
          refresh("/retried-notes.md");
          await expect.poll(() => fetchMock.mock.calls.length).toBe(3);
          expect(reader.checkVisibility()).toBe(false);
          expect(isObserved(viewport)).toBe(false);
          await expect
            .poll(() =>
              panel
                .querySelector<HTMLElement>(".sidebar-attachment-preview__loading")
                ?.checkVisibility(),
            )
            .toBe(true);
          recovered.resolve(nextResponse);
        } else {
          refreshed.resolve(nextResponse);
        }
        await expect.poll(() => nextResponse.bodyUsed && !nextResponse.body?.locked).toBe(true);
        await panel.querySelector("openclaw-chat-text-attachment")?.updateComplete;
        await expect
          .poll(() => panel.querySelector("article code")?.textContent)
          .toContain(change === "contents" ? "updatedLine" : "longLine");
        const nextReader = get("article");
        const retained = change === "transport";
        expect(nextReader === reader).toBe(retained);
        const nextExpand = get<HTMLButtonElement>("article .code-block-expand");
        const nextWrap = get<HTMLButtonElement>("article .code-block-wrap");
        expect(nextExpand.getAttribute("aria-expanded")).toBe(String(retained));
        expect(nextWrap.getAttribute("aria-pressed")).toBe(String(retained));
        expect(
          nextReader.querySelector(".code-block-wrapper")?.classList.contains("is-expanded"),
        ).toBe(retained);
        expect(
          nextReader.querySelector(".code-block-wrapper")?.classList.contains("is-wrapped"),
        ).toBe(retained);
        const nextViewport = get("article .code-block-viewport");
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
});
