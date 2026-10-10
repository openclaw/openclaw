// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);

function renderChatView(overrides: Partial<Parameters<typeof renderChat>[0]>) {
  const container = document.createElement("div");
  const props = createChatProps(overrides);
  onTestFinished(async () => {
    await vi.dynamicImportSettled();
    props.transcript.hostDisconnected();
    render(null, container);
    resetChatViewState();
    resetTranscriptTestDom();
  });
  render(renderChat(props), container);
  return container;
}

describe("recorded automation input attribution", () => {
  it.each(["agent:main:cron:daily:run:execution", "agent:main:main"])(
    "keeps compact automation input outside the completed run: %s",
    (sourceSessionKey) => {
      const container = renderChatView({
        sessionKey: "agent:main:main",
        messages: [
          {
            role: "assistant",
            content: "Check the queue.",
            timestamp: 1_000,
            provenance: {
              kind: "internal_system",
              sourceTool: "cron",
              jobId: "daily",
              runId: "execution",
              sourceSessionKey,
            },
            senderLabel: "Forwarded from Daily report",
            senderSession: { sessionKey: sourceSessionKey, agentId: "main", label: "Daily report" },
            __openclaw: {
              id: "cron-input",
              seq: 1,
              idempotencyKey: "cron-logical:user",
              turnBoundary: true,
            },
          },
          {
            role: "assistant",
            content: "The queue is clear.",
            timestamp: 2_000,
            phase: "final_answer",
            __openclaw: { id: "cron-answer", seq: 2, runId: "execution" },
          },
        ],
      });

      expect(container.querySelectorAll(".chat-group--forwarded")).toHaveLength(0);
      const forwarded = expectDefined(
        container.querySelector(".chat-session-activity"),
        "automation input",
      );
      expect(forwarded.querySelector("summary")?.textContent).toContain("Daily report");
      expect(forwarded.closest(".chat-agent-run-frame")).toBeNull();
      expect(forwarded.textContent).not.toContain("Check the queue.");
      expect(forwarded.textContent).not.toContain("The queue is clear.");
      expect(container.textContent).toContain("The queue is clear.");
    },
  );
});
