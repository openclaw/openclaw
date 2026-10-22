/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { render, renderTranscriptSearch } from "../test-helpers/chat-transcript-native.tsx";
import { getTranscriptState, toggleTranscriptSearch } from "./chat-thread-interactions.ts";
import {
  transcriptContainer,
  threadFixture,
  searchableThreadFixture,
} from "./chat-transcript-fixture.test-support.tsx";
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

const message = (role: string, content: unknown, timestamp: number, extra = {}) => ({
  role,
  content,
  timestamp,
  ...extra,
});

function expectMetadata(groups: Element[], expected: boolean[]) {
  expect(groups.map((group) => group.classList.contains("chat-group--meta-revealed"))).toEqual(
    expected,
  );
}

const fixtures = new Set<ReturnType<typeof threadFixture>>();
function track<T extends ReturnType<typeof threadFixture>>(fixture: T): T {
  fixtures.add(fixture);
  return fixture;
}
function release(fixture: ReturnType<typeof threadFixture>) {
  fixture.transcript.dispose();
  fixture.container.remove();
  fixtures.delete(fixture);
}

it("projects search changes without redraw callbacks or replacing its input", () => {
  const paneId = "native-search-revision";
  const state = getTranscriptState(paneId);
  const container = transcriptContainer();
  render(renderTranscriptSearch(paneId), container);
  expect(container.querySelector("input")).toBeNull();
  state.search.toggle();
  flush();
  const input = requireElement(container, "input") as HTMLInputElement;
  input.focus();
  state.search.setQuery("updated query");
  flush();
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("updated query");
  expect(document.activeElement).toBe(input);
  state.search.close();
  flush();
  expect(container.querySelector("input")).toBeNull();
  render(null, container);
});
beforeEach(installTranscriptDomMocks);
afterEach(() => {
  fixtures.forEach(release);
  vi.useRealTimers();
  resetTranscriptTestDom();
});

it("keeps live metadata absent while revealing stored metadata within each transcript", async () => {
  const first = track(
    threadFixture({
      ...threadProps(
        "pane-touch-first",
        "agent:main:first",
        ["First", "Second"].map((text, i) => message("user", text, 1_000 + 500 * i)),
      ),
      stream: "Live reply",
      streamStartedAt: 2_000,
    }),
  );
  const second = track(
    threadFixture(
      threadProps("touch-second", "agent:main:second", [
        message("assistant", "Other transcript", 3_000),
      ]),
    ),
  );
  first.rerender();
  second.rerender();
  first.transcript.start();
  second.transcript.start();
  first.transcript.update();
  second.transcript.update();
  await flushDeferredRowPrune();

  const storedGroup = requireElement(first.container, ".chat-group.user");
  const storedBubble = requireElement(storedGroup, ".chat-bubble");
  const streamBubble = requireElement(first.container, ".chat-bubble.streaming");
  const streamGroup = requireClosest(streamBubble, ".chat-group--with-footer");
  const secondGroup = requireElement(second.container, ".chat-group.assistant");

  storedBubble.dispatchEvent(new Event("pointerup", { bubbles: true }));
  expect(storedGroup.classList.contains("chat-group--meta-revealed")).toBe(false);

  const groups = [storedGroup, streamGroup, secondGroup];
  touchPointerUp(storedBubble);
  expectMetadata(groups, [true, false, false]);
  expect(storedGroup.classList.contains("chat-group--peer")).toBe(false);
  expect(storedGroup.querySelectorAll(".chat-bubble")).toHaveLength(2);
  const touches: [Element, boolean[]][] = [
    [requireElement(storedGroup, ".chat-bubble:last-child"), [false, false, false]],
    [storedBubble, [true, false, false]],
    [streamBubble, [false, true, false]],
    [requireElement(secondGroup, ".chat-bubble"), [false, true, true]],
    [requireElement(secondGroup, ".chat-copy-btn"), [false, true, true]],
    [requireElement(secondGroup, ".chat-bubble"), [false, true, false]],
  ];
  for (const [target, expected] of touches) {
    touchPointerUp(target);
    expectMetadata(groups, expected);
  }
  expect(streamGroup.querySelector(".chat-group-footer")?.childElementCount).toBe(0);
});

