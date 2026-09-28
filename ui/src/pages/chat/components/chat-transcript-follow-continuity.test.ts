/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeChatHost } from "../chat-host.test-support.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { lockChatScroll } from "../scroll.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  resizeObservers,
  transcriptDomState,
  transcriptSize,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

describe("transcript follow continuity", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("remeasures skipped rows when automatic follow replaces smooth scrolling", async () => {
    const flushFrames = stubAnimationFrames();
    transcriptDomState.measuredRowHeight = 120;
    const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "content",
      key: "row:" + index,
      content: html`<div>row ${index}</div>`,
    }));
    const { container, transcript, renderRows } = await mountTestTranscript(
      "follow-remeasure",
      rows,
    );
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 4800 },
    });
    container.scrollTop = 2400;
    container.dispatchEvent(new Event("scroll"));
    renderRows(rows);
    await flushDeferredRowPrune();
    renderRows(rows);
    const row = expectDefined(
      container.querySelector<HTMLElement>(".chat-virtual-row"),
      "overscan row outside the smooth target buffer",
    );
    const before = transcriptSize(container);
    container.scrollTo = vi.fn();
    try {
      transcript.scrollToEnd({ source: "auto", behavior: "smooth" });
      row.style.height = "180px";
      // TanStack suppresses ResizeObserver deliveries outside the smooth target's buffer.
      for (const observer of resizeObservers) {
        observer.emitTarget(row, 800, 180);
      }
      renderRows(rows);
      expect(transcriptSize(container)).toBe(before);

      transcript.scrollToEnd({ source: "auto", behavior: "auto" });
      flushFrames();
      renderRows(rows);
      expect(transcriptSize(container)).toBe(before + 60);
    } finally {
      transcript.hostDisconnected();
    }
  });

  it.each([
    { source: "auto", settled: false },
    { source: "manual", settled: false },
    { source: "manual", settled: true },
  ] as const)(
    "preserves $source ownership while retargeting follow (settled=$settled)",
    async ({ source, settled }) => {
      stubAnimationFrames();
      const policy = makeChatHost({ chatHasAutoScrolled: true });
      const transcript = new ChatTranscriptController(
        {
          addController: vi.fn(),
          removeController: vi.fn(),
          requestUpdate: vi.fn(),
          updateComplete: Promise.resolve(true),
        },
        () => "follow-continuity",
        { canFollowEnd: () => !policy.chatFollowLocked },
      );
      Object.assign(policy, {
        chatCancelScroll: () => transcript.cancelScroll(),
        chatIsManualScroll: () => transcript.isManualScroll,
      });
      const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
        kind: "content",
        key: "row:" + index,
        content: html`<div>row ${index}</div>`,
      }));
      const { container } = await mountTestTranscript("follow-continuity", rows, transcript);
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 4800 },
      });
      container.scrollTop = 1000;
      const writes: ScrollToOptions[] = [];
      container.scrollTo = (options?: ScrollToOptions | number) => {
        if (typeof options === "object") {
          writes.push(options);
        }
      };
      transcript.scrollToEnd({ source, behavior: "smooth" });
      expect(writes.some((write) => write.behavior === "smooth")).toBe(true);
      writes.length = 0;
      transcript.scrollToEnd({ source: "auto", behavior: "smooth" });
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every((write) => write.behavior === "smooth")).toBe(true);
      if (settled) {
        container.scrollTop = 4200;
      }
      writes.length = 0;
      lockChatScroll(policy, "remote-input");
      const shouldLock = source === "auto" || settled;
      expect(policy.chatFollowLocked).toBe(shouldLock);
      expect(writes).toEqual(
        shouldLock
          ? [expect.objectContaining({ behavior: "instant", top: settled ? 4200 : 1000 })]
          : [],
      );
      transcript.hostDisconnected();
    },
  );
});
