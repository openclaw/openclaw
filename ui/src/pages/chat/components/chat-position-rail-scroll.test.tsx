/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { TranscriptTestHost } from "../test-helpers/chat-transcript-native.tsx";
import { ChatPositionRail } from "./chat-position-rail-solid.tsx";
import { message, stubRailVisibility } from "./chat-position-rail.test-support.ts";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import {
  publishTranscriptScroll,
  subscribeTranscriptScroll,
} from "./chat-transcript-scroll-events.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
  transcriptDomState,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

class RailScrollTestHost extends TranscriptTestHost {
  override readonly transcript = createChatTranscript(() => "rail-notification", {
    canFollowEnd: () => false,
  });
}

customElements.define("rail-scroll-test-host", RailScrollTestHost);

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("updates rail and end position without pane renders until the virtual range changes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const flushFrame = stubAnimationFrames();
  stubRailVisibility();
  transcriptDomState.measuredRowHeight = 120;
  const host = new RailScrollTestHost();
  const container = host.transcriptRoot;
  let renderedAt: number;
  const recordViewport = vi.spyOn(TranscriptEndAnchor.prototype, "recordViewport");
  const transcript = host.transcript;
  const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "content",
    key: `row-${index}`,
    content: <div class="chat-bubble" data-entry-id={`row-${index}`} />,
  }));
  const ids = rows.map((row) => row.key);
  const identityMap = () => new Map(ids.map((id) => [id, id]));
  const positions = {
    markers: ids.map((id, index) => ({
      id,
      anchorId: id,
      role: "user" as const,
      message: message(id, "user", `Checkpoint ${index}`, index + 1),
    })),
    markerIdsByMessageId: identityMap(),
  };
  container.className = "chat-thread";
  const readHeight = vi.fn(() => 600);
  const readContentHeight = vi.fn(() => 4800);
  const readOffset = vi.spyOn(container, "scrollTop", "get");
  Object.defineProperties(container, {
    clientHeight: { configurable: true, get: readHeight },
    scrollHeight: { configurable: true, get: readContentHeight },
  });
  const rail = document.createElement("div");
  rail.style.display = "contents";
  transcript.renderSession("agent:main:rail-notification", (session) => {
    mountSolid(() => <ChatPositionRail positions={positions} transcript={session} />, {
      container: rail,
    });
  });
  const transcriptView = () =>
    transcript.renderSession("agent:main:rail-notification", (session) => {
      session.syncMessageRows(identityMap(), identityMap());
      return session.render(
        rows,
        (row) => (row.kind === "content" ? row.content : null),
        null,
        false,
        rail,
      );
    });
  host.renderTranscript = transcriptView;
  const settleUpdates = (frame = false) => {
    if (frame) {
      flushFrame();
    }
    return host.settleUpdates();
  };
  const scrollTo = (offset: number) => {
    container.scrollTop = offset;
    container.dispatchEvent(new Event("scroll"));
  };
  const offsets: number[] = [];
  const stop = subscribeTranscriptScroll(container, (observation) => {
    if (observation.type === "offset") {
      offsets.push(observation.delta);
    }
  });
  const current = () => container.querySelector<HTMLButtonElement>('[aria-current="true"]');
  const tabStops = () => [
    ...container.querySelectorAll<HTMLButtonElement>('.chat-position-rail [tabindex="0"]'),
  ];
  const expectCurrent = (id: string) => {
    expect(current()?.dataset.positionMarkerId).toBe(id);
    expect(tabStops()).toEqual([current()]);
  };
  try {
    document.body.append(host);
    await settleUpdates();
    const marks = container.querySelector<HTMLElement>(".chat-position-rail__marks")!;
    const readRailHeight = vi.fn(() => 240);
    Object.defineProperty(marks, "clientHeight", { configurable: true, get: readRailHeight });
    const readRailOffset = vi.spyOn(marks, "scrollTop", "get");
    const computedStyle = vi.spyOn(window, "getComputedStyle");
    for (const observer of resizeObservers) {
      observer.emitTarget(container, 800, 600);
      observer.emitTarget(marks, 44, 240);
    }
    scrollTo(50);
    await settleUpdates();
    await settleUpdates(true);
    await settleUpdates(true);
    expectCurrent("row-2");
    // Even after a dirty sibling commit, recording must use observed geometry.
    readHeight.mockClear();
    readContentHeight.mockClear();
    readOffset.mockClear();
    transcriptView();
    expect(readHeight).not.toHaveBeenCalled();
    expect(readContentHeight).not.toHaveBeenCalled();
    expect(readOffset).not.toHaveBeenCalled();
    renderedAt = host.committedRenders;
    const clearRailReads = () => {
      readRailHeight.mockClear();
      readRailOffset.mockClear();
      computedStyle.mockClear();
    };
    const expectNoRailFrameReads = () => {
      expect(readRailHeight).not.toHaveBeenCalled();
      expect(readRailOffset).not.toHaveBeenCalled();
      expect(computedStyle.mock.calls.filter(([element]) => element === marks)).toEqual([]);
    };
    // A stream commit can dirty the transcript without changing any markers.
    rows[0]!.content = (
      <div class="chat-bubble" data-entry-id="row-0">
        Updated content
      </div>
    );
    host.requestRender();
    await settleUpdates();
    clearRailReads();
    await settleUpdates(true);
    expectNoRailFrameReads();
    renderedAt = host.committedRenders;

    // Programmatic and resize receipts can follow DOM writes. Their readers
    // must wait for observer delivery rather than moving the forced layout.
    clearRailReads();
    publishTranscriptScroll(container, {
      type: "offset",
      delta: 0,
      scrolling: false,
      touching: false,
      programmatic: true,
    });
    publishTranscriptScroll(container, {
      type: "resize",
      viewport: { clientHeight: 600, scrollHeight: 4800, scrollTop: 50 },
    });
    expectNoRailFrameReads();
    offsets.length = 0;
    scrollTo(55);
    expect(offsets).toEqual([5]);
    clearRailReads();
    await settleUpdates(true);
    expectNoRailFrameReads();
    expect(host.committedRenders).toBe(renderedAt);
    expectCurrent("row-2");

    // Both viewports span rows 0–5. With no new intersections or pane render,
    // the rail must still publish its midpoint crossing and keyboard entry.
    scrollTo(70);
    expect(offsets).toEqual([5, 15]);
    await settleUpdates(true);
    expect(host.committedRenders).toBe(renderedAt);
    expectCurrent("row-3");
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 600 }));
    await settleUpdates();
    renderedAt = host.committedRenders;
    container.dispatchEvent(new Event("scrollend"));
    await settleUpdates();
    expect(host.committedRenders).toBe(renderedAt);

    // The precise end edge is recorded without committing the unchanged virtual range.
    scrollTo(4198.5);
    await settleUpdates();
    await settleUpdates(true);
    await settleUpdates(true);
    expect(recordViewport.mock.results.at(-1)?.value).toBe(false);
    renderedAt = host.committedRenders;
    scrollTo(4199.5);
    await settleUpdates();
    expect(recordViewport.mock.results.at(-1)?.value).toBe(true);
    expect(host.committedRenders).toBe(renderedAt);
    await settleUpdates(true);
    expectCurrent("row-39");
    await settleUpdates(true);
    renderedAt = host.committedRenders;
    scrollTo(4199.75);
    await settleUpdates(true);
    expect(host.committedRenders).toBe(renderedAt);

    // The physical end crosses row 35's boundary, so its new virtual range
    // must commit even though the precise end fact is already recorded.
    const firstRowBefore =
      container.querySelector<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey;
    scrollTo(4200);
    await settleUpdates();
    await settleUpdates(true);
    expect(host.committedRenders).toBe(renderedAt + 1);
    expect(
      container.querySelector<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey,
    ).not.toBe(firstRowBefore);
    expect(container.querySelector('[data-virtual-row-key="row-35"]')).not.toBeNull();
    expectCurrent("row-39");
    host.remove();
    renderedAt = host.committedRenders;
    scrollTo(70);
    await settleUpdates();
    expect(host.committedRenders).toBe(renderedAt);
  } finally {
    stop();
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
