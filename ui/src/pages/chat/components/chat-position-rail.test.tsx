/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { ChatPositionRail } from "./chat-position-rail-solid.tsx";
import { message, stubRailVisibility } from "./chat-position-rail.test-support.ts";
import { getTranscriptState, type ChatThreadProps } from "./chat-thread-interactions.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import type { ChatTranscript } from "./chat-transcript-controller.ts";
import { publishTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
  threadProps,
  transcriptDomState,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

function mountThread(container: HTMLElement, transcript: ChatTranscript) {
  const [props, setProps] = createSignal<ChatThreadProps | null>(null);
  const view = mountSolid(
    () => (
      <Show when={props()}>
        {(current) => <ChatThread props={current()} transcript={transcript} />}
      </Show>
    ),
    { container },
  );
  return {
    unmount: view.unmount,
    render(next: ChatThreadProps | null) {
      setProps(next ? { ...next } : null);
      flush();
    },
  };
}

const transcripts: ChatTranscript[] = [];
function fixture(props?: ChatThreadProps) {
  const transcript = createTestTranscript();
  transcripts.push(transcript);
  const container = document.body.appendChild(document.createElement("div"));
  const view = props ? mountThread(container, transcript) : undefined;
  const render = () => {
    view!.render(props!);
    transcript.update();
  };
  function find<T extends Element = Element>(selector: string) {
    return container.querySelector<T>(selector);
  }
  return { transcript, container, view, render, find };
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

const keyEvent = (key: string) =>
  new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
const settleFrames = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
function sizeRail(marks: HTMLElement, height: number) {
  Object.defineProperty(marks, "clientHeight", { configurable: true, value: height });
  for (const observer of resizeObservers) {
    observer.emitTarget(marks, 44, height);
  }
}

type Positions = Parameters<typeof ChatPositionRail>[0]["positions"];
function positionsFor(count: number): Positions {
  const markers = Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    anchorId: `message-${index}`,
    role: "user" as const,
    message: message(`message-${index}`, "user", `Checkpoint ${index}`, index + 1),
  }));
  return { markers, markerIdsByMessageId: new Map(markers.map(({ id }) => [id, id])) };
}
function mountRail(
  key: string,
  positions: () => Positions,
  activeMessage?: () => string,
  bubbleId = "message-79",
) {
  const { transcript, container, find } = fixture();
  mountSolid(
    () =>
      transcript.renderSession(key, (session) => {
        if (activeMessage) {
          vi.spyOn(session, "activeMessageId").mockImplementation(activeMessage);
        }
        return (
          <div class="chat-thread" tabindex="0">
            <div
              ref={session.messageElements.forKey(bubbleId)}
              class="chat-bubble"
              data-entry-id={bubbleId}
            >
              {bubbleId === "short" ? "A short question" : "Latest message"}
            </div>
            <ChatPositionRail positions={positions()} transcript={session} />
          </div>
        );
      }),
    { container },
  );
  return {
    container,
    find,
    root: container.querySelector<HTMLElement>(".chat-thread")!,
    marks: container.querySelector<HTMLElement>(".chat-position-rail__marks")!,
  };
}
const previewText = (container: ParentNode) =>
  container.querySelector(".chat-position-rail__preview-copy")?.textContent;

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  cleanupSolid();
  for (const transcript of transcripts.splice(0)) {
    transcript.dispose();
  }
  resetTranscriptTestDom();
});

it.each(["mounted", "off-window", "focused"] as const)(
  "publishes current position and keyboard entry together for a %s observer target",
  (scenario) => {
    const flushFrame = stubAnimationFrames();
    const publishVisibility = stubRailVisibility();
    const activeMessage = vi.fn(() => "message-79");
    const positions = positionsFor(80);
    const { root, marks } = mountRail(
      "agent:main:rail-publication",
      () => positions,
      activeMessage,
    );
    sizeRail(marks, 240);
    const marker = (id: string) =>
      marks.querySelector<HTMLButtonElement>(`[data-position-marker-id="${id}"]`);
    const current = () => marks.querySelector<HTMLButtonElement>('[aria-current="true"]');
    const tabStops = () => [...marks.querySelectorAll<HTMLButtonElement>('[tabindex="0"]')];

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
    if (scenario === "off-window") {
      tabStops()[0]!.focus();
      for (const [key, index] of [
        ["End", 79],
        ["Home", 0],
      ] as const) {
        const focusedMarker = document.activeElement;
        assert(focusedMarker instanceof HTMLButtonElement);
        focusedMarker.dispatchEvent(keyEvent(key));
        expect(document.activeElement).toBe(marker(`message-${index}`));
        expect(tabStops()).toEqual([document.activeElement]);
      }
    }
  },
);

