/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderTranscriptSearch, toggleTranscriptSearch } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  requireElement,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function requireClosest(element: Element, selector: string): HTMLElement {
  return expectDefined(element.closest<HTMLElement>(selector), `closest ${selector}`);
}

function touchPointerUp(element: Element): void {
  const event = new Event("pointerup", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  element.dispatchEvent(event);
}

describe("chat transcript message controls", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("keeps live metadata absent while revealing stored metadata within each transcript", async () => {
    const firstTranscript = createTestTranscript();
    const secondTranscript = createTestTranscript();
    const firstContainer = document.body.appendChild(document.createElement("div"));
    const secondContainer = document.body.appendChild(document.createElement("div"));
    const firstProps = {
      ...threadProps("pane-touch-first", "agent:main:first", [
        { role: "user", content: "Stored message", timestamp: 1_000 },
        { role: "user", content: "Second stored message", timestamp: 1_500 },
      ]),
      stream: "Live reply",
      streamStartedAt: 2_000,
    };
    const secondProps = threadProps("pane-touch-second", "agent:main:second", [
      { role: "assistant", content: "Other transcript", timestamp: 3_000 },
    ]);
    render(renderChatThread(firstProps, firstTranscript), firstContainer);
    render(renderChatThread(secondProps, secondTranscript), secondContainer);
    firstTranscript.hostConnected();
    secondTranscript.hostConnected();
    firstTranscript.hostUpdated();
    secondTranscript.hostUpdated();
    await flushDeferredRowPrune();

    const storedGroup = requireElement(firstContainer, ".chat-group.user");
    const storedBubble = requireElement(storedGroup, ".chat-bubble");
    const streamBubble = requireElement(firstContainer, ".chat-bubble.streaming");
    const streamGroup = requireClosest(streamBubble, ".chat-group--with-footer");
    const secondGroup = requireElement(secondContainer, ".chat-group.assistant");

    storedBubble.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(storedGroup.classList.contains("chat-group--meta-revealed")).toBe(false);

    touchPointerUp(storedBubble);
    expect(storedGroup.classList.contains("chat-group--meta-revealed")).toBe(true);

    // Nonparticipant groups still toggle their shared metadata, not each bubble.
    expect(storedGroup.classList.contains("chat-group--peer")).toBe(false);
    expect(storedGroup.querySelectorAll(".chat-bubble")).toHaveLength(2);
    touchPointerUp(requireElement(storedGroup, ".chat-bubble:last-child"));
    expect(storedGroup.classList.contains("chat-group--meta-revealed")).toBe(false);
    touchPointerUp(storedBubble);
    expect(storedGroup.classList.contains("chat-group--meta-revealed")).toBe(true);

    touchPointerUp(streamBubble);
    expect(storedGroup.classList.contains("chat-group--meta-revealed")).toBe(false);
    expect(streamGroup.classList.contains("chat-group--meta-revealed")).toBe(true);
    expect(streamGroup.querySelector(".chat-group-footer")?.childElementCount).toBe(0);

    touchPointerUp(requireElement(secondGroup, ".chat-bubble"));
    expect(secondGroup.classList.contains("chat-group--meta-revealed")).toBe(true);
    expect(streamGroup.classList.contains("chat-group--meta-revealed")).toBe(true);

    touchPointerUp(requireElement(secondGroup, ".chat-copy-btn"));
    expect(secondGroup.classList.contains("chat-group--meta-revealed")).toBe(true);

    touchPointerUp(requireElement(secondGroup, ".chat-bubble"));
    expect(secondGroup.classList.contains("chat-group--meta-revealed")).toBe(false);
    firstTranscript.hostDisconnected();
    secondTranscript.hostDisconnected();
  });

  it("keeps the completed answer timestamp and actions when full run history is restored", async () => {
    vi.useFakeTimers();
    const runId = "answer-timestamp";
    const sessionKey = "agent:main:dashboard:answer-timestamp";
    const startedAt = Date.parse("2026-09-27T08:46:05.653Z");
    const answeredAt = Date.parse("2026-09-27T09:20:57.883Z");
    const text = "Confirmed: Engineers — café 雪 🦞";
    const user = {
      role: "user",
      content: "Confirm the audience.",
      timestamp: startedAt - 1_000,
      __openclaw: { id: "timestamp-prompt", idempotencyKey: `${runId}:user` },
    };
    const answer = {
      role: "assistant",
      content: text,
      timestamp: answeredAt,
      stopReason: "stop",
      __openclaw: { id: "timestamp-answer", runId, runTerminal: true },
    };
    const work = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "audience", name: "ask_user", arguments: {} }],
        timestamp: startedAt,
        stopReason: "toolUse",
        __openclaw: { id: "timestamp-call", runId },
      },
      {
        role: "toolResult",
        toolCallId: "audience",
        toolName: "ask_user",
        content: "Engineers — café 雪 🦞",
        timestamp: answeredAt - 1_000,
        __openclaw: { id: "timestamp-result", runId },
      },
    ];
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onSetReply = vi.fn();
    try {
      for (const [index, messages] of [
        [user, answer],
        [user, ...work, answer],
      ].entries()) {
        const props = {
          ...threadProps(`pane-answer-timestamp-${index}`, sessionKey, messages),
          showToolCalls: true,
          onSetReply,
          selectedSession: {
            key: sessionKey,
            kind: "direct" as const,
            updatedAt: answeredAt,
            status: "done" as const,
            lastRunId: runId,
            runtimeMs: 35 * 60_000 + 17_000,
          },
        };
        const transcript = createTestTranscript();
        const container = document.body.appendChild(document.createElement("div"));
        try {
          render(renderChatThread(props, transcript), container);
          transcript.hostConnected();
          transcript.hostUpdated();
          await vi.advanceTimersByTimeAsync(0);
          const group = requireElement(container, ".chat-group.assistant");
          expect(group.querySelectorAll(".chat-group-footer")).toHaveLength(1);
          expect(group.querySelector("time")?.getAttribute("datetime")).toBe(
            "2026-09-27T09:20:57.883Z",
          );
          requireElement(group, ".chat-copy-btn").click();
          expect(writeText).toHaveBeenLastCalledWith(text);
          requireElement(group, ".chat-reply-btn").click();
          expect(onSetReply).toHaveBeenLastCalledWith(
            expect.objectContaining({ sourceMessageId: "timestamp-answer", text }),
          );
          if (index === 1) {
            expect(requireElement(group, ".chat-work-group").textContent).toContain(
              "Worked for 35 minutes, 17 seconds",
            );
          }
          await vi.advanceTimersByTimeAsync(1_500);
        } finally {
          transcript.hostDisconnected();
          container.remove();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["indexed", "keyed"] as const)(
    "keeps a settled %s stream replyable while search separates its following tool row",
    async (kind) => {
      const paneId = `pane-settled-stream-reply-${kind}`;
      const sessionKey = "agent:main:main";
      const runId = "stream-reply-run";
      const text = "Settled summary";
      const onSetReply = vi.fn();
      const props = {
        ...threadProps(paneId, sessionKey, [
          {
            role: "user",
            content: "Inspect the workspace",
            timestamp: 1_000,
            __openclaw: { id: "stream-prompt", idempotencyKey: `${runId}:user` },
          },
        ]),
        runId,
        runActive: true,
        runWorking: true,
        streamStartedAt: 2_000,
        showToolCalls: true,
        onSetReply,
        streamSegments: [
          {
            text,
            ts: 2_000,
            runId,
            ...(kind === "keyed" ? { itemId: "settled-segment" } : {}),
          },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "following-read",
            toolName: "read",
            content: "Tool result",
            timestamp: 3_000,
            runId,
          },
        ],
      };
      const transcript = createTestTranscript();
      const searchContainer = document.body.appendChild(document.createElement("div"));
      const container = document.body.appendChild(document.createElement("div"));
      const rerender = () => {
        render(renderTranscriptSearch(paneId, rerender), searchContainer);
        render(renderChatThread({ ...props, onRequestUpdate: rerender }, transcript), container);
        transcript.hostUpdated();
      };
      try {
        toggleTranscriptSearch(paneId, rerender);
        transcript.hostConnected();
        const input = searchContainer.querySelector<HTMLInputElement>("input");
        expect(input).not.toBeNull();
        input!.value = text;
        input!.dispatchEvent(new Event("input", { bubbles: true }));
        await flushDeferredRowPrune();

        const bubble = requireElement(container, ".chat-group.assistant .chat-bubble");
        const group = requireClosest(bubble, ".chat-group");
        const tool = requireElement(container, ".chat-group.tool");
        expect(bubble.textContent).toContain(text);
        expect(bubble.classList.contains("streaming")).toBe(false);
        expect(group.querySelector(".chat-group-footer-actions")).toBeNull();
        expect(group.querySelector(".chat-reading-indicator")).toBeNull();
        expect(group.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        bubble.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        const reply = requireElement(document, '.chat-reply-context-menu [role="menuitem"]');
        expect(reply.textContent).toBe("Reply");
        reply.click();

        expect(onSetReply).toHaveBeenCalledOnce();
        expect(onSetReply).toHaveBeenCalledWith({
          messageId: bubble.dataset.messageId,
          text,
          senderLabel: "Molty",
        });
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it.each([true, false])(
    "keeps completed commentary a turn block only outside search results (search %s)",
    async (search) => {
      const paneId = `pane-commentary-search-${search}`;
      const text = "Checked the workspace layout.";
      const props = threadProps(paneId, "agent:main:main", [
        { role: "user", content: "Inspect the workspace", timestamp: 1_000 },
        {
          role: "assistant",
          content: [{ type: "text", text }],
          timestamp: 2_000,
          openclawStreamFallback: { replacementText: text, source: "segment", itemId: "layout" },
        },
        { role: "assistant", content: "Workspace looks fine.", timestamp: 3_000 },
      ]);
      const transcript = createTestTranscript();
      const searchContainer = document.body.appendChild(document.createElement("div"));
      const container = document.body.appendChild(document.createElement("div"));
      const rerender = () => {
        render(renderTranscriptSearch(paneId, rerender), searchContainer);
        render(renderChatThread({ ...props, onRequestUpdate: rerender }, transcript), container);
        transcript.hostUpdated();
      };
      try {
        if (search) {
          toggleTranscriptSearch(paneId, rerender);
        }
        transcript.hostConnected();
        rerender();
        if (search) {
          const input = requireElement(searchContainer, "input") as HTMLInputElement;
          input.value = "workspace layout";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await flushDeferredRowPrune();

        const group = expectDefined(
          [...container.querySelectorAll<HTMLElement>(".chat-group.assistant")].find((element) =>
            element.textContent?.includes(text),
          ),
          "commentary group",
        );
        expect(group.classList.contains("chat-group--turn-block")).toBe(!search);
        expect(group.querySelector(".chat-group-footer .chat-sender-name") !== null).toBe(search);
        expect(group.querySelector(".chat-group-footer .chat-group-timestamp") !== null).toBe(
          search,
        );
        expect(group.querySelector(".chat-group-footer-actions .chat-copy-btn") !== null).toBe(
          search,
        );
      } finally {
        transcript.hostDisconnected();
      }
    },
  );
});
