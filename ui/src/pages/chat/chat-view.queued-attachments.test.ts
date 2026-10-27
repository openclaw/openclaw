/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
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

describe("retained input navigation", () => {
  it.each([
    {
      type: "attachment",
      attachment: { kind: "document", label: "installation.pdf", url: "/media/installation.pdf" },
    },
    {
      type: "attachment_error",
      attachment: { kind: "video", label: "walkthrough.mp4", code: "file-not-found" },
    },
  ])("names a queued $attachment.kind attachment without message text", async (content) => {
    const historyState = makeChatHost({ currentSessionId: "attachment-session" });
    applyChatPendingInputs(historyState, {
      total: 1,
      items: [
        {
          id: "attachment-input",
          runId: "attachment-run",
          acceptedAt: 1,
          state: "queued",
          queued: true,
          message: { role: "user", content: [content] },
        },
      ],
    });
    const container = renderChatView({ historyState });
    await waitForSolid(() =>
      expect(container.querySelector(".chat-queue__text")?.textContent).toBe(
        content.attachment.label,
      ),
    );
    expect(container.querySelector(".chat-group.user")).toBeNull();
  });
});
