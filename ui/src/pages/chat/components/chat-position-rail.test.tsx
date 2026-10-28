/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript, stubSettledAnimationFrames } from "../chat-view.test-helpers.ts";
import {
  mountChatThread as mountThread,
  mountTestTranscript,
} from "../test-helpers/chat-transcript-native.tsx";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { ChatPositionRail } from "./chat-position-rail-solid.tsx";
import { message, stubRailVisibility } from "./chat-position-rail.test-support.ts";
import { getTranscriptState } from "./chat-thread-interactions.ts";
import { contentRows, emitTranscriptResize } from "./chat-transcript-fixture.test-support.tsx";
import { publishTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
  threadProps,
  transcriptDomState,
} from "./chat-transcript.test-support.ts";

const fixtureCleanups: Array<() => void> = [];
const ownFixture = (cleanup: () => void) => fixtureCleanups.push(cleanup);

function threadFixture(props: ReturnType<typeof threadProps>) {
  const transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountThread(container, transcript);
  ownFixture(() => {
    view.unmount();
    transcript.dispose();
  });
  return {
    transcript,
    container,
    view,
    query: (selector: string) => container.querySelector<HTMLElement>(selector),
    markers: () => [
      ...container.querySelectorAll<HTMLButtonElement>(".chat-position-rail__marker"),
    ],
    preview: () => part(container, "preview-copy")?.textContent,
    rerender: () => {
      view.render(props);
      transcript.update();
    },
  };
}

function railPositions(count: number) {
  const markers = Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    anchorId: `message-${index}`,
    role: "user" as const,
    message: message(`message-${index}`, "user", `Checkpoint ${index}`, index + 1),
  }));
  return { markers, markerIdsByMessageId: new Map(markers.map(({ id }) => [id, id])) };
}
function mountRail(
  sessionKey: string,
  positions: ReturnType<typeof railPositions>,
  activeMessage?: () => string,
) {
  const transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  const id = positions.markers.at(-1)!.id;
  const [current, setCurrent] = createSignal(positions);
  const view = mountSolid(
    () =>
      transcript.renderSession(sessionKey, (session) => {
        if (activeMessage) {
          vi.spyOn(session, "activeMessageId").mockImplementation(activeMessage);
        }
        return (
          <div class="chat-thread" tabindex="0">
            <div ref={session.messageElements.forKey(id)} class="chat-bubble" data-entry-id={id}>
              Latest message
            </div>
            <ChatPositionRail positions={current()} transcript={session} />
          </div>
        );
      }),
    { container },
  );
  ownFixture(() => {
    view.unmount();
    transcript.dispose();
  });
  return {
    container,
    root: container.querySelector<HTMLElement>(".chat-thread")!,
    marks: part(container, "marks")!,
    renderRail: () => {
      setCurrent({ ...positions });
      flush();
    },
  };
}
function railFixture(sessionKey: string, count = 80, initialId = "message-79") {
  const flushFrame = stubSettledAnimationFrames();
  const publishVisibility = stubRailVisibility();
  const positions = railPositions(count);
  const activeMessage = vi.fn(() => initialId);
  return {
    ...mountRail(sessionKey, positions, activeMessage),
    activeMessage,
    flushFrame,
    publishVisibility,
  };
}

function part(root: ParentNode, name: string) {
  return root.querySelector<HTMLElement>(`.chat-position-rail__${name}`);
}

function measure(element: Element, values: Record<string, number | (() => number)>) {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(element, key, {
      configurable: true,
      ...(typeof value === "function" ? { get: value } : { value }),
    });
  }
}

function markerAt(root: ParentNode, id: string | number) {
  return root.querySelector<HTMLButtonElement>(
    `[data-position-marker-id="${typeof id === "number" ? `message-${id}` : id}"]`,
  )!;
}

function pressKey(target: EventTarget, key: string, bubbles = true) {
  const event = new KeyboardEvent("keydown", { key, bubbles, cancelable: true });
  target.dispatchEvent(event);
  flush();
  return event;
}
function observeBubbles() {
  const observed = new Set<Element>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = (element: Element) => observed.add(element);
      unobserve = (element: Element) => observed.delete(element);
      disconnect = () => observed.clear();
    },
  );
  return observed;
}
const settleFrames = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

