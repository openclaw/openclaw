/* @vitest-environment jsdom */
import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

describe("transcript follow continuity", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("retargets automatic follow without inserting an instant cancellation", async () => {
    stubAnimationFrames();
    const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "content",
      key: "row:" + index,
      content: html`<div>row ${index}</div>`,
    }));
    const { container, transcript } = await mountTestTranscript("follow-continuity", rows);
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 4800 },
    });
    const writes: ScrollToOptions[] = [];
    container.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object") {
        writes.push(options);
      }
    };
    transcript.scrollToEnd({ source: "manual", behavior: "smooth" });
    expect(writes.some((write) => write.behavior === "smooth")).toBe(true);
    writes.length = 0;
    transcript.scrollToEnd({ source: "auto", behavior: "smooth" });
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((write) => write.behavior === "smooth")).toBe(true);
    transcript.hostDisconnected();
  });
});
