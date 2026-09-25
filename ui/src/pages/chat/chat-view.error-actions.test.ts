/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps, renderChatInto, renderChatView } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
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
  const runError = { runId: "failed-run", summary: safeDiagnostic };
  const container = renderChatView({ onSetReply, messages: [], runError });
  containers.push(container);
  document.body.appendChild(container);
  expect(container.querySelector(".agent-chat__composer-notices .chat-error")).not.toBeNull();
  renderChatInto(container, {
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
    runError,
  });
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

it.each(["assistant", "custom"] as const)(
  "retains pane Refresh after %s diagnostic handoff and through guarded updates",
  (role) => {
    const onRefresh = vi.fn();
    const nextRefresh = vi.fn();
    const summary = "Error: Request failed.";
    const runError = { runId: "failed-run", summary };
    const messages = [
      {
        role,
        customType: "run-failed-before-reply",
        stopReason: "error",
        errorMessage: summary,
        content: summary,
        __openclaw: { id: "failure-entry", seq: 3, runId: "failed-run" },
      },
    ];
    const props = createChatProps({ runError, onRefresh });
    const container = document.createElement("div");
    containers.push(container);
    document.body.appendChild(container);
    const draw = (overrides: Partial<typeof props>) =>
      render(renderChat({ ...props, ...overrides }), container);
    const refresh = () =>
      expectDefined(
        container.querySelector<HTMLButtonElement>(".chat-error__refresh"),
        "diagnostic Refresh",
      );
    draw({});
    refresh().click();
    expect(onRefresh).toHaveBeenCalledOnce();
    draw({ messages });
    expect(container.querySelectorAll(".chat-error")).toHaveLength(1);
    expect(container.querySelector(".agent-chat__composer-notices .chat-error")).toBeNull();
    expect(container.querySelector(".chat-bubble--run-error .chat-error__refresh")).not.toBeNull();
    expect(refresh().textContent?.trim()).toBe("Refresh");
    refresh().click();
    expect(onRefresh).toHaveBeenCalledTimes(2);
    draw({ messages, onRefresh: nextRefresh });
    refresh().click();
    expect(nextRefresh).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledTimes(2);
    draw({ messages, onRefresh: nextRefresh, connected: false });
    expect(refresh().disabled).toBe(true);
    refresh().click();
    expect(nextRefresh).toHaveBeenCalledOnce();
    draw({ messages, onRefresh: nextRefresh, connected: true, runError: null });
    expect(refresh().disabled).toBe(false);
    refresh().click();
    expect(nextRefresh).toHaveBeenCalledTimes(2);
  },
);