describe("conversation position rail", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(() => {
    for (const cleanup of fixtureCleanups.splice(0).toReversed()) {
      cleanup();
    }
    resetTranscriptTestDom();
  });

  it.each(["mounted", "off-window", "focused", "offset-only"] as const)(
    "publishes current position and keyboard entry together for a %s observer target",
    (scenario) => {
      const { flushFrame, publishVisibility, activeMessage, root, marks } = railFixture(
        "agent:main:rail-publication",
      );
      measure(marks, { clientHeight: 240 });
      emitTranscriptResize(marks, 44, 240);
      const marker = (id: string) => markerAt(marks, id);
      const current = () => marks.querySelector<HTMLButtonElement>('[aria-current="true"]');
      const tabStops = () => [...marks.querySelectorAll<HTMLButtonElement>('[tabindex="0"]')];
      flushFrame();
      publishVisibility(root.querySelector(".chat-bubble")!);
      flushFrame();
      root.focus();
      expect(current()).toBe(marker("message-79"));
      expect(tabStops()).toEqual([current()]);

      // Consume the initial reveal's trailing frame before testing an offset-only update.
      if (scenario === "offset-only") {
        flushFrame();
      }
      const resize = [...resizeObservers].find((observer) => observer.observes(marks));
      assert(resize);
      const observe = vi.spyOn(resize, "observe");
      const unobserve = vi.spyOn(resize, "unobserve");

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
      if (scenario === "offset-only") {
        root.scrollTop += 100;
        publishTranscriptScroll(root, {
          type: "offset",
          delta: 100,
          scrolling: true,
          touching: false,
          programmatic: false,
        });
        expect(current()).toBe(marker("message-79"));
      } else {
        publishVisibility(root.querySelector(".chat-bubble")!);
      }

      expect(current()).not.toBeNull();
      expect(tabStops()).toEqual([scenario === "focused" ? focused : current()]);
      expect(document.activeElement).toBe(focused);
      flushFrame();
      expect(current()?.dataset.positionMarkerId).toBe(nextId);
      if (scenario === "offset-only") {
        expect(observe).not.toHaveBeenCalled();
        expect(unobserve).not.toHaveBeenCalled();
        expect(resize.observes(marks)).toBe(true);
      }
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
      if (scenario === "off-window") {
        tabStops()[0]!.focus();
        for (const [key, index] of [
          ["End", 79],
          ["Home", 0],
        ] as const) {
          const focusedMarker = document.activeElement;
          assert(focusedMarker instanceof HTMLButtonElement);
          // The marker commits in Solid's microtask; no animation frame is required.
          pressKey(focusedMarker, key);
          expect(document.activeElement).toBe(marker(`message-${index}`));
          expect(tabStops()).toEqual([document.activeElement]);
        }
      }
    },
  );

  it("requires more than one pixel of overflow and a nonzero viewport", () => {
    const flushFrame = stubSettledAnimationFrames();
    stubRailVisibility();
    const positions = railPositions(1);
    const { root, marks } = mountRail("agent:main:rail-overflow", positions);
    const rail = root.querySelector<HTMLElement>(".chat-position-rail")!;
    let viewportHeight = 600;
    let transcriptHeight = 600;
    Object.defineProperties(root, {
      clientHeight: { configurable: true, get: () => viewportHeight },
      scrollHeight: { configurable: true, get: () => transcriptHeight },
    });
    Object.defineProperty(marks, "clientHeight", { configurable: true, value: 12 });
    emitTranscriptResize(marks, 44, 12);
    flushFrame();
    const resize = (clientHeight: number, scrollHeight: number) => {
      viewportHeight = clientHeight;
      transcriptHeight = scrollHeight;
      publishTranscriptScroll(root, {
        type: "resize",
        viewport: { clientHeight, scrollHeight, scrollTop: 0 },
      });
      flushFrame();
    };
    resize(600, 601);
    expect(rail.hasAttribute("data-overflow")).toBe(false);
    resize(600, 602);
    expect(rail.hasAttribute("data-overflow")).toBe(true);
    resize(0, 602);
    expect(rail.hasAttribute("data-overflow")).toBe(false);
  });

  const railUpdateScenarios = [
    "boot-resize",
    "resize",
    "resize-jump",
    "composer-resize-reversal-current",
    "focus-resize",
    "pointer",
    "hidden",
    "composer-resize-reversal-navigation",
  ] as const;

  it.each(railUpdateScenarios)(
    "keeps the reader's rail position through %s updates",
    (scenario) => {
      const navigatesBeforeResize = scenario === "composer-resize-reversal-navigation";
      const startsAtTop = scenario === "resize-jump";
      const count = 80;
      const { flushFrame, publishVisibility, container, activeMessage, root, marks, renderRail } =
        railFixture(
          "agent:main:rail-scroll-policy",
          count,
          startsAtTop ? "message-0" : "message-79",
        );
      const marker = (index: number) => markerAt(marks, index);
      let height = 597;
      const scrollHeight = 8912;
      let marksHeight = 283;
      let railOffset = 0;
      measure(root, { clientHeight: () => height, scrollHeight });
      measure(marks, { clientHeight: () => marksHeight });
      Object.defineProperty(marks, "scrollTop", {
        configurable: true,
        get: () => railOffset,
        set: (value: number) => {
          railOffset = Math.max(0, Math.min(value, count * 12 - marksHeight));
        },
      });
      root.scrollTop = startsAtTop ? 0 : 8315;
      const flushRailFrames = () => {
        marks.dispatchEvent(new Event("scroll"));
        flushFrame();
        flushFrame();
      };
      const resize = (viewport: number, rail: number) => {
        height = viewport;
        marksHeight = rail;
        flushRailFrames();
      };
      flushRailFrames();
      expect(marks.scrollTop).toBe(startsAtTop ? 0 : 677);
      expect(marks.querySelectorAll(".chat-position-rail__marker").length).toBeLessThan(50);
      if (scenario === "hidden") {
        const mounted = [...marks.querySelectorAll(".chat-position-rail__marker")];
        marksHeight = 0;
        railOffset = 0;
        emitTranscriptResize(marks, 44, 0);
        flushFrame();
        renderRail();
        flushFrame();
        expect([...marks.querySelectorAll(".chat-position-rail__marker")]).toEqual(mounted);
        expect(marks.style.getPropertyValue("--chat-position-scroll-top")).toBe("677px");

        // Reader navigation while hidden must be reflected once the rail returns.
        root.scrollTop = 0;
        activeMessage.mockReturnValue("message-0");
        marksHeight = 283;
        emitTranscriptResize(marks, 44, 283);
        flushFrame();
        expect(marker(0).getAttribute("aria-current")).toBe("true");
        expect(marks.style.getPropertyValue("--chat-position-scroll-top")).toBe("0px");
      } else if (scenario === "boot-resize") {
        resize(554, 240);
        // The initial observer result can arrive after the composer claims its space.
        publishVisibility(root.querySelector(".chat-bubble")!);
        resize(543, 229);
        expect(marker(79).hasAttribute("data-visible")).toBe(true);
        const initialOffset = 731;
        expect(marks.scrollTop).toBe(initialOffset);
        resize(512, 198);
        expect(marks.scrollTop).toBe(initialOffset);
      } else if (scenario === "resize-jump") {
        // Initial end navigation can share the frame that reveals the composer.
        height = 554;
        marksHeight = 240;
        root.scrollTop = 8358;
        activeMessage.mockReturnValue("message-79");
        flushRailFrames();
        expect(marker(79).getAttribute("aria-current")).toBe("true");
        expect(Number.parseFloat(marker(79).style.top)).toBeGreaterThanOrEqual(marks.scrollTop);
        expect(Number.parseFloat(marker(79).style.top) + 12).toBeLessThanOrEqual(
          marks.scrollTop + marks.clientHeight,
        );
      } else if (scenario.startsWith("composer-resize-reversal")) {
        publishVisibility(root.querySelector(".chat-bubble")!);
        flushRailFrames();
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
        flushRailFrames();
        expect(marks.scrollTop).toBe(677);
        container.classList.add("chat");
        const textarea = container.appendChild(document.createElement("textarea"));
        textarea.value = "/goal";
        measure(textarea, {
          clientHeight: 32,
          scrollHeight: () => {
            // Measuring the replacement draft commits the expanded transcript.
            height = 597;
            marksHeight = 283;
            return 32;
          },
        });
        if (navigatesBeforeResize) {
          root.scrollTop = 0;
          activeMessage.mockReturnValue("message-0");
        }
        adjustTextareaHeight(textarea, { getTranscriptElement: () => root });
        expect(root.scrollTop).toBe(navigatesBeforeResize ? 0 : 8315);
        // The goal header regrows the composer before any observer or frame runs.
        height = 576;
        marksHeight = 262;
        if (scenario === "composer-resize-reversal-current") {
          activeMessage.mockReturnValue("message-76");
        }
        publishVisibility(root.querySelector(".chat-bubble")!);
        flushRailFrames();
        if (navigatesBeforeResize) {
          expect(marks.scrollTop).toBe(0);
          return;
        }
        expect(marks.scrollTop).toBe(677);
        root.scrollTop = scrollHeight - height;
        flushRailFrames();
        expect(marks.scrollTop).toBe(677);
      } else if (scenario === "resize") {
        height = 554;
        marksHeight = 240;
        activeMessage.mockReturnValue("message-76");
        flushRailFrames();
        expect(marks.scrollTop).toBe(677);
        root.scrollTop = 8319;
        flushRailFrames();
        expect(marks.scrollTop).toBe(677);
        // A second resize retargets the same smooth compensation, including its last 6px.
        resize(512, 198);
        for (const offset of [8323, 8394, 8400]) {
          root.scrollTop = offset;
          flushRailFrames();
          expect(marks.scrollTop).toBe(677);
        }
        publishTranscriptScroll(root, {
          type: "input",
          event: new WheelEvent("wheel", { deltaY: -200 }),
          touching: false,
        });
        root.scrollTop = 8000;
        activeMessage.mockReturnValue("message-40");
        flushRailFrames();
        expect(marks.scrollTop).toBeLessThan(677);
      } else if (scenario === "focus-resize") {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        marker(79).focus();
        expect(marker(79).matches(":focus-visible")).toBe(true);
        resize(554, 240);
        expect(document.activeElement).toBe(marker(79));
        expect(marks.scrollTop).toBe(720);
      } else if (scenario === "pointer") {
        marker(60).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        marker(60).focus();
        expect(marker(60).matches(":focus-visible")).toBe(false);
        expect(marks.scrollTop).toBe(677);
        activeMessage.mockReturnValue("message-0");
        flushRailFrames();
        expect(document.activeElement).toBe(marker(60));
        expect(marks.scrollTop).toBe(0);
      }
    },
  );

  it("resolves distant reader positions before scroll notification and counts the header once", async () => {
    transcriptDomState.measuredRowHeight = 120;
    const rows = contentRows(40, "row-", "");
    const { container, transcript, session, renderRows } = await mountTestTranscript(
      "rail-offset",
      rows,
    );
    try {
      measure(container, { clientHeight: 600, scrollHeight: 4880 });
      container.style.paddingTop = "80px";
      emitTranscriptResize(container, 800, 600);
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
      measure(container, { clientHeight: 300 });
      expect(session.activeMessageId(ids)).toBe("row-25");
      container.scrollTop = 4580;
      expect(session.activeMessageId(ids)).toBe("row-39");
      expect(session.activeMessageId(["missing"])).toBeNull();
    } finally {
      transcript.dispose();
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
    const { transcript, container, view, rerender, markers, preview, query } = threadFixture(props);
    rerender();
    transcript.start();
    expect(markers()).toHaveLength(40);
    // Rail wheel input belongs to its scrollport, never transcript history.
    for (const type of ["wheel", "touchstart", "touchmove"]) {
      part(container, "marks")!.dispatchEvent(new Event(type, { bubbles: true }));
    }
    for (const key of ["PageUp", "PageDown"]) {
      expect(
        markers()[0]!.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        ),
      ).toBe(true);
    }
    expect(historyIntent).not.toHaveBeenCalled();
    query(".chat-thread")!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
    expect(historyIntent).toHaveBeenCalledOnce();
    query(".chat-thread")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }),
    );
    expect(historyIntent).toHaveBeenCalledTimes(2);
    expect(preview()).toBeUndefined();
    markers()[4]!.focus();
    flush();
    expect(preview()).toContain("Checkpoint 4");
    markers()[2]!.dispatchEvent(new Event("pointerenter"));
    flush();
    expect(preview()).toContain("Checkpoint 2");
    query(".chat-position-rail")!.dispatchEvent(new Event("pointerleave"));
    flush();
    expect(preview()).toContain("Checkpoint 4");
    pressKey(markers()[4]!, "ArrowDown");
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
    pressKey(focused!, "Escape");
    expect(preview()).toBeUndefined();
    const thread = query(".chat-thread")!;
    expect(document.activeElement).toBe(thread);
    markers()[2]!.dispatchEvent(new Event("pointerenter"));
    flush();
    expect(preview()).toContain("Checkpoint 2");
    const hoverEscape = pressKey(window, "Escape", false);
    expect(hoverEscape.defaultPrevented).toBe(true);
    expect(preview()).toBeUndefined();
    expect(document.activeElement).toBe(thread);
    markers()[0]!.focus();
    flush();
    expect(preview()).toBeDefined();
    view.render(null);
    await Promise.resolve();
    const escapeAfterRemoval = pressKey(document, "Escape");
    expect(escapeAfterRemoval.defaultPrevented).toBe(false);
    rerender();
    expect(preview()).toBeUndefined();
    props.sessionKey = "agent:main:second";
    rerender();
    expect(preview()).toBeUndefined();
    const state = getTranscriptState(props.paneId);
    state.search.toggle();
    state.search.setQuery("Checkpoint 5");
    rerender();
    expect(markers()).toHaveLength(1);
    state.search.setQuery("not present");
    rerender();
    expect(markers()).toHaveLength(0);
  });

  it.each([
    { role: "user", senderName: "Alice Example", label: "Alice Example" },
    { role: "assistant", senderName: "Alice Example", label: "Molty" },
  ])(
    "renders safe Markdown and attribution in $role previews ($label)",
    ({ role, senderName, label }) => {
      const messages = [
        message("formatted", role, "**Important**\n<script>alert(1)</script>", 1),
        message("next", role === "user" ? "assistant" : "user", "Next turn", 2),
      ];
      Object.assign(messages[0]!["__openclaw"], { senderName });
      const props = threadProps("rail-markdown", "agent:main:markdown", messages);
      props.userName = "Local Viewer";
      if (role === "assistant") {
        props.assistantAvatar = "🦞";
      }
      const { transcript, container, rerender, markers, query } = threadFixture(props);
      rerender();
      transcript.start();
      markers()[0]!.focus();
      flush();
      const preview = part(container, "preview-copy")!;
      expect(part(container, "preview-label")?.textContent).toBe(label);
      const avatar = () => query(".chat-position-rail__preview .chat-author-avatar");
      expect(avatar()?.getAttribute("aria-label") ?? null).toBe(
        role === "user" ? (senderName ?? null) : "Molty",
      );
      if (role === "assistant") {
        expect(avatar()?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
          "🦞",
        );
        expect(markers()[0]?.getAttribute("aria-label")).toContain("Molty");
        props.assistantName = "Roboclaw";
        rerender();
        expect(part(container, "preview-label")?.textContent).toBe("Roboclaw");
        expect(avatar()?.getAttribute("aria-label")).toBe("Roboclaw");
      }
      expect(preview.querySelector("strong")?.textContent).toBe("Important");
      expect(preview.querySelector("script")).toBeNull();
      expect(preview.closest("[inert]")).not.toBeNull();
    },
  );

  it("keeps the focused run marker through streaming and retargets its persisted answer", async () => {
    const observed = observeBubbles();

    const user = message("question", "user", "Review the card", 1, "stream-run");
    const props = threadProps("rail-stream-handoff", "agent:main:main", [user]);
    Object.assign(props, {
      runId: "stream-run",
      runActive: true,
      runWorking: true,
      stream: "<thinking>Private planning</thinking>",
      streamStartedAt: 2_000,
    });
    const { transcript, container, rerender, markers, query, preview } = threadFixture(props);
    const marker = () => markerAt(container, "run:stream-run");
    rerender();
    transcript.start();
    expect(markers()).toHaveLength(1);
    props.stream = "Draft response";
    rerender();
    const provisional = marker();
    provisional.focus();
    flush();
    expect(preview()).toContain("Draft response");
    const streamBubble = [...container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
      (bubble) => bubble.textContent?.includes("Draft response"),
    )!;
    const root = query(".chat-thread")!;
    const marks = part(container, "marks")!;
    measure(marks, { clientHeight: 600 });
    emitTranscriptResize(marks, 44, 600);
    await settleFrames();
    expect(observed.has(streamBubble)).toBe(true);
    const queryBubbles = vi.spyOn(root, "querySelectorAll");
    props.stream = "Draft **updated** response";
    rerender();
    await settleFrames();
    expect(streamBubble.querySelector("strong")?.textContent).toBe("updated");
    expect(provisional.getAttribute("aria-description")).toContain("Draft updated response");
    expect(
      queryBubbles.mock.calls.filter(([selector]) => selector.includes(".chat-bubble")),
    ).toEqual([]);
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
    expect(preview()).toContain("Final response");
    const persistedBubble = query('[data-entry-id="persisted-answer"]')!;
    await settleFrames();
    expect(observed.has(streamBubble)).toBe(false);
    expect(observed.has(persistedBubble)).toBe(true);
    marker().click();
    await settleFrames();
    expect(persistedBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
    expect(markers()).toHaveLength(2);
  });
});
