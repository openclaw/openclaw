/* @vitest-environment jsdom */
import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeChatHost } from "../chat-host.test-support.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { lockChatScroll } from "../scroll.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import {
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

describe("transcript follow continuity", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

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
