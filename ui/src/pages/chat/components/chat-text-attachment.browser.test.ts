import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-sidebar.ts";

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
    let src = "/notes.md?ticket=first";
    let requestSourceUpdate: (() => void) | undefined;
    const container = document.createElement("div");
    container.className = "side-panel__panel";
    container.style.cssText = "display:flex;width:480px;height:600px;";
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: SidebarContent;
      updateComplete: Promise<unknown>;
      requestUpdate: () => void;
    };
    panel.className = "chat-sidebar";
    panel.content = {
      kind: "attachment",
      title: "notes.md",
      mimeType: "text/markdown",
      sourceIdentity: "attachment:notes",
      resolveSource: (update) => {
        requestSourceUpdate = update;
        return { status: "ready", src };
      },
    };
    container.append(panel);
    document.body.append(container);
    const keys: { key: string; target: EventTarget | null; trusted: boolean }[] = [];
    const onKey = (event: KeyboardEvent) => {
      keys.push({ key: event.key, target: event.target, trusted: event.isTrusted });
    };
    document.addEventListener("keydown", onKey);
    try {
      await panel.updateComplete;
      const attachment = expectDefined(
        panel.querySelector("openclaw-chat-text-attachment"),
        "Text attachment",
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
      const reader = expectDefined(panel.querySelector("pre"), "Raw reader");
      const scroller = expectDefined(
        panel.querySelector<HTMLElement>(".sidebar-content"),
        "Sidebar scroller",
      );
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      await userEvent.click(reader);
      expect(document.activeElement).toBe(reader);
      const initialScrollEnd = new Promise<void>((resolve) => {
        scroller.addEventListener("scrollend", () => resolve(), { once: true });
      });
      await userEvent.keyboard("{PageDown}");
      await initialScrollEnd;
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(keys.at(-1)).toEqual({ key: "PageDown", target: reader, trusted: true });
      panel.requestUpdate();
      await panel.updateComplete;
      expect(document.activeElement).toBe(reader);
      expect(fetchMock).toHaveBeenCalledOnce();
      src = "/notes.md?ticket=second";
      expectDefined(requestSourceUpdate, "Source resolution callback")();
      await expect.poll(() => fetchMock.mock.calls.length).toBe(2);
      expect(reader.isConnected).toBe(true);
      expect(document.activeElement).toBe(reader);
      const beforePendingKey = scroller.scrollTop;
      const pendingScrollEnd = new Promise<void>((resolve) => {
        scroller.addEventListener("scrollend", () => resolve(), { once: true });
      });
      await userEvent.keyboard("{PageDown}");
      await pendingScrollEnd;
      expect(scroller.scrollTop).toBeGreaterThan(beforePendingKey);
      expect(keys.at(-1)).toEqual({ key: "PageDown", target: reader, trusted: true });
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
      let source = "/notes.md";
      let requestSourceUpdate: (() => void) | undefined;
      const container = document.createElement("div");
      container.className = "side-panel__panel";
      container.style.cssText = "display:flex;width:480px;height:600px;";
      const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
        content: SidebarContent;
        updateComplete: Promise<unknown>;
      };
      panel.className = "chat-sidebar";
      panel.content = {
        kind: "attachment",
        title: "notes.md",
        mimeType: "text/markdown",
        sourceIdentity: "attachment:notes",
        resolveSource: (requestUpdate) => {
          requestSourceUpdate = requestUpdate;
          return { status: "ready", src: source };
        },
      };
      container.append(panel);
      document.body.append(container);
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
      const viewport = expectDefined(
        panel.querySelector<HTMLElement>(".code-block-viewport"),
        "Code viewport",
      );
      const expand = expectDefined(
        panel.querySelector<HTMLButtonElement>(".code-block-expand"),
        "Expand control",
      );
      const wrap = expectDefined(
        panel.querySelector<HTMLButtonElement>(".code-block-wrap"),
        "Wrap control",
      );
      expect(viewport.id).not.toBe("");
      expect(expand.getAttribute("aria-controls")).toBe(viewport.id);
      expand.click();
      expect(expand.getAttribute("aria-expanded")).toBe("true");
      expect(getComputedStyle(wrap).display).not.toBe("none");
      wrap.click();
      expect(wrap.getAttribute("aria-pressed")).toBe("true");
      expect(panel.querySelector(".code-block-wrapper.is-wrapped")).not.toBeNull();

      const reader = expectDefined(panel.querySelector("article"), "Loaded reader");
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
          source = "/refreshed-notes.md";
          if (change === "identity") {
            panel.content = { ...panel.content, sourceIdentity: "attachment:other-notes" };
          }
          expectDefined(requestSourceUpdate, "Source update callback")();
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
          source = "/retried-notes.md";
          expectDefined(requestSourceUpdate, "Source update callback")();
          await expect.poll(() => fetchMock.mock.calls.length).toBe(3);
          recovered.resolve(nextResponse);
        } else {
          refreshed.resolve(nextResponse);
        }
        await expect.poll(() => nextResponse.bodyUsed && !nextResponse.body?.locked).toBe(true);
        await panel.querySelector("openclaw-chat-text-attachment")?.updateComplete;
        await expect
          .poll(() => panel.querySelector("article code")?.textContent)
          .toContain(change === "contents" ? "updatedLine" : "longLine");
        const nextReader = expectDefined(panel.querySelector("article"), "Refreshed reader");
        const retained = change === "transport";
        expect(nextReader === reader).toBe(retained);
        const nextExpand = expectDefined(
          nextReader.querySelector<HTMLButtonElement>(".code-block-expand"),
          "Refreshed expand control",
        );
        const nextWrap = expectDefined(
          nextReader.querySelector<HTMLButtonElement>(".code-block-wrap"),
          "Refreshed wrap control",
        );
        expect(nextExpand.getAttribute("aria-expanded")).toBe(String(retained));
        expect(nextWrap.getAttribute("aria-pressed")).toBe(String(retained));
        expect(
          nextReader.querySelector(".code-block-wrapper")?.classList.contains("is-expanded"),
        ).toBe(retained);
        expect(
          nextReader.querySelector(".code-block-wrapper")?.classList.contains("is-wrapped"),
        ).toBe(retained);
        const nextViewport = expectDefined(
          nextReader.querySelector<HTMLElement>(".code-block-viewport"),
          "Refreshed code viewport",
        );
        observedViewport = nextViewport;
        await expect.poll(() => isObserved(nextViewport)).toBe(true);
        await expect.poll(() => nextViewport.id).not.toBe("");
        expect(nextExpand.getAttribute("aria-controls")).toBe(nextViewport.id);
        expect(nextReader.querySelector("code")?.textContent).toContain(
          change === "contents" ? "updatedLine" : "longLine",
        );
        nextExpand.click();
        nextWrap.click();
        expect(nextWrap.getAttribute("aria-pressed")).toBe(String(!retained));
      } finally {
        refreshed.resolve(new Response(nextText));
        recovered.resolve(new Response(nextText));
        container.remove();
        expect(isObserved(observedViewport)).toBe(false);
      }
    },
  );
});
