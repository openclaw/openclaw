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
  it.each([false, true])(
    "keeps the automation source outside the agent run frame with completed answer=%s",
    (withAnswer) => {
      const sourceSessionKey = "agent:main:cron:daily:run:execution";
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
          ...(withAnswer
            ? [
                {
                  role: "assistant",
                  content: "The queue is clear.",
                  timestamp: 2_000,
                  phase: "final_answer",
                  __openclaw: { id: "cron-answer", seq: 2, runId: "execution" },
                },
              ]
            : []),
        ],
      });

      expect(container.querySelectorAll(".chat-group--forwarded")).toHaveLength(1);
      const forwarded = expectDefined(
        container.querySelector(".chat-group--forwarded"),
        "automation input",
      );
      const source = forwarded.querySelector<HTMLAnchorElement>("a.markdown-session-link");
      expect(source?.dataset.sessionKey).toBe(sourceSessionKey);
      expect(source?.querySelector(".session-label")?.textContent).toBe("Daily report");
      expect(source?.querySelector(".session-link-icon svg")?.namespaceURI).toBe(
        "http://www.w3.org/2000/svg",
      );
      expect(forwarded.textContent).toContain("Check the queue.");
      expect(forwarded.textContent).not.toContain("The queue is clear.");
      if (withAnswer) {
        expect(container.textContent).toContain("The queue is clear.");
      }
    },
  );
});
