/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { TranscriptTestHost } from "../test-helpers/chat-transcript-native.tsx";
import { ChatPositionRail } from "./chat-position-rail-solid.tsx";
import { message, stubRailVisibility } from "./chat-position-rail.test-support.ts";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { emitTranscriptResize } from "./chat-transcript-fixture.test-support.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
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

it("follows native midpoint crossings and the final virtual range", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const flushFrame = stubAnimationFrames();
  stubRailVisibility();
  transcriptDomState.measuredRowHeight = 120;
  const host = new RailScrollTestHost();
  const container = host.transcriptRoot;
  const recordViewport = vi.spyOn(TranscriptEndAnchor.prototype, "recordViewport");
  const transcript = host.transcript;
  const sessionKey = "agent:main:rail-notification";
  const messageElements = transcript.renderSession(
    sessionKey,
    (session) => session.messageElements,
  );
  const ids = Array.from({ length: 40 }, (_, index) => `row-${index}`);
  const rows: TestContentRow[] = ids.map((id) => ({
    kind: "content",
    key: id,
    content: <div ref={messageElements.forKey(id)} class="chat-bubble" data-entry-id={id} />,
  }));
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
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 4800 },
  });
  const rail = document.createElement("div");
  rail.style.display = "contents";
  transcript.renderSession(sessionKey, (session) => {
    mountSolid(() => <ChatPositionRail positions={positions} transcript={session} />, {
      container: rail,
    });
  });
  host.renderTranscript = () =>
    transcript.renderSession(sessionKey, (session) => {
      session.syncMessageRows(identityMap(), identityMap());
      return session.render(
        rows,
        (row) => (row.kind === "content" ? row.content : null),
        null,
        false,
        rail,
      );
    });
  const settle = async (frame = false) => {
    if (frame) {
      flushFrame();
    }
    await host.settleUpdates();
  };
  const expectCurrent = (id: string) => {
    const current = container.querySelector<HTMLButtonElement>('[aria-current="true"]');
    expect(current?.dataset.positionMarkerId).toBe(id);
    expect([...container.querySelectorAll('.chat-position-rail [tabindex="0"]')]).toEqual([
      current,
    ]);
  };
  try {
    document.body.append(host);
    await settle();
    const marks = container.querySelector<HTMLElement>(".chat-position-rail__marks")!;
    Object.defineProperty(marks, "clientHeight", { configurable: true, value: 240 });
    const measureRail = () => emitTranscriptResize(marks, 44, 240);
    const move = async (offset: number, frames = 1, settleFirst = false) => {
      container.scrollTop = offset;
      container.dispatchEvent(new Event("scroll"));
      measureRail();
      if (settleFirst) {
        await settle();
      }
      for (let frame = 0; frame < frames; frame++) {
        await settle(true);
      }
    };
    emitTranscriptResize(container, 800, 600);
    measureRail();
    await move(50, 2, true);
    expectCurrent("row-2");
    await move(55);
    expectCurrent("row-2");
    // Neither intersections nor the virtual range change at this midpoint.
    await move(70);
    expectCurrent("row-3");

    // Native offsets must refresh the owner's precise end before range changes.
    await move(4198.5, 2, true);
    expect(recordViewport.mock.results.at(-1)?.value).toBe(false);
    await move(4199.5, 0, true);
    expect(recordViewport.mock.results.at(-1)?.value).toBe(true);
    await settle(true);
    expectCurrent("row-39");
    await settle(true);
    await move(4199.75);
    const firstRowBefore =
      container.querySelector<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey;
    await move(4200, 1, true);
    expect(
      container.querySelector<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey,
    ).not.toBe(firstRowBefore);
    expect(container.querySelector('[data-virtual-row-key="row-35"]')).not.toBeNull();
    expectCurrent("row-39");
  } finally {
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
