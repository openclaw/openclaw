/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { message, stubRailVisibility } from "./chat-position-rail.test-support.ts";
import { renderChatPositionRail } from "./chat-position-rail.ts";
import { getTranscriptState } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
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
        transcript.renderSession("agent:main:rail-publication", (session) => {
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
      for (const observer of resizeObservers) {
        observer.emitTarget(marks, 44, 240);
      }
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

  it("reveals only overflowing transcripts and retires focus when they fit again", () => {
    const flushFrame = stubAnimationFrames();
    stubRailVisibility();
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const positions = {
      markers: [
        {
          id: "short",
          anchorId: "short",
          role: "user" as const,
          message: message("short", "user", "A short question", 1),
        },
      ],
      markerIdsByMessageId: new Map([["short", "short"]]),
    };
    const update = () =>
      render(
        transcript.renderSession(
          "agent:main:rail-overflow",
          (session) => html`
            <div class="chat-thread" tabindex="0">
              <div class="chat-bubble" data-entry-id="short">A short question</div>
              ${renderChatPositionRail({ positions, transcript: session, requestUpdate: update })}
            </div>
          `,
        ),
        container,
      );
    try {
      update();
      const root = container.querySelector<HTMLElement>(".chat-thread")!;
      const rail = root.querySelector<HTMLElement>(".chat-position-rail")!;
      const marks = rail.querySelector<HTMLElement>(".chat-position-rail__marks")!;
      Object.defineProperties(root, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 600 },
      });
      Object.defineProperty(marks, "clientHeight", { configurable: true, value: 12 });
      for (const observer of resizeObservers) {
        observer.emitTarget(marks, 44, 12);
      }
      flushFrame();
      expect(rail.hasAttribute("data-overflow")).toBe(false);
      const resize = (clientHeight: number, scrollHeight: number) => {
        publishTranscriptScroll(root, {
          type: "resize",
          viewport: { clientHeight, scrollHeight, scrollTop: 0 },
        });
        flushFrame();
      };
      resize(600, 900);
      expect(rail.hasAttribute("data-overflow")).toBe(true);
      const marker = rail.querySelector<HTMLButtonElement>("button")!;
      marker.focus();
      expect(document.activeElement).toBe(marker);
      resize(900, 900);
      expect(rail.hasAttribute("data-overflow")).toBe(false);
      expect(document.activeElement).toBe(root);
      expect(rail.querySelector(".chat-position-rail__preview")).toBeNull();
      resize(600, 601);
      expect(rail.hasAttribute("data-overflow")).toBe(false);
      resize(600, 602);
      expect(rail.hasAttribute("data-overflow")).toBe(true);
      resize(0, 602);
      expect(rail.hasAttribute("data-overflow")).toBe(false);
    } finally {
      render(nothing, container);
      transcript.hostDisconnected();
    }
  });

  const railUpdateScenarios = [
    "boot-resize",
    "resize",
    "resize-jump",
    "composer-resize-reversal-current",
    "focus-resize",
    "pointer",
    "reader-offset",
    "hidden",
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
      const count = 80;
      const startsAtTop = scenario === "resize-jump";
      const activeMessage = vi.fn((): string =>
        scenario === "resize-jump" ? "message-0" : "message-79",
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
      const renderRail = () =>
        render(
          transcript.renderSession("agent:main:rail-scroll-policy", (session) => {
            vi.spyOn(session, "activeMessageId").mockImplementation(activeMessage);
            return html`<div class="chat-thread" tabindex="0">
              <div class="chat-bubble" data-entry-id="message-79">Latest message</div>
              ${renderChatPositionRail({ positions, transcript: session, requestUpdate: () => {} })}
            </div>`;
          }),
          container,
        );
      renderRail();
      const root = container.querySelector<HTMLElement>(".chat-thread")!;
      const marks = container.querySelector<HTMLElement>(".chat-position-rail__marks")!;
      const marker = (index: number) =>
        marks.querySelector<HTMLButtonElement>(`[data-position-marker-id="message-${index}"]`)!;
      let height = 597;
      const scrollHeight = 8912;
      let marksHeight = 283;
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
        if (scenario === "hidden") {
          const mounted = [...marks.querySelectorAll(".chat-position-rail__marker")];
          marksHeight = 0;
          railOffset = 0;
          for (const observer of resizeObservers) {
            observer.emitTarget(marks, 44, 0);
          }
          flushFrame();
          renderRail();
          flushFrame();
          expect([...marks.querySelectorAll(".chat-position-rail__marker")]).toEqual(mounted);
          expect(marks.style.getPropertyValue("--chat-position-scroll-top")).toBe("677px");

          // Reader navigation while hidden must be reflected once the rail returns.
          root.scrollTop = 0;
          activeMessage.mockReturnValue("message-0");
          marksHeight = 283;
          for (const observer of resizeObservers) {
            observer.emitTarget(marks, 44, 283);
          }
          flushFrame();
          expect(marker(0).getAttribute("aria-current")).toBe("true");
          expect(marks.style.getPropertyValue("--chat-position-scroll-top")).toBe("0px");
        } else if (scenario === "boot-resize") {
          height = 554;
          marksHeight = 240;
          flush();
          // The initial observer result can arrive after the composer claims its space.
          publishVisibility(root.querySelector(".chat-bubble")!);
          height = 543;
          marksHeight = 229;
          flush();
          expect(marker(79).hasAttribute("data-visible")).toBe(true);
          const initialOffset = 731;
          expect(marks.scrollTop).toBe(initialOffset);
          height = 512;
          marksHeight = 198;
          flush();
          expect(marks.scrollTop).toBe(initialOffset);
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
        } else if (scenario === "focus-resize") {
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
          marker(79).focus();
          expect(marker(79).matches(":focus-visible")).toBe(true);
          height = 554;
          marksHeight = 240;
          flush();
          expect(document.activeElement).toBe(marker(79));
          expect(marks.scrollTop).toBe(720);
        } else if (scenario === "reader-offset") {
          // Reading within the rendered rows re-renders nothing; the published
          // offset alone must move the current marker.
          activeMessage.mockReturnValue("message-78");
          root.scrollTop = 8200;
          publishTranscriptScroll(root, {
            type: "offset",
            delta: -115,
            scrolling: true,
            touching: false,
            programmatic: false,
          });
          for (const observer of resizeObservers) {
            observer.emitTarget(marks, 44, marksHeight);
          }
          flushFrame();
          expect(marker(78).getAttribute("aria-current")).toBe("true");
        } else if (scenario === "pointer") {
          marker(60).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          marker(60).focus();
          expect(marker(60).matches(":focus-visible")).toBe(false);
          expect(marks.scrollTop).toBe(677);
          activeMessage.mockReturnValue("message-0");
          flush();
          expect(document.activeElement).toBe(marker(60));
          expect(marks.scrollTop).toBe(0);
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
      for (const observer of resizeObservers) {
        observer.emitTarget(marks, 44, 600);
      }
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

  it("keeps focused previews after pointer exit and resets interaction when the session changes", async () => {
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
      await Promise.resolve();
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
    { role: "user", senderName: "Alice Example", label: "Alice Example" },
    { role: "assistant", senderName: "Alice Example", label: "Molty" },
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
      if (role === "assistant") {
        props.assistantAvatar = "🦞";
      }
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
          role === "user" ? (senderName ?? null) : "Molty",
        );
        if (role === "assistant") {
          expect(avatar?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
            "🦞",
          );
          expect(
            container.querySelector(".chat-position-rail__marker")?.getAttribute("aria-label"),
          ).toContain("Molty");
          props.assistantName = "Roboclaw";
          rerender();
          expect(container.querySelector(".chat-position-rail__preview-label")?.textContent).toBe(
            "Roboclaw",
          );
          expect(
            container
              .querySelector(".chat-position-rail__preview .chat-author-avatar")
              ?.getAttribute("aria-label"),
          ).toBe("Roboclaw");
        }
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
      for (const observer of resizeObservers) {
        observer.emitTarget(marks, 44, 600);
      }
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
      // Reveal settles the committed target's geometry on the render lifecycle's layout phase.
      await settleFrames();
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
      await settleFrames();
      expect(persistedBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
      expect(container.querySelectorAll(".chat-position-rail__marker")).toHaveLength(2);
    } finally {
      render(nothing, container);
      transcript.hostDisconnected();
    }
  });
});
