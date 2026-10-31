/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createComposerControlsFixture } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

it.each([false, true])("announces interruptions with local cancellation caveat %s", (caveat) => {
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const container = renderChatView({
      messages: [{ role: "assistant", content: "Partial response" }],
      composerControls: createComposerControlsFixture(),
      runStatus: {
        phase: "interrupted",
        runId: "run-1",
        sessionKey: "main",
        occurredAt: 1_000,
        localModelMayStillBeFinishing: caveat,
      },
    });

    expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
    expect(container.querySelector(".agent-chat__run-status")).toBeNull();
    expect(
      container
        .querySelector(
          caveat ? ".agent-chat__cancellation-notice" : ".agent-chat__run-status-announcement",
        )
        ?.textContent?.trim(),
    ).toBe(
      caveat ? "Cancellation requested; the local model may still be finishing." : "Interrupted",
    );
    if (!caveat) {
      expect(container.querySelector(".agent-chat__cancellation-notice")).toBeNull();
    }
    expect(container.querySelector(".chat-reading-indicator")).toBeNull();
  } finally {
    nowSpy.mockRestore();
  }
});