it("reveals only overflowing transcripts and retires focus when they fit again", () => {
  const flushFrame = stubAnimationFrames();
  stubRailVisibility();
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
  const { root, marks } = mountRail(
    "agent:main:rail-overflow",
    () => positions,
    undefined,
    "short",
  );
  const rail = root.querySelector<HTMLElement>(".chat-position-rail")!;
  Object.defineProperties(root, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 600 },
  });
  sizeRail(marks, 12);
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

it.each(railUpdateScenarios)("keeps the reader's rail position through %s updates", (scenario) => {
  const navigatesBeforeResize = scenario === "composer-resize-reversal-navigation";
  const flushFrame = stubAnimationFrames();
  const publishVisibility = stubRailVisibility();
  const count = 80;
  const startsAtTop = scenario === "resize-jump";
  const activeMessage = vi.fn((): string =>
    scenario === "resize-jump" ? "message-0" : "message-79",
  );
  const positions = positionsFor(count);
  const [currentPositions, setPositions] = createSignal(positions);
  const { container, root, marks } = mountRail(
    "agent:main:rail-scroll-policy",
    () => currentPositions(),
    activeMessage,
  );
  const renderRail = () => {
    setPositions({ ...positions });
    flush();
  };
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
  const resizeTo = (nextHeight: number, nextMarksHeight: number) => {
    height = nextHeight;
    marksHeight = nextMarksHeight;
  };
  const flushRailFrames = () => {
    marks.dispatchEvent(new Event("scroll"));
    flushFrame();
    flushFrame();
  };

  flushRailFrames();
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
    resizeTo(554, 240);
    flushRailFrames();
    // The initial observer result can arrive after the composer claims its space.
    publishVisibility(root.querySelector(".chat-bubble")!);
    resizeTo(543, 229);
    flushRailFrames();
    expect(marker(79).hasAttribute("data-visible")).toBe(true);
    const initialOffset = 731;
    expect(marks.scrollTop).toBe(initialOffset);
    resizeTo(512, 198);
    flushRailFrames();
    expect(marks.scrollTop).toBe(initialOffset);
  } else if (scenario === "resize-jump") {
    // Initial end navigation can share the frame that reveals the composer.
    resizeTo(554, 240);
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
    resizeTo(512, 198);
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
    Object.defineProperties(textarea, {
      clientHeight: { configurable: true, value: 32 },
      scrollHeight: {
        configurable: true,
        get: () => {
          // Measuring the replacement draft commits the expanded transcript.
          resizeTo(597, 283);
          return 32;
        },
      },
    });
    if (navigatesBeforeResize) {
      root.scrollTop = 0;
      activeMessage.mockReturnValue("message-0");
    }
    adjustTextareaHeight(textarea, { getTranscriptElement: () => root });
    expect(root.scrollTop).toBe(navigatesBeforeResize ? 0 : 8315);
    // The goal header regrows the composer before any observer or frame runs.
    resizeTo(576, 262);
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
    resizeTo(554, 240);
    activeMessage.mockReturnValue("message-76");
    flushRailFrames();
    expect(marks.scrollTop).toBe(677);
    root.scrollTop = 8319;
    flushRailFrames();
    expect(marks.scrollTop).toBe(677);
    // A second resize retargets the same smooth compensation, including its last 6px.
    resizeTo(512, 198);
    flushRailFrames();
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
    resizeTo(554, 240);
    flushRailFrames();
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
    flushRailFrames();
    expect(document.activeElement).toBe(marker(60));
    expect(marks.scrollTop).toBe(0);
  }
});