it("keeps the completed answer timestamp and actions when full run history is restored", async () => {
  vi.useFakeTimers();
  const runId = "answer-timestamp";
  const sessionKey = "agent:main:dashboard:answer-timestamp";
  const startedAt = Date.parse("2026-09-27T08:46:05.653Z");
  const answeredAt = Date.parse("2026-09-27T09:20:57.883Z");
  const text = "Confirmed: Engineers — café 雪 🦞";
  const user = message("user", "Confirm the audience.", startedAt - 1_000, {
    __openclaw: { id: "timestamp-prompt", idempotencyKey: `${runId}:user` },
  });
  const answer = message("assistant", text, answeredAt, {
    stopReason: "stop",
    __openclaw: { id: "timestamp-answer", runId, runTerminal: true },
  });
  const call = { type: "toolCall", id: "ask", name: "ask_user", arguments: {} };
  const work = [
    message("assistant", [call], startedAt, {
      stopReason: "toolUse",
      __openclaw: { id: "timestamp-call", runId },
    }),
    message("toolResult", "Engineers — café 雪 🦞", answeredAt - 1_000, {
      toolCallId: "ask",
      toolName: "ask_user",
      __openclaw: { id: "timestamp-result", runId },
    }),
  ];
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const onSetReply = vi.fn();
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
    const fixture = track(threadFixture(props));
    const { transcript, container, rerender } = fixture;
    rerender();
    transcript.start();
    transcript.update();
    await vi.advanceTimersByTimeAsync(0);
    const group = requireElement(container, ".chat-group.assistant");
    expect(group.querySelectorAll(".chat-group-footer")).toHaveLength(1);
    expect(group.querySelector("time")?.getAttribute("datetime")).toBe("2026-09-27T09:20:57.883Z");
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
    release(fixture);
  }
});

it.each(["indexed", "keyed"] as const)(
  "keeps a settled %s stream replyable while search separates its following tool row",
  async (kind) => {
    const paneId = `settled-reply-${kind}`;
    const sessionKey = "agent:main:main";
    const runId = "stream-reply-run";
    const text = "Settled summary";
    const onSetReply = vi.fn();
    const props = {
      ...threadProps(paneId, sessionKey, [
        message("user", "Inspect the workspace", 1_000, {
          __openclaw: { id: "stream-prompt", idempotencyKey: `${runId}:user` },
        }),
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
        message("toolResult", "Tool result", 3_000, {
          toolCallId: "following-read",
          toolName: "read",
          runId,
        }),
      ],
    };
    const { transcript, container, searchContainer, rerender } = track(
      searchableThreadFixture(props),
    );
    rerender();
    toggleTranscriptSearch(paneId);
    flush();
    transcript.start();
    const input = requireElement(searchContainer, "input") as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushDeferredRowPrune();

    const bubble = requireElement(container, ".chat-group.assistant .chat-bubble");
    const group = requireClosest(bubble, ".chat-group");
    const tool = requireElement(container, ".chat-group.tool");
    expect(bubble.textContent).toContain(text);
    expect(bubble.classList.contains("streaming")).toBe(false);
    expect(group.querySelector(".chat-group-footer-actions, .chat-reading-indicator")).toBeNull();
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
  },
);

it.each([true, false])(
  "keeps completed commentary a turn block only outside search results (search %s)",
  async (search) => {
    const paneId = `commentary-${search}`;
    const text = "Checked the workspace layout.";
    const props = threadProps(paneId, "agent:main:main", [
      message("user", "Inspect the workspace", 1_000),
      message("assistant", [{ type: "text", text }], 2_000, {
        openclawStreamFallback: { replacementText: text, source: "segment", itemId: "layout" },
      }),
      message("assistant", "Workspace looks fine.", 3_000),
    ]);
    const { transcript, container, searchContainer, rerender } = track(
      searchableThreadFixture(props),
    );
    if (search) {
      toggleTranscriptSearch(paneId);
    }
    transcript.start();
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
    expect(
      [
        ".chat-group-footer .chat-sender-name",
        ".chat-group-footer .chat-group-timestamp",
        ".chat-group-footer-actions .chat-copy-btn",
      ].map((selector) => group.querySelector(selector) !== null),
    ).toEqual([search, search, search]);
  },
);
