/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import type { ChatMessageReactions } from "./chat-message-reactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function message(role: string, id: string, timestamp: number, extra: Record<string, unknown> = {}) {
  return { role, content: id, timestamp, __openclaw: { id }, ...extra };
}

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

async function mount(messages: unknown[], sessionKey = "agent:main:dashboard:reactions") {
  const props = threadProps("reaction-transcript", sessionKey, messages);
  props.showToolCalls = true;
  props.assistantAvatar = "🦀";
  // Keep this small history wholly inside the actual virtualized viewport.
  vi.stubGlobal("innerHeight", 2_000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(2_000);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 2_000),
  );
  props.onSetReply = vi.fn();
  props.onRewindMessage = vi.fn(async () => true);
  props.onFocusComposer = vi.fn();
  props.messageReactions = new Map();
  props.onReact = vi.fn();
  // Start at the saved top instead of the end-anchor bootstrap's last-row range.
  saveChatSessionScrollPosition(props.paneId, sessionKey, { scrollTop: 0, anchorToEnd: false });
  const transcript = createTestTranscript(props.paneId);
  const container = document.body.appendChild(document.createElement("div"));
  const rows = () => [
    ...container.querySelectorAll<ChatMessageReactions>("openclaw-chat-message-reactions"),
  ];
  const draw = async () => {
    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();
    await Promise.all(rows().map((row) => row.updateComplete));
  };
  transcript.hostConnected();
  await draw();
  return {
    props,
    container,
    rows,
    draw,
    dispose: () => {
      transcript.hostDisconnected();
      render(nothing, container);
      container.remove();
    },
  };
}

const reactionIds = (container: ParentNode) =>
  [...container.querySelectorAll<HTMLElement>("openclaw-chat-message-reactions")].map(
    (row) => row.dataset.messageId,
  );

