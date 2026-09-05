/* @vitest-environment jsdom */

import { render, type ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderChatThread } from "./chat-thread.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function transcriptFixture() {
  const container = document.body.appendChild(document.createElement("div"));
  const committed = vi.fn(() => ({
    sessionKey: transcript.renderedSessionKey,
    text: container.textContent,
    loading: container.querySelector("openclaw-panel-loading-skeleton") !== null,
  }));
  // Sidebar templates can commit separately from their pane. Readiness must
  // follow the rendered template even while its controller host has not committed.
  const host: ReactiveControllerHost = {
    addController: () => {},
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: new Promise<boolean>(() => {}),
  };
  const transcript = new ChatTranscriptController(host, { onContentCommitted: committed });
  transcript.hostConnected();
  return { container, committed, transcript };
}

describe("committed chat transcript content", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each([
    {
      kind: "notice",
      messages: [{ role: "system", content: "Session resumed", timestamp: 1_000 }],
      selector: ".chat-notice",
      text: "Session resumed",
    },
    { kind: "empty", messages: [], selector: ".agent-chat__welcome", text: "Molty" },
  ])(
    "reports the real $kind content after its template commits",
    async ({ messages, selector, text }) => {
      const { container, committed, transcript } = transcriptFixture();
      const props = threadProps("commit-pane", "agent:main:loaded", []);
      try {
        render(renderChatThread({ ...props, loading: true }, transcript), container);
        await flushDeferredRowPrune();
        expect(transcript.contentCommitted).toBe(false);
        expect(committed).not.toHaveBeenCalled();

        const loaded = renderChatThread({ ...props, messages }, transcript);
        await flushDeferredRowPrune();
        expect(transcript.contentCommitted).toBe(false);
        render(loaded, container);
        expect(transcript.contentCommitted).toBe(false);
        await flushDeferredRowPrune();

        expect(container.querySelector(selector)).not.toBeNull();
        expect(transcript.contentCommitted).toBe(true);
        expect(committed).toHaveBeenCalledOnce();
        expect(committed.mock.results[0]?.value).toMatchObject({
          sessionKey: "agent:main:loaded",
          loading: false,
        });
        expect(committed.mock.results[0]?.value.text).toContain(text);
        render(renderChatThread({ ...props, messages }, transcript), container);
        await flushDeferredRowPrune();
        expect(committed).toHaveBeenCalledOnce();
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it("keeps cached rows usable during refresh and invalidates a replaced loading shell", async () => {
    const { container, committed, transcript } = transcriptFixture();
    const props = threadProps("refresh-pane", "agent:main:cached", [
      { role: "assistant", content: "Retained answer", timestamp: 1_000 },
    ]);
    try {
      render(renderChatThread(props, transcript), container);
      await flushDeferredRowPrune();
      expect(transcript.contentCommitted).toBe(true);
      expect(committed.mock.results[0]?.value.text).toContain("Retained answer");

      render(renderChatThread({ ...props, loading: true }, transcript), container);
      await flushDeferredRowPrune();
      expect(container.textContent).toContain("Retained answer");
      expect(transcript.contentCommitted).toBe(true);
      expect(committed).toHaveBeenCalledOnce();

      render(renderChatThread({ ...props, messages: [], loading: true }, transcript), container);
      await flushDeferredRowPrune();
      expect(container.textContent).not.toContain("Retained answer");
      expect(transcript.contentCommitted).toBe(false);
      expect(committed).toHaveBeenCalledOnce();
    } finally {
      transcript.hostDisconnected();
    }
  });

  it.each(["replaced", "disconnected"] as const)(
    "cannot publish a queued commit after its transcript is %s",
    async (retirement) => {
      const { container, committed, transcript } = transcriptFixture();
      const props = threadProps("retired-pane", "agent:main:retired", []);
      try {
        render(renderChatThread(props, transcript), container);
        if (retirement === "replaced") {
          render(
            renderChatThread(
              { ...props, sessionKey: "agent:main:replacement", loading: true },
              transcript,
            ),
            container,
          );
        } else {
          transcript.hostDisconnected();
          container.remove();
        }
        await flushDeferredRowPrune();

        expect(transcript.contentCommitted).toBe(false);
        expect(committed).not.toHaveBeenCalled();
      } finally {
        transcript.hostDisconnected();
      }
    },
  );
});
