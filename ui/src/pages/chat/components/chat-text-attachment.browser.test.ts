import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-sidebar.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe.runIf("__vitest_browser__" in globalThis)("Markdown attachment controls", () => {
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
        await expect.poll(() => reader.checkVisibility()).toBe(false);
        expect(isObserved(viewport)).toBe(false);
        expect(panel.querySelector('[role="status"]')).not.toBeNull();

        if (change === "failed refresh") {
          refreshed.resolve(new Response("Temporarily unavailable", { status: 503 }));
          await expect.poll(() => panel.textContent).toContain("Download it to read the full file");
          expect(reader.checkVisibility()).toBe(false);
          expect(isObserved(viewport)).toBe(false);
          source = "/retried-notes.md";
          expectDefined(requestSourceUpdate, "Source update callback")();
          await expect.poll(() => fetchMock.mock.calls.length).toBe(3);
          recovered.resolve(new Response(nextText));
        } else {
          refreshed.resolve(new Response(nextText));
        }
        await expect.poll(() => panel.querySelector("article")).not.toBeNull();
        const nextReader = expectDefined(panel.querySelector("article"), "Refreshed reader");
        const retained = change === "transport";
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