describe("transcript reaction action owners", () => {
  it.each(["agent:main:dashboard:reactions", "agent:main:main"])(
    "uses only saved user messages and each completed turn's final visible answer in %s",
    async (sessionKey) => {
      const messages = [
        message("user", "prompt", 1),
        message("assistant", "commentary", 2, { phase: "commentary" }),
        message("assistant", "earlier-answer", 3, { phase: "final_answer" }),
        message("toolResult", "tool", 4, { toolCallId: "call", toolName: "read" }),
        message("assistant", "final-answer-part", 5, { phase: "final_answer" }),
        message("assistant", "final-answer", 6, { phase: "final_answer" }),
        message("assistant", "reasoning", 7, {
          content: [{ type: "thinking", thinking: "Private reasoning" }],
        }),
        message("user", "next-prompt", 8),
        message("assistant", "next-answer", 9),
      ];
      const snapshot = structuredClone(messages);
      const view = await mount(messages, sessionKey);
      try {
        expect(reactionIds(view.container)).toEqual([
          "prompt",
          "final-answer",
          "next-prompt",
          "next-answer",
        ]);
        expect(messages).toEqual(snapshot);
        const userActions = view.rows().find((row) => row.messageId === "prompt")!;
        expect(userActions.closest(".chat-bubble")).toBeNull();
        expect(
          userActions
            .closest(".chat-message-with-reactions")
            ?.querySelector(".chat-bubble")
            ?.getAttribute("data-entry-id"),
        ).toBe("prompt");
        expect(view.rows().map((row) => row.messageId)).toEqual(reactionIds(view.container));
        expect(view.rows().map((row) => row.layout)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
        ]);
        // A later answer revokes the earlier group's ownership without replacing
        // its source message or changing run flags (the row guard must notice).
        view.props.messages = [
          ...messages,
          message("toolResult", "late-tool", 10, { toolCallId: "late", toolName: "read" }),
          message("assistant", "latest-answer", 11, { phase: "final_answer" }),
        ];
        await view.draw();
        expect(reactionIds(view.container)).toEqual([
          "prompt",
          "final-answer",
          "next-prompt",
          "latest-answer",
        ]);
      } finally {
        view.dispose();
      }
    },
  );

  it("keeps previous controls while the saved final answer waits for turn settlement", async () => {
    const view = await mount([
      message("user", "old-prompt", 1),
      message("assistant", "old-answer", 2),
      message("user", "active-prompt", 3, { __openclaw: { id: "active-prompt", runId: "run" } }),
      message("assistant", "active-answer", 4, {
        phase: "final_answer",
        __openclaw: { id: "active-answer", runId: "run" },
      }),
    ]);
    try {
      view.props.runId = "run";
      view.props.runWorking = true;
      view.props.runActive = true;
      await view.draw();
      expect(reactionIds(view.container)).toEqual(["old-prompt", "old-answer", "active-prompt"]);
      view.props.stream = "A still-streaming continuation";
      view.props.streamStartedAt = 5;
      await view.draw();
      expect(reactionIds(view.container)).toEqual(["old-prompt", "old-answer", "active-prompt"]);
      view.props.stream = null;
      view.props.runWorking = false;
      await view.draw();
      expect(reactionIds(view.container)).not.toContain("active-answer");
      view.props.runActive = false;
      view.props.runId = null;
      await view.draw();
      expect(reactionIds(view.container)).toEqual([
        "old-prompt",
        "old-answer",
        "active-prompt",
        "active-answer",
      ]);
      const answer = view.rows().find((row) => row.messageId === "active-answer")!;
      expect(answer.closest(".chat-bubble")?.getAttribute("data-entry-id")).toBe("active-answer");
    } finally {
      view.dispose();
    }
  });

  it("does not expose reactions on an earlier answer before a same-run steer continuation", async () => {
    const view = await mount([
      message("user", "prompt", 1, { __openclaw: { id: "prompt", runId: "run" } }),
      message("assistant", "earlier-answer", 2, {
        phase: "final_answer",
        __openclaw: { id: "earlier-answer", runId: "run" },
      }),
      message("user", "steer", 3, {
        __openclaw: { id: "steer", runId: "steer-run", steerTargetRunId: "run" },
      }),
      message("toolResult", "continuation-tool", 4, {
        toolCallId: "continued",
        toolName: "read",
        __openclaw: { id: "continuation-tool", runId: "run" },
      }),
      message("assistant", "continued-answer", 5, {
        phase: "final_answer",
        __openclaw: { id: "continued-answer", runId: "run" },
      }),
    ]);
    try {
      view.props.runId = "run";
      view.props.runWorking = true;
      view.props.runActive = true;
      await view.draw();
      expect(reactionIds(view.container)).toEqual(["prompt", "steer"]);
      view.props.runWorking = false;
      view.props.runActive = false;
      view.props.runId = null;
      await view.draw();
      expect(reactionIds(view.container)).toEqual(["prompt", "steer", "continued-answer"]);
    } finally {
      view.dispose();
    }
  });

  it("does not grant pending, unsaved, failed or tool messages reaction targets", async () => {
    const view = await mount([
      message("user", "saved-user", 1),
      { role: "assistant", content: "Unsaved answer", timestamp: 2 },
      message("user", "pending:accepted", 3),
      message("assistant", "failed", 4, { stopReason: "error" }),
      message("user", "pending-send", 5, {
        __openclaw: { id: "pending-send", kind: "pending-send", state: "unconfirmed" },
      }),
      message("toolResult", "tool-output", 6, { toolCallId: "only-tool", toolName: "read" }),
    ]);
    try {
      expect(reactionIds(view.container)).toEqual(["saved-user"]);
      expect(view.props.onReact).not.toHaveBeenCalled();
    } finally {
      view.dispose();
    }
  });

  it("keeps Copy, Rewind, Reply, React in order and preserves reply/rewind targets", async () => {
    const view = await mount([message("user", "saved-user", 1)]);
    try {
      const row = view.rows()[0]!;
      expect(
        [...row.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Copy as markdown", "Rewind", "Reply to message", "Add reaction"]);
      row.querySelector<HTMLButtonElement>(".chat-reply-btn")!.click();
      expect(view.props.onSetReply).toHaveBeenCalledWith(
        expect.objectContaining({ sourceMessageId: "saved-user", text: "saved-user" }),
      );
      localStorage.setItem("openclaw:skip-rewind-confirm", "1");
      row.querySelector<HTMLButtonElement>(".chat-group-rewind")!.click();
      await Promise.resolve();
      expect(view.props.onRewindMessage).toHaveBeenCalledWith("saved-user");
      expect(view.props.onFocusComposer).toHaveBeenCalledOnce();
      view.props.runWorking = true;
      await view.draw();
      expect(view.container.querySelector(".chat-group-rewind")).toBeNull();
      expect(view.container.querySelector(".chat-reply-btn")).not.toBeNull();
    } finally {
      localStorage.removeItem("openclaw:skip-rewind-confirm");
      view.dispose();
    }
  });
});
