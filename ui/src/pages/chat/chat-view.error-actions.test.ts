/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
const containers: HTMLElement[] = [];
beforeEach(() => installTranscriptDomMocks());
afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
  resetChatViewState();
  resetTranscriptTestDom();
});

it("preserves diagnostic row identity, Reply, and safe context-copy after handoff", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const onSetReply = vi.fn();
  const diagnostic = "Error: Request failed.\npassword=synthetic-password";
  const safeDiagnostic = "Error: Request failed.\npassword=[redacted]";
  const container = renderChatView({
    onSetReply,
    messages: [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: diagnostic,
        content: diagnostic,
        __openclaw: { id: "failure-entry", seq: 3, runId: "failed-run" },
      },
    ],
    runError: { runId: "failed-run", summary: safeDiagnostic },
  });
  containers.push(container);
  document.body.appendChild(container);
  const bubble = expectDefined(
    container.querySelector<HTMLElement>(".chat-bubble--run-error"),
    "diagnostic bubble",
  );
  expect(bubble.dataset.entryId).toBe("failure-entry");
  const actions = expectDefined(
    container.querySelector<HTMLElement>("[data-message-actions-for]"),
    "message action owner",
  );
  expect(bubble.dataset.messageId).toBe(actions.dataset.messageActionsFor);
  const clickAction = (name: string) => {
    const action = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '.chat-reply-context-menu button[role="menuitem"]',
      ),
    ].find((button) => button.textContent?.trim() === name);
    expectDefined(action, name + " action").click();
  };
  bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  clickAction("Reply");
  expect(onSetReply).toHaveBeenCalledWith(
    expect.objectContaining({ sourceMessageId: "failure-entry", text: safeDiagnostic }),
  );
  bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  clickAction("Copy as markdown");
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(safeDiagnostic));
  expect(container.querySelectorAll(".chat-error")).toHaveLength(1);
});
