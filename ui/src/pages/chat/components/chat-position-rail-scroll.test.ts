/* @vitest-environment jsdom */

import { html, LitElement, nothing } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { message, stubRailVisibility } from "./chat-position-rail.test-support.ts";
import { renderChatPositionRail } from "./chat-position-rail.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
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

class RailScrollTestHost extends LitElement {
  readonly transcriptRoot = document.createElement("div");
  renderTranscript: () => unknown = () => nothing;

  protected override createRenderRoot() {
    this.append(this.transcriptRoot);
    return this.transcriptRoot;
  }

  protected override render() {
    return this.renderTranscript();
  }
}

customElements.define("rail-scroll-test-host", RailScrollTestHost);

describe("conversation position rail scroll rendering", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("updates rail position without pane renders until a rendered scroll fact changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const flushFrame = stubAnimationFrames();
    stubRailVisibility();
    transcriptDomState.measuredRowHeight = 120;
    const host = new RailScrollTestHost();
    const container = host.transcriptRoot;
    const performUpdate = vi.spyOn(host, "performUpdate");
    const requestUpdate = () => host.requestUpdate();
    const transcript = new ChatTranscriptController(host, () => "rail-notification", {
      canFollowEnd: () => false,
    });
    const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "content",
      key: `row-${index}`,
      content: html`<div class="chat-bubble" data-entry-id=${`row-${index}`}>${index}</div>`,
    }));
    const ids = rows.map((row) => row.key);
    const positions = {
      markers: ids.map((id, index) => ({
        id,
        anchorId: id,
        role: "user" as const,
        message: message(id, "user", `Checkpoint ${index}`, index + 1),
      })),
      markerIdsByMessageId: new Map(ids.map((id) => [id, id])),
    };
    container.className = "chat-thread";
    const readHeight = vi.fn(() => 600);
    const readContentHeight = vi.fn(() => 4800);
    const readOffset = vi.spyOn(container, "scrollTop", "get");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, get: readHeight },
      scrollHeight: { configurable: true, get: readContentHeight },
    });
    const transcriptView = () =>
      transcript.renderSession("agent:main:rail-notification", (session) => {
        session.syncMessageRows(
          new Map(ids.map((id) => [id, id])),
          new Map(ids.map((id) => [id, id])),
        );
        return session.render(
          rows,
          (row) => (row.kind === "content" ? row.content : nothing),
          null,
          false,
          renderChatPositionRail({ positions, transcript: session, requestUpdate }),
        );
      });
    host.renderTranscript = transcriptView;
    const settleUpdates = async () => {
      while (host.isUpdatePending) {
        await host.updateComplete;
      }
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
      flushFrame();
      await settleUpdates();
      flushFrame();
      await settleUpdates();
      expect(current()?.dataset.positionMarkerId).toBe("row-2");
      expect(tabStops()).toEqual([current()]);
      // A prior sibling commit can leave layout dirty in this checkpoint.
      // Recording the render's scroll facts must consume already observed geometry.
      readHeight.mockClear();
      readContentHeight.mockClear();
      readOffset.mockClear();
      transcriptView();
      expect(readHeight).not.toHaveBeenCalled();
      expect(readContentHeight).not.toHaveBeenCalled();
      expect(readOffset).not.toHaveBeenCalled();
      performUpdate.mockClear();

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
      rows[0]!.content = html`<div class="chat-bubble" data-entry-id="row-0">Updated content</div>`;
      host.requestUpdate();
      await settleUpdates();
      clearRailReads();
      flushFrame();
      await settleUpdates();
      expectNoRailFrameReads();
      performUpdate.mockClear();

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
      flushFrame();
      await settleUpdates();
      expectNoRailFrameReads();
      expect(performUpdate).not.toHaveBeenCalled();
      expect(current()?.dataset.positionMarkerId).toBe("row-2");
      expect(tabStops()).toEqual([current()]);

      // Both viewports span rows 0–5. With no new intersections or pane render,
      // the rail must still publish its midpoint crossing and keyboard entry.
      scrollTo(70);
      expect(offsets).toEqual([5, 15]);
      flushFrame();
      await settleUpdates();
      expect(performUpdate).not.toHaveBeenCalled();
      expect(current()?.dataset.positionMarkerId).toBe("row-3");
      expect(tabStops()).toEqual([current()]);

      container.dispatchEvent(new WheelEvent("wheel", { deltaY: 600 }));
      await settleUpdates();
      performUpdate.mockClear();
      container.dispatchEvent(new Event("scrollend"));
      await settleUpdates();
      expect(performUpdate).not.toHaveBeenCalled();

      // Stay within the final virtual range and the 8px follow threshold;
      // crossing the precise 1px end boundary still needs an owner commit.
      scrollTo(4198.5);
      await settleUpdates();
      flushFrame();
      await settleUpdates();
      flushFrame();
      await settleUpdates();
      performUpdate.mockClear();
      scrollTo(4199.5);
      await settleUpdates();
      expect(performUpdate).toHaveBeenCalledTimes(1);
      flushFrame();
      await settleUpdates();
      flushFrame();
      await settleUpdates();
      performUpdate.mockClear();
      scrollTo(4199.75);
      flushFrame();
      await settleUpdates();
      expect(performUpdate).not.toHaveBeenCalled();

      // The physical end crosses row 35's boundary, so its new virtual range
      // must commit even though the precise end fact is already rendered.
      expect(container.querySelector<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey).toBe(
        "row-28",
      );
      scrollTo(4200);
      await settleUpdates();
      flushFrame();
      await settleUpdates();
      expect(performUpdate).toHaveBeenCalledTimes(1);
      expect(container.querySelector<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey).toBe(
        "row-29",
      );
      expect(container.querySelector<HTMLElement>(".chat-virtual-block")?.style.transform).toBe(
        "translateY(3480px)",
      );
      expect(current()?.dataset.positionMarkerId).toBe("row-39");
      expect(tabStops()).toEqual([current()]);

      host.remove();
      performUpdate.mockClear();
      scrollTo(70);
      await settleUpdates();
      expect(performUpdate).not.toHaveBeenCalled();
    } finally {
      stop();
      host.remove();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