it("keeps stream edits off target scans while reconciling registered bubble mounts", async () => {
  const observed = observeBubbles();
  const props = {
    ...threadProps("rail-mutations", "agent:main:rail-mutations", [
      message("question", "user", "Earlier question", 1),
      message("answer", "assistant", "Earlier answer", 2),
    ]),
    runActive: true,
    stream: "Live **start**",
    streamStartedAt: 3_000,
  };
  const { transcript, find, render: rerender } = fixture(props);

  rerender();
  transcript.start();
  const root = find<HTMLElement>(".chat-thread");
  const marks = find<HTMLElement>(".chat-position-rail__marks");
  const original = find<HTMLElement>('.chat-bubble[data-entry-id="question"]');
  assert(root && marks && original);
  sizeRail(marks, 600);
  await settleFrames();
  expect(observed.has(original)).toBe(true);
  const query = vi.spyOn(root, "querySelectorAll");
  const targetScans = () =>
    query.mock.calls.filter(([selector]) => selector === ".chat-bubble[data-entry-id]").length;

  const expectObserved = async (element: Element, present: boolean) => {
    await settleFrames();
    expect(targetScans()).toBe(0);
    expect(observed.has(element)).toBe(present);
  };

  for (const word of ["one", "two", "three"]) {
    props.stream = `Live **${word}**`;
    rerender();
    await settleFrames();
    expect(find(".chat-bubble strong")?.textContent).toBe(word);
    expect(find('.chat-bubble[data-entry-id="question"]')).toBe(original);
  }
  expect(targetScans()).toBe(0);

  const elements = transcript.renderSession(props.sessionKey, (session) => session.messageElements);
  const entry = [...elements.elements].find(([, element]) => element === original);
  assert(entry);
  const bubbleRef = elements.forKey(entry[0]);
  bubbleRef(original);
  bubbleRef();
  original.remove();
  await expectObserved(original, false);

  const replacement = original.cloneNode(true) as HTMLElement;
  root.append(replacement);
  bubbleRef(replacement);
  await expectObserved(replacement, true);
  bubbleRef();
  replacement.remove();
  await expectObserved(replacement, false);

  const wrapper = document.createElement("section");
  wrapper.append(replacement);
  root.append(wrapper);
  bubbleRef(replacement);
  await expectObserved(replacement, true);
  bubbleRef();
  wrapper.remove();
  await expectObserved(replacement, false);
});

it("resolves distant reader positions before scroll notification and counts the header once", async () => {
  transcriptDomState.measuredRowHeight = 120;
  const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "content",
    key: `row-${index}`,
    content: Object.assign(document.createElement("div"), { textContent: String(index) }),
  }));
  const { container, transcript, session, renderRows } = await mountTestTranscript(
    "rail-offset",
    rows,
  );
  transcripts.push(transcript);

  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 4880 },
  });
  container.style.paddingTop = "80px";
  for (const observer of resizeObservers) {
    observer.emitTarget(container, 800, 600);
  }
  const ids = rows.map((row) => row.key);
  session.syncMessageRows(new Map(ids.map((id) => [id, id])), new Map(ids.map((id) => [id, id])));
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
});

