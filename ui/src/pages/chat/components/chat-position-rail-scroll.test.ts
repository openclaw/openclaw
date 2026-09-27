/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { message, stubRailVisibility } from "./chat-position-rail.test-support.ts";
import { renderChatPositionRail } from "./chat-position-rail.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
  transcriptDomState,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

describe("conversation position rail scroll rendering", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("updates rail position without pane renders until a rendered scroll fact changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const flushFrame = stubAnimationFrames();
    stubRailVisibility();
    transcriptDomState.measuredRowHeight = 120;
    const requestUpdate = vi.fn();
    const transcript = new ChatTranscriptController(
      {
        addController: () => undefined,
        removeController: () => undefined,
        requestUpdate,
        updateComplete: Promise.resolve(true),
      },
      () => "rail-notification",
      { canFollowEnd: () => false },
    );
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
    const container = document.body.appendChild(document.createElement("div"));
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
    const renderRows = () => {
      render(transcriptView(), container);
      transcript.hostUpdated();
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
      transcript.hostConnected();
      renderRows();
      await Promise.resolve();
      const marks = container.querySelector<HTMLElement>(".chat-position-rail__marks")!;
      Object.defineProperty(marks, "clientHeight", { configurable: true, value: 240 });
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 600);
      }
      scrollTo(50);
      renderRows();
      flushFrame();
      flushFrame();
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
      requestUpdate.mockClear();

      offsets.length = 0;
      scrollTo(55);
      expect(offsets).toEqual([5]);
      flushFrame();
      expect(requestUpdate).not.toHaveBeenCalled();
      expect(current()?.dataset.positionMarkerId).toBe("row-2");
      expect(tabStops()).toEqual([current()]);

      // Both viewports span rows 0–5. With no new intersections or pane render,
      // the rail must still publish its midpoint crossing and keyboard entry.
      scrollTo(70);
      expect(offsets).toEqual([5, 15]);
      flushFrame();
      expect(requestUpdate).not.toHaveBeenCalled();
      expect(current()?.dataset.positionMarkerId).toBe("row-3");
      expect(tabStops()).toEqual([current()]);

      container.dispatchEvent(new WheelEvent("wheel", { deltaY: 600 }));
      requestUpdate.mockClear();
      container.dispatchEvent(new Event("scrollend"));
      expect(requestUpdate).not.toHaveBeenCalled();

      // Stay within the final virtual range and the 8px follow threshold;
      // crossing the precise 1px end boundary still needs an owner commit.
      scrollTo(4198.5);
      renderRows();
      flushFrame();
      flushFrame();
      requestUpdate.mockClear();
      scrollTo(4199.5);
      expect(requestUpdate).toHaveBeenCalled();
      renderRows();
      flushFrame();
      flushFrame();
      requestUpdate.mockClear();
      scrollTo(4200);
      flushFrame();
      expect(requestUpdate).not.toHaveBeenCalled();
      expect(current()?.dataset.positionMarkerId).toBe("row-39");
      expect(tabStops()).toEqual([current()]);

      transcript.hostDisconnected();
      requestUpdate.mockClear();
      scrollTo(70);
      expect(requestUpdate).not.toHaveBeenCalled();
    } finally {
      stop();
      render(nothing, container);
      transcript.hostDisconnected();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
