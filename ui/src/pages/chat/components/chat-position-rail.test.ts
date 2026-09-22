/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { renderChatPositionRail } from "./chat-position-rail.ts";
import { getTranscriptState } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import { publishTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import {
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  resizeObservers,
  threadProps,
  transcriptDomState,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

function message(id: string, role: string, content: unknown, seq: number, runId?: string) {
  return {
    role,
    content,
    timestamp: seq * 1_000,
    __openclaw: { id, seq, ...(runId ? { runId } : {}) },
  };
}

function stubRailVisibility() {
  let publishVisibility: (element: Element) => void = () => {};
  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly scrollMargin = "0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        publishVisibility = (element) => {
          const rect = element.getBoundingClientRect();
          callback(
            [
              {
                target: element,
                boundingClientRect: rect,
                intersectionRect: rect,
                rootBounds: rect,
                intersectionRatio: 1,
                isIntersecting: true,
                time: 0,
              },
            ],
            this,
          );
        };
      }
      takeRecords = () => [];
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  return (element: Element) => publishVisibility(element);
}

describe("conversation position rail", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each(["mounted", "off-window", "focused"] as const)(
    "publishes current position and keyboard entry together for a %s observer target",
    (scenario) => {
      const flushFrame = stubAnimationFrames();
      const publishVisibility = stubRailVisibility();
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const activeMessage = vi.fn(() => "message-79");
      const markers = Array.from({ length: 80 }, (_, index) => ({
        id: `message-${index}`,
        anchorId: `message-${index}`,
        role: "user" as const,
        message: message(`message-${index}`, "user", `Checkpoint ${index}`, index + 1),
      }));
      render(
        transcript.renderSession("rail-publication", "agent:main:rail-publication", (session) => {
          vi.spyOn(session, "activeMessageId").mockImplementation(activeMessage);
          return html`<div class="chat-thread" tabindex="0">
            <div class="chat-bubble" data-entry-id="message-79">Latest message</div>
            ${renderChatPositionRail({
              positions: {
                markers,
                markerIdsByMessageId: new Map(markers.map(({ id }) => [id, id])),
              },
              transcript: session,
              requestUpdate: () => {},
            })}
          </div>`;
        }),
        container,
      );
      const root = container.querySelector<HTMLElement>(".chat-thread")!;
      const marks = container.querySelector<HTMLElement>(".chat-position-rail__marks")!;
      Object.defineProperty(marks, "clientHeight", { configurable: true, value: 240 });
      const marker = (id: string) =>
        marks.querySelector<HTMLButtonElement>(`[data-position-marker-id="${id}"]`);
      const current = () => marks.querySelector<HTMLButtonElement>('[aria-current="true"]');
      const tabStops = () => [...marks.querySelectorAll<HTMLButtonElement>('[tabindex="0"]')];
      try {
        flushFrame();
        publishVisibility(root.querySelector(".chat-bubble")!);
        flushFrame();
        root.focus();
        expect(current()).toBe(marker("message-79"));
        expect(tabStops()).toEqual([current()]);

        if (scenario === "focused") {
          marks.scrollTop = 40 * 12;
          marks.dispatchEvent(new Event("scroll"));
          flushFrame();
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
          marker("message-40")!.focus();
          expect(marker("message-40")!.matches(":focus-visible")).toBe(true);
        }
        const focused = document.activeElement;
        const offset = marks.scrollTop;
        const nextId = scenario === "mounted" ? "message-76" : "message-0";
        expect(marker(nextId) !== null).toBe(scenario === "mounted");
        activeMessage.mockReturnValue(nextId);
        publishVisibility(root.querySelector(".chat-bubble")!);

        // Observer delivery must not expose a new aria-current with the old Tab entry.
        // Assert before advancing any frame, rather than waiting out that mismatch.
        expect(current()).not.toBeNull();
        expect(tabStops()).toEqual([scenario === "focused" ? focused : current()]);
        expect(document.activeElement).toBe(focused);
        flushFrame();
        expect(current()?.dataset.positionMarkerId).toBe(nextId);
        expect(tabStops()).toEqual([scenario === "focused" ? focused : current()]);
        expect(document.activeElement).toBe(focused);
        expect(marks.querySelectorAll(".chat-position-rail__marker").length).toBeLessThan(50);
        if (scenario === "focused") {
          expect(marks.scrollTop).toBe(offset);
          // Leaving exploration restores the retained, off-window reader entry immediately.
          root.focus();
          expect(tabStops()).toEqual([current()]);
        }
        tabStops()[0]!.focus();
        expect(document.activeElement).toBe(current());
        root.focus();
        expect(tabStops()).toEqual([current()]);
      } finally {
        render(nothing, container);
        transcript.hostDisconnected();
      }
    },
  );

  const railUpdateScenarios = [
    "boot",
    "boot-resize",
    "resize",
    "resize-jump",
    "composer-resize-reversal",
    "composer-resize-reversal-current",
    "end",
    "focus",
    "focus-resize",
    "pointer",
    "reader",
    "composer-resize-reversal-navigation",
  ] as const;

  it.each(railUpdateScenarios)(
    "keeps the reader's rail position through %s updates",
    (scenario) => {
      const navigatesBeforeResize = scenario === "composer-resize-reversal-navigation";
      const flushFrame = stubAnimationFrames();
      const publishVisibility = stubRailVisibility();
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const settlesAtEnd = scenario === "end";
      const count = settlesAtEnd ? 5 : 80;
      const startsAtTop = settlesAtEnd || scenario === "resize-jump";
      const activeMessage = vi.fn((): string =>
        scenario === "resize-jump" ? "message-0" : settlesAtEnd ? "message-2" : "message-79",
      );
      const positions = {
        markers: Array.from({ length: count }, (_, index) => ({
          id: `message-${index}`,
          anchorId: `message-${index}`,
          role: "user" as const,
          message: message(`message-${index}`, "user", `Checkpoint ${index}`, index + 1),
        })),
        markerIdsByMessageId: new Map(
          Array.from({ length: count }, (_, index) => [`message-${index}`, `message-${index}`]),
        ),
      };
      render(
        transcript.renderSession(
          "rail-scroll-policy",
          "agent:main:rail-scroll-policy",
          (session) => {
            vi.spyOn(session, "activeMessageId").mockImplementation(activeMessage);
            return html`<div class="chat-thread" tabindex="0">
              <div class="chat-bubble" data-entry-id="message-79">Latest message</div>
              ${renderChatPositionRail({ positions, transcript: session, requestUpdate: () => {} })}
            </div>`;
          },
        ),
        container,
      );
      const root = container.querySelector<HTMLElement>(".chat-thread")!;
      const marks = container.querySelector<HTMLElement>(".chat-position-rail__marks")!;
      const marker = (index: number) =>
        marks.querySelector<HTMLButtonElement>(`[data-position-marker-id="message-${index}"]`)!;
      let height = settlesAtEnd ? 668 : 597;
      let scrollHeight = settlesAtEnd ? 700 : 8912;
      let marksHeight = settlesAtEnd ? 60 : 283;
      let railOffset = 0;
      Object.defineProperties(root, {
        clientHeight: { configurable: true, get: () => height },
        scrollHeight: { configurable: true, get: () => scrollHeight },
      });
      Object.defineProperties(marks, {
        clientHeight: { configurable: true, get: () => marksHeight },
        scrollTop: {
          configurable: true,
          get: () => railOffset,
          set: (value: number) => {
            railOffset = Math.max(0, Math.min(value, count * 12 - marksHeight));
          },
        },
      });
      root.scrollTop = startsAtTop ? 0 : 8315;
      const flush = () => {
        marks.dispatchEvent(new Event("scroll"));
        flushFrame();
        flushFrame();
      };
      try {
        flush();
        expect(marks.scrollTop).toBe(startsAtTop ? 0 : 677);
        expect(marks.querySelectorAll(".chat-position-rail__marker").length).toBeLessThan(50);
        if (scenario === "boot" || scenario === "boot-resize") {
          height = 554;
          marksHeight = 240;
          flush();
          // The initial observer result can arrive after the composer claims its space.
          publishVisibility(root.querySelector(".chat-bubble")!);
          if (scenario === "boot-resize") {
            height = 543;
            marksHeight = 229;
          }
          flush();
          expect(marker(79).hasAttribute("data-visible")).toBe(true);
          const initialOffset = scenario === "boot-resize" ? 731 : 720;
          expect(marks.scrollTop).toBe(initialOffset);
          height = 512;
          marksHeight = 198;
          flush();
          expect(marks.scrollTop).toBe(initialOffset);
        } else if (scenario === "end") {
          // Initial row measurements settle at the end before later composer growth.
          height = 552;
          scrollHeight = 552;
          activeMessage.mockReturnValue("message-4");
          flush();
          expect(marks.scrollTop).toBe(0);
          height = 452;
          scrollHeight = 486;
          root.scrollTop = 34;
          marksHeight = 47;
          flush();
          expect(marker(4).getAttribute("aria-current")).toBe("true");
          expect(marks.scrollTop).toBe(0);
        } else if (scenario === "resize-jump") {
          // Initial end navigation can share the frame that reveals the composer.
          height = 554;
          marksHeight = 240;
          root.scrollTop = 8358;
          activeMessage.mockReturnValue("message-79");
          flush();
          expect(marker(79).getAttribute("aria-current")).toBe("true");
          expect(Number.parseFloat(marker(79).style.top)).toBeGreaterThanOrEqual(marks.scrollTop);
          expect(Number.parseFloat(marker(79).style.top) + 12).toBeLessThanOrEqual(
            marks.scrollTop + marks.clientHeight,
          );
        } else if (scenario.startsWith("composer-resize-reversal")) {
          publishVisibility(root.querySelector(".chat-bubble")!);
          flush();
          height = 512;
          marksHeight = 198;
          let readerOffset = 8400;
          Object.defineProperty(root, "scrollTop", {
            configurable: true,
            get: () => Math.min(readerOffset, scrollHeight - height),
            set: (value: number) => {
              readerOffset = Math.max(0, Math.min(value, scrollHeight - height));
            },
          });
          flush();
          expect(marks.scrollTop).toBe(677);
          container.classList.add("chat");
          const textarea = container.appendChild(document.createElement("textarea"));
          textarea.value = "/goal";
          Object.defineProperties(textarea, {
            clientHeight: { configurable: true, value: 32 },
            scrollHeight: {
              configurable: true,
              get: () => {
                // Measuring the replacement draft commits the expanded transcript.
                height = 597;
                marksHeight = 283;
                return 32;
              },
            },
          });
          if (navigatesBeforeResize) {
            root.scrollTop = 0;
            activeMessage.mockReturnValue("message-0");
          }
          adjustTextareaHeight(textarea);
          expect(root.scrollTop).toBe(navigatesBeforeResize ? 0 : 8315);
          // The goal header regrows the composer before any observer or frame runs.
          height = 576;
          marksHeight = 262;
          if (scenario === "composer-resize-reversal-current") {
            activeMessage.mockReturnValue("message-76");
          }
          publishVisibility(root.querySelector(".chat-bubble")!);
          flush();
          if (navigatesBeforeResize) {
            expect(marks.scrollTop).toBe(0);
            return;
          }
          expect(marks.scrollTop).toBe(677);
          root.scrollTop = scrollHeight - height;
          flush();
          expect(marks.scrollTop).toBe(677);
        } else if (scenario === "resize") {
          height = 554;
          marksHeight = 240;
          activeMessage.mockReturnValue("message-76");
          flush();
          expect(marks.scrollTop).toBe(677);
          root.scrollTop = 8319;
          flush();
          expect(marks.scrollTop).toBe(677);
          // A second resize retargets the same smooth compensation, including its last 6px.
          height = 512;
          marksHeight = 198;
          flush();
          for (const offset of [8323, 8394, 8400]) {
            root.scrollTop = offset;
            flush();
            expect(marks.scrollTop).toBe(677);
          }
          publishTranscriptScroll(root, {
            type: "input",
            event: new WheelEvent("wheel", { deltaY: -200 }),
            touching: false,
          });
          root.scrollTop = 8000;
          activeMessage.mockReturnValue("message-40");
          flush();
          expect(marks.scrollTop).toBeLessThan(677);
        } else if (scenario === "focus") {
          marks.scrollTop = 60 * 12 - 100;
          flush();
          root.focus();
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
          marker(60).focus();
          expect(marker(60).matches(":focus-visible")).toBe(true);
          flush();
          expect(Number.parseFloat(marker(60).style.top)).toBeGreaterThanOrEqual(marks.scrollTop);
          expect(Number.parseFloat(marker(60).style.top) + 12).toBeLessThanOrEqual(
            marks.scrollTop + marks.clientHeight,
          );
          const focusedOffset = marks.scrollTop;
          activeMessage.mockReturnValue("message-77");
          publishVisibility(root.querySelector(".chat-bubble")!);
          expect([...marks.querySelectorAll('[tabindex="0"]')]).toEqual([marker(60)]);
          flush();
          expect(document.activeElement).toBe(marker(60));
          expect(marks.scrollTop).toBe(focusedOffset);
          marker(60).blur();
          activeMessage.mockReturnValue("message-79");
          publishVisibility(root.querySelector(".chat-bubble")!);
          // Native Tab may arrive before the scheduled reader update commits.
          const publishedMarker = marks.querySelector('[aria-current="true"]');
          expect([...marks.querySelectorAll('[tabindex="0"]')]).toEqual([publishedMarker]);
          // Observer updates publish reader position and Tab entry in the same layout frame.
          flush();
          expect(marker(79).getAttribute("aria-current")).toBe("true");
          expect([...marks.querySelectorAll('[tabindex="0"]')]).toEqual([marker(79)]);
          expect(marks.scrollTop).toBe(677);
        } else if (scenario === "focus-resize") {
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
          marker(79).focus();
          expect(marker(79).matches(":focus-visible")).toBe(true);
          height = 554;
          marksHeight = 240;
          flush();
          expect(document.activeElement).toBe(marker(79));
          expect(marks.scrollTop).toBe(720);
        } else if (scenario === "pointer") {
          marker(60).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          marker(60).focus();
          expect(marker(60).matches(":focus-visible")).toBe(false);
          expect(marks.scrollTop).toBe(677);
          activeMessage.mockReturnValue("message-0");
          flush();
          expect(document.activeElement).toBe(marker(60));
          expect(marks.scrollTop).toBe(0);
        } else {
          height = 554;
          marksHeight = 240;
          flush();
          expect(marks.scrollTop).toBe(677);
          publishTranscriptScroll(root, {
            type: "input",
            event: new WheelEvent("wheel", { deltaY: 120 }),
            touching: false,
          });
          root.scrollTop = 8319;
          flush();
          expect(marker(79).getAttribute("aria-current")).toBe("true");
          expect(marks.scrollTop).toBe(720);
        }
      } finally {
        render(nothing, container);
        transcript.hostDisconnected();
      }
    },
  );

  it("keeps stream edits off target scans while reconciling bubble mounts and identities", async () => {
    const observed = new Set<Element>();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = (element: Element) => observed.add(element);
        unobserve = (element: Element) => observed.delete(element);
        disconnect = () => observed.clear();
      },
    );
    const props = {
      ...threadProps("rail-mutations", "agent:main:rail-mutations", [
        message("question", "user", "Earlier question", 1),
        message("answer", "assistant", "Earlier answer", 2),
      ]),
      runActive: true,
      stream: "Live **start**",
      streamStartedAt: 3_000,
    };
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    };
    const settleFrames = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    props.onRequestUpdate = rerender;
    try {
      rerender();
      transcript.hostConnected();
      const root = container.querySelector<HTMLElement>(".chat-thread");
      const marks = container.querySelector<HTMLElement>(".chat-position-rail__marks");
      const original = container.querySelector<HTMLElement>(
        '.chat-bubble[data-entry-id="question"]',
      );
      assert(root && marks && original);
      Object.defineProperty(marks, "clientHeight", { configurable: true, value: 600 });
      await settleFrames();
      expect(observed.has(original)).toBe(true);
      const query = vi.spyOn(root, "querySelectorAll");
      const targetScans = () =>
        query.mock.calls.filter(([selector]) => selector === ".chat-bubble[data-entry-id]").length;

      for (const word of ["one", "two", "three"]) {
        props.stream = `Live **${word}**`;
        rerender();
        await settleFrames();
        expect(container.querySelector(".chat-bubble strong")?.textContent).toBe(word);
        expect(container.querySelector('.chat-bubble[data-entry-id="question"]')).toBe(original);
      }
      expect(targetScans()).toBe(0);

      original.remove();
      await settleFrames();
      expect(targetScans()).toBeGreaterThan(0);
      expect(observed.has(original)).toBe(false);
      query.mockClear();

      const replacement = original.cloneNode(true) as HTMLElement;
      root.append(replacement);
      await settleFrames();
      expect(targetScans()).toBeGreaterThan(0);
      expect(observed.has(replacement)).toBe(true);
      query.mockClear();
      replacement.remove();
      await settleFrames();
      expect(targetScans()).toBeGreaterThan(0);
      expect(observed.has(replacement)).toBe(false);
      query.mockClear();

      const wrapper = document.createElement("section");
      wrapper.append(replacement);
      root.append(wrapper);
      await settleFrames();
      expect(targetScans()).toBeGreaterThan(0);
      expect(observed.has(replacement)).toBe(true);
      query.mockClear();
      wrapper.remove();
      await settleFrames();
      expect(targetScans()).toBeGreaterThan(0);
      expect(observed.has(replacement)).toBe(false);
      query.mockClear();

      replacement.removeAttribute("data-entry-id");
      root.append(replacement);
      await settleFrames();
      expect(targetScans()).toBe(0);
      replacement.dataset.entryId = "question";
      await settleFrames();
      expect(targetScans()).toBeGreaterThan(0);
      expect(observed.has(replacement)).toBe(true);
      query.mockClear();
      replacement.removeAttribute("data-entry-id");
      await settleFrames();
      expect(targetScans()).toBeGreaterThan(0);
      expect(observed.has(replacement)).toBe(false);
    } finally {
      render(nothing, container);
      transcript.hostDisconnected();
    }
  });

  it("publishes consecutive reader offsets even when the virtual row range is unchanged", async () => {
    transcriptDomState.measuredRowHeight = 120;
    const requestUpdate = vi.fn();
    const transcript = new ChatTranscriptController({
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate,
      updateComplete: Promise.resolve(true),
    });
    const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "content",
      key: `row-${index}`,
      content: html`<div>${index}</div>`,
    }));
    const { container, session, renderRows } = await mountTestTranscript(
      "rail-notification",
      rows,
      transcript,
    );
    try {
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 4800 },
      });
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 600);
      }
      const ids = rows.map((row) => row.key);
      session.syncMessageRows(
        new Map(ids.map((id) => [id, id])),
        new Map(ids.map((id) => [id, id])),
      );
      renderRows(rows);
      const currentId = () => session.activeMessageId(["row-2", "row-3"]);
      container.scrollTop = 50;
      container.dispatchEvent(new Event("scroll"));
      expect(currentId()).toBe("row-2");
      requestUpdate.mockClear();

      // Both viewports span rows 0–5, but their midpoints straddle row 3.
      // TanStack's range/isScrolling notification alone cannot publish this.
      container.scrollTop = 70;
      container.dispatchEvent(new Event("scroll"));
      expect(requestUpdate).toHaveBeenCalled();
      expect(currentId()).toBe("row-3");
      requestUpdate.mockClear();
      container.scrollTop = 50;
      container.dispatchEvent(new Event("scroll"));
      expect(requestUpdate).toHaveBeenCalled();
      expect(currentId()).toBe("row-2");

      Object.defineProperty(container, "clientHeight", { configurable: true, value: 640 });
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 640);
      }
      expect(currentId()).toBe("row-3");
      requestUpdate.mockClear();
      container.dispatchEvent(new Event("scroll"));
      expect(requestUpdate).not.toHaveBeenCalled();

      transcript.hostDisconnected();
      requestUpdate.mockClear();
      container.scrollTop = 70;
      container.dispatchEvent(new Event("scroll"));
      expect(requestUpdate).not.toHaveBeenCalled();
    } finally {
      transcript.hostDisconnected();
    }
  });

  it("resolves distant reader positions before scroll notification and counts the header once", async () => {
    transcriptDomState.measuredRowHeight = 120;
    const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "content",
      key: `row-${index}`,
      content: html`<div>${index}</div>`,
    }));
    const { container, transcript, session, renderRows } = await mountTestTranscript(
      "rail-offset",
      rows,
    );
    try {
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 4880 },
      });
      container.style.paddingTop = "80px";
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 600);
      }
      const ids = rows.map((row) => row.key);
      session.syncMessageRows(
        new Map(ids.map((id) => [id, id])),
        new Map(ids.map((id) => [id, id])),
      );
      renderRows(rows);
      // No scroll event or render between these queries: mounted rows are stale.
      container.scrollTop = 100;
      expect(session.activeMessageId(ids)).toBe("row-2");
      container.scrollTop = 3000;
      expect(session.activeMessageId(ids)).toBe("row-26");
      Object.defineProperty(container, "clientHeight", { configurable: true, value: 300 });
      expect(session.activeMessageId(ids)).toBe("row-25");
      container.scrollTop = 4580;
      expect(session.activeMessageId(ids)).toBe("row-39");
      expect(session.activeMessageId(["missing"])).toBeNull();
    } finally {
      transcript.hostDisconnected();
    }
  });

  it("keeps focused previews after pointer exit and resets interaction when the session changes", () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(
        `message-${index}`,
        index % 2 ? "assistant" : "user",
        `Checkpoint ${index}`,
        index + 1,
      ),
    );
    const props = threadProps("rail-interaction", "agent:main:first", messages);
    const historyIntent = vi.fn();
    props.onHistoryIntent = historyIntent;
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    };
    props.onRequestUpdate = rerender;
    const markers = () => [
      ...container.querySelectorAll<HTMLButtonElement>(".chat-position-rail__marker"),
    ];
    const preview = () => container.querySelector(".chat-position-rail__preview-copy")?.textContent;
    try {
      rerender();
      transcript.hostConnected();
      expect(markers()).toHaveLength(40);
      // Rail wheel input belongs to its scrollport, never transcript history.
      for (const type of ["wheel", "touchstart", "touchmove"]) {
        container
          .querySelector(".chat-position-rail__marks")!
          .dispatchEvent(new Event(type, { bubbles: true }));
      }
      for (const key of ["PageUp", "PageDown"]) {
        expect(
          markers()[0]!.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
          ),
        ).toBe(true);
      }
      expect(historyIntent).not.toHaveBeenCalled();
      container
        .querySelector(".chat-thread")!
        .dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      expect(historyIntent).toHaveBeenCalledOnce();
      container
        .querySelector(".chat-thread")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
      expect(historyIntent).toHaveBeenCalledTimes(2);
      expect(preview()).toBeUndefined();
      markers()[4]!.focus();
      expect(preview()).toContain("Checkpoint 4");
      markers()[2]!.dispatchEvent(new Event("pointerenter"));
      expect(preview()).toContain("Checkpoint 2");
      container.querySelector(".chat-position-rail")!.dispatchEvent(new Event("pointerleave"));
      expect(preview()).toContain("Checkpoint 4");
      markers()[4]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(markers()[5]);
      expect(preview()).toContain("Checkpoint 5");
      const focused = document.activeElement;
      props.messages = [
        ...messages,
        message("message-40", "user", "Checkpoint 40", 41),
        message("message-41", "assistant", "Checkpoint 41", 42),
      ];
      rerender();
      expect(markers()).toHaveLength(42);
      expect(document.activeElement).toBe(focused);
      expect(preview()).toContain("Checkpoint 5");
      focused!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(preview()).toBeUndefined();
      markers()[0]!.focus();
      expect(preview()).toBeDefined();
      render(nothing, container);
      const escapeAfterRemoval = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(escapeAfterRemoval);
      expect(escapeAfterRemoval.defaultPrevented).toBe(false);
      rerender();
      expect(preview()).toBeUndefined();
      props.sessionKey = "agent:main:second";
      rerender();
      expect(preview()).toBeUndefined();
      const state = getTranscriptState(props.paneId);
      state.searchOpen = true;
      state.searchQuery = "Checkpoint 5";
      rerender();
      expect(markers()).toHaveLength(1);
      state.searchQuery = "not present";
      rerender();
      expect(markers()).toHaveLength(0);
    } finally {
      transcript.hostDisconnected();
    }
  });

  it.each([
    { role: "user", senderName: undefined, label: "User message" },
    { role: "user", senderName: "Alice Example", label: "Alice Example" },
    { role: "assistant", senderName: "Alice Example", label: "Assistant message" },
  ])(
    "renders safe Markdown and attribution in $role previews ($label)",
    ({ role, senderName, label }) => {
      const messages = [
        message(
          "formatted",
          role,
          "**Important** *detail* `code`\n\n- [Guide](https://example.com)\n<script>alert(1)</script>",
          1,
        ),
        message("next", role === "user" ? "assistant" : "user", "Next turn", 2),
      ];
      Object.assign(messages[0]!["__openclaw"], { senderName });
      const props = threadProps("rail-markdown", "agent:main:markdown", messages);
      props.userName = "Local Viewer";
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const rerender = () => {
        render(renderChatThread(props, transcript), container);
        transcript.hostUpdated();
      };
      props.onRequestUpdate = rerender;
      try {
        rerender();
        transcript.hostConnected();
        container.querySelector<HTMLButtonElement>(".chat-position-rail__marker")!.focus();
        const preview = container.querySelector(".chat-position-rail__preview-copy")!;
        expect(container.querySelector(".chat-position-rail__preview-label")?.textContent).toBe(
          label,
        );
        const avatar = container.querySelector(".chat-position-rail__preview .chat-author-avatar");
        expect(avatar?.getAttribute("aria-label") ?? null).toBe(
          role === "user" ? (senderName ?? null) : null,
        );
        expect(preview.querySelector("strong")?.textContent).toBe("Important");
        expect(preview.querySelector("em")?.textContent).toBe("detail");
        expect(preview.querySelector("code")?.textContent).toBe("code");
        expect(preview.querySelector("li a")?.textContent).toBe("Guide");
        expect(preview.querySelector("script")).toBeNull();
        expect(preview.closest("[inert]")).not.toBeNull();
      } finally {
        render(nothing, container);
        transcript.hostDisconnected();
      }
    },
  );

  it("indexes three assistant messages as one run when history starts mid-run", () => {
    // A paginated history window can omit the user boundary of an existing run.
    const messages = [
      message("first", "assistant", "Checking the existing style", 1, "run-partial"),
      message(
        "call-1",
        "assistant",
        [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
        2,
        "run-partial",
      ),
      {
        ...message("result-1", "toolResult", "Styles loaded", 3, "run-partial"),
        toolCallId: "read-1",
        toolName: "read",
      },
      message("second", "assistant", "Rendering the launch card", 4, "run-partial"),
      message(
        "call-2",
        "assistant",
        [{ type: "toolCall", id: "render-1", name: "exec", arguments: {} }],
        5,
        "run-partial",
      ),
      {
        ...message("result-2", "toolResult", "Asset rendered", 6, "run-partial"),
        toolCallId: "render-1",
        toolName: "exec",
      },
      message("final", "assistant", "The launch card is ready", 7, "run-partial"),
      message("thinking", "assistant", "<thinking>Private planning</thinking>", 8, "run-partial"),
    ];
    const props = {
      ...threadProps("rail-partial-run", "agent:main:main", messages),
      showToolCalls: true,
    };
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    props.onRequestUpdate = () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    };
    try {
      props.onRequestUpdate();
      transcript.hostConnected();
      const markers = container.querySelectorAll<HTMLButtonElement>(".chat-position-rail__marker");
      expect(markers).toHaveLength(1);
      markers[0]!.focus();
      expect(container.querySelector(".chat-position-rail__preview-copy")?.textContent).toContain(
        "The launch card is ready",
      );
      expect(
        container.querySelector(".chat-position-rail__preview-copy")?.textContent,
      ).not.toContain("Styles loaded");
    } finally {
      render(nothing, container);
      transcript.hostDisconnected();
    }
  });

  it("keeps the focused run marker through streaming and retargets its persisted answer", async () => {
    const observed = new Set<Element>();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = (element: Element) => observed.add(element);
        unobserve = (element: Element) => observed.delete(element);
        disconnect = () => observed.clear();
      },
    );
    const settleFrames = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    const user = message("question", "user", "Review the card", 1, "stream-run");
    const props = threadProps("rail-stream-handoff", "agent:main:main", [user]);
    Object.assign(props, {
      runId: "stream-run",
      runActive: true,
      runWorking: true,
      stream: "<thinking>Private planning</thinking>",
      streamStartedAt: 2_000,
    });
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    };
    props.onRequestUpdate = rerender;
    const marker = () =>
      container.querySelector<HTMLButtonElement>('[data-position-marker-id="run:stream-run"]')!;
    try {
      rerender();
      transcript.hostConnected();
      expect(container.querySelectorAll(".chat-position-rail__marker")).toHaveLength(1);
      props.stream = "Draft response";
      rerender();
      const provisional = marker();
      provisional.focus();
      expect(container.querySelector(".chat-position-rail__preview-copy")?.textContent).toContain(
        "Draft response",
      );
      const streamBubble = [...container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
        (bubble) => bubble.textContent?.includes("Draft response"),
      )!;
      const root = container.querySelector<HTMLElement>(".chat-thread")!;
      const marks = container.querySelector<HTMLElement>(".chat-position-rail__marks")!;
      Object.defineProperty(marks, "clientHeight", { configurable: true, value: 600 });
      await settleFrames();
      expect(observed.has(streamBubble)).toBe(true);
      const query = vi.spyOn(root, "querySelectorAll");
      props.stream = "Draft **updated** response";
      rerender();
      await settleFrames();
      expect(streamBubble.querySelector("strong")?.textContent).toBe("updated");
      expect(query.mock.calls.filter(([selector]) => selector.includes(".chat-bubble"))).toEqual(
        [],
      );
      const streamParent = streamBubble.parentNode!;
      const streamNext = streamBubble.nextSibling;
      streamBubble.remove();
      await settleFrames();
      expect(observed.has(streamBubble)).toBe(false);
      const wrapper = document.createElement("section");
      wrapper.append(streamBubble);
      root.append(wrapper);
      await settleFrames();
      expect(observed.has(streamBubble)).toBe(true);
      const streamId = streamBubble.dataset.messageId!;
      delete streamBubble.dataset.messageId;
      await settleFrames();
      expect(observed.has(streamBubble)).toBe(false);
      streamBubble.dataset.messageId = streamId;
      await settleFrames();
      expect(observed.has(streamBubble)).toBe(true);
      streamParent.insertBefore(streamBubble, streamNext);
      wrapper.remove();
      await settleFrames();
      provisional.click();
      await Promise.resolve();
      expect(streamBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
      props.messages = [
        user,
        message("persisted-answer", "assistant", "Final response", 3, "stream-run"),
      ];
      Object.assign(props, { stream: null, runActive: false, runWorking: false, runId: null });
      rerender();
      expect(marker()).toBe(provisional);
      expect(document.activeElement).toBe(provisional);
      expect(container.querySelector(".chat-position-rail__preview-copy")?.textContent).toContain(
        "Final response",
      );
      const persistedBubble = container.querySelector<HTMLElement>(
        '[data-entry-id="persisted-answer"]',
      )!;
      marker().click();
      await Promise.resolve();
      expect(persistedBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
      expect(container.querySelectorAll(".chat-position-rail__marker")).toHaveLength(2);
    } finally {
      render(nothing, container);
      transcript.hostDisconnected();
    }
  });
});