it("keeps focused previews after pointer exit and resets interaction when the session changes", async () => {
  const messages = Array.from({ length: 40 }, (_, index) =>
    message(`message-${index}`, index % 2 ? "assistant" : "user", `Checkpoint ${index}`, index + 1),
  );
  const props = threadProps("rail-interaction", "agent:main:first", messages);
  const historyIntent = vi.fn();
  props.onHistoryIntent = historyIntent;
  const { transcript, container, view, find, render: rerender } = fixture(props);
  const markers = () => [
    ...container.querySelectorAll<HTMLButtonElement>(".chat-position-rail__marker"),
  ];
  const preview = () => previewText(container);

  rerender();
  transcript.start();
  expect(markers()).toHaveLength(40);
  // Rail wheel input belongs to its scrollport, never transcript history.
  for (const type of ["wheel", "touchstart", "touchmove"]) {
    container
      .querySelector(".chat-position-rail__marks")!
      .dispatchEvent(new Event(type, { bubbles: true }));
  }
  for (const key of ["PageUp", "PageDown"]) {
    expect(markers()[0]!.dispatchEvent(keyEvent(key))).toBe(true);
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
  find(".chat-position-rail")!.dispatchEvent(new Event("pointerleave"));
  expect(preview()).toContain("Checkpoint 4");
  markers()[4]!.dispatchEvent(keyEvent("ArrowDown"));
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
  focused!.dispatchEvent(keyEvent("Escape"));
  expect(preview()).toBeUndefined();
  const thread = find<HTMLElement>(".chat-thread")!;
  expect(document.activeElement).toBe(thread);
  markers()[2]!.dispatchEvent(new Event("pointerenter"));
  expect(preview()).toContain("Checkpoint 2");
  const hoverEscape = new KeyboardEvent("keydown", {
    key: "Escape",
    cancelable: true,
  });
  window.dispatchEvent(hoverEscape);
  expect(hoverEscape.defaultPrevented).toBe(true);
  expect(preview()).toBeUndefined();
  expect(document.activeElement).toBe(thread);
  markers()[0]!.focus();
  expect(preview()).toBeDefined();
  view!.render(null);
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
    const { transcript, container, find, render: rerender } = fixture(props);

    rerender();
    transcript.start();
    find<HTMLButtonElement>(".chat-position-rail__marker")!.focus();
    const preview = find(".chat-position-rail__preview-copy")!;
    expect(find(".chat-position-rail__preview-label")?.textContent).toBe(label);
    const avatar = find(".chat-position-rail__preview .chat-author-avatar");
    expect(avatar?.getAttribute("aria-label") ?? null).toBe(
      role === "user" ? (senderName ?? null) : "Molty",
    );
    if (role === "assistant") {
      expect(avatar?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
        "🦞",
      );
      expect(find(".chat-position-rail__marker")?.getAttribute("aria-label")).toContain("Molty");
      props.assistantName = "Roboclaw";
      rerender();
      expect(find(".chat-position-rail__preview-label")?.textContent).toBe("Roboclaw");
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
  },
);

it("indexes three assistant messages as one run when history starts mid-run", () => {
  // A paginated history window can omit the user boundary of an existing run.
  const partial = (id: string, role: string, content: unknown, seq: number) =>
    message(id, role, content, seq, "run-partial");
  const tool = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
  const result = (id: string, text: string, seq: number, toolCallId: string, toolName: string) => ({
    ...partial(id, "toolResult", text, seq),
    toolCallId,
    toolName,
  });
  const messages = [
    partial("first", "assistant", "Checking the existing style", 1),
    partial("call-1", "assistant", [tool("read-1", "read")], 2),
    result("result-1", "Styles loaded", 3, "read-1", "read"),
    partial("second", "assistant", "Rendering the launch card", 4),
    partial("call-2", "assistant", [tool("render-1", "exec")], 5),
    result("result-2", "Asset rendered", 6, "render-1", "exec"),
    partial("final", "assistant", "The launch card is ready", 7),
    partial("thinking", "assistant", "<thinking>Private planning</thinking>", 8),
  ];
  const props = {
    ...threadProps("rail-partial-run", "agent:main:main", messages),
    showToolCalls: true,
  };
  const { transcript, container, render: renderCurrent } = fixture(props);

  renderCurrent();
  transcript.start();
  const markers = container.querySelectorAll<HTMLButtonElement>(".chat-position-rail__marker");
  expect(markers).toHaveLength(1);
  markers[0]!.focus();
  expect(previewText(container)).toContain("The launch card is ready");
  expect(previewText(container)).not.toContain("Styles loaded");
});

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
  const { transcript, container, find, render: rerender } = fixture(props);
  const marker = () => find<HTMLButtonElement>('[data-position-marker-id="run:stream-run"]')!;

  rerender();
  transcript.start();
  expect(container.querySelectorAll(".chat-position-rail__marker")).toHaveLength(1);
  props.stream = "Draft response";
  rerender();
  const provisional = marker();
  provisional.focus();
  expect(previewText(container)).toContain("Draft response");
  const streamBubble = [...container.querySelectorAll<HTMLElement>(".chat-bubble")].find((bubble) =>
    bubble.textContent?.includes("Draft response"),
  )!;
  const root = find<HTMLElement>(".chat-thread")!;
  const marks = find<HTMLElement>(".chat-position-rail__marks")!;
  sizeRail(marks, 600);
  await settleFrames();
  expect(observed.has(streamBubble)).toBe(true);
  const query = vi.spyOn(root, "querySelectorAll");
  props.stream = "Draft **updated** response";
  rerender();
  await settleFrames();
  expect(streamBubble.querySelector("strong")?.textContent).toBe("updated");
  expect(query.mock.calls.filter(([selector]) => selector.includes(".chat-bubble"))).toEqual([]);
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
  expect(previewText(container)).toContain("Final response");
  const persistedBubble = find<HTMLElement>('[data-entry-id="persisted-answer"]')!;
  await settleFrames();
  expect(observed.has(streamBubble)).toBe(false);
  expect(observed.has(persistedBubble)).toBe(true);
  marker().click();
  await settleFrames();
  expect(persistedBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
  expect(container.querySelectorAll(".chat-position-rail__marker")).toHaveLength(2);
});
