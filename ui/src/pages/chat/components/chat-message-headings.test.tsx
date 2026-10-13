/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { MessageGroup } from "./chat-message-group-view.tsx";
import { renderMessageGroup } from "./chat-message-group.ts";
import { StreamGroup, type StreamGroupPart } from "./chat-message-stream-view.tsx";
import { createMessageGroup } from "./chat-message.test-support.ts";
import {
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

describe("chat message headings", () => {
  it.each([
    { role: "user", label: "You", options: { showOwnSenderName: false } },
    { role: "user", label: "Alex", options: { userName: "Alex" } },
    { role: "assistant", label: "OpenClaw", options: {} },
  ])("places a $label heading before $role content", ({ role, label, options }) => {
    const group = createMessageGroup({ role, content: "A conversational message" }, role, {
      sender:
        role === "user" ? { id: "viewer", identity: { type: "profile", id: "viewer" } } : undefined,
    });
    const view = mountSolid(() => (
      <MessageGroup
        group={group}
        options={{ assistantName: "OpenClaw", userId: "viewer", showReasoning: false, ...options }}
      />
    ));
    flush();
    const heading = view.getByRole("heading", { level: 2, name: label });
    expect(view.getAllByRole("heading")).toHaveLength(1);
    expect(heading.classList.contains("sr-only")).toBe(true);
    expect(
      heading.compareDocumentPosition(view.container.querySelector(".chat-bubble")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each(["tool", "commentary"])("does not add a sender heading to a %s turn block", (kind) => {
    const group = createMessageGroup(
      { role: "assistant", content: "Working on the answer", phase: "commentary" },
      kind === "tool" ? "tool" : "assistant",
    );
    const view = mountSolid(() => (
      <MessageGroup group={group} options={{ showReasoning: false }} />
    ));
    flush();
    expect(view.queryAllByRole("heading")).toHaveLength(0);
  });

  it("keeps one sender heading through working, segmented streaming, and settlement", () => {
    const first: StreamGroupPart = {
      kind: "stream",
      key: "answer",
      text: "First",
      startedAt: 1000,
      isStreaming: true,
    };
    const [parts, setParts] = createSignal<StreamGroupPart[]>([
      { kind: "reading-indicator", key: "working", startedAt: 1000 },
    ]);
    const [name, setName] = createSignal("OpenClaw");
    const view = mountSolid(() => (
      <StreamGroup parts={parts()} options={{ assistant: { name: name(), avatar: null } }} />
    ));
    flush();
    expect(view.queryAllByRole("heading")).toHaveLength(0);
    setParts([first]);
    flush();
    const heading = view.getByRole("heading", { level: 2, name: "OpenClaw" });
    for (const isStreaming of [true, false]) {
      setParts([
        { ...first, text: "First and second", isStreaming: false },
        { ...first, key: "answer-next", text: "Another segment", isStreaming },
      ]);
      flush();
      expect(view.getAllByRole("heading")).toEqual([heading]);
      expect(view.container.textContent).toContain("Another segment");
    }
    setName("Updated assistant");
    flush();
    expect(view.getByRole("heading", { name: "Updated assistant", level: 2 })).toBe(heading);
  });

  it("shares a sender heading across grouped messages and a continuation, preserving Markdown headings", () => {
    const group = createMessageGroup(
      { role: "assistant", content: "First paragraph" },
      "assistant",
      {
        messages: [
          { key: "first", message: { role: "assistant", content: "First paragraph" } },
          {
            key: "second",
            message: { role: "assistant", content: "## Details\n\nMore information" },
          },
        ],
      },
    );
    const view = mountSolid(() => (
      <MessageGroup
        group={group}
        options={{
          assistantName: "OpenClaw",
          showReasoning: false,
          activeContinuation: {
            parts: [
              {
                kind: "stream",
                key: "continued",
                text: "Continued reply",
                startedAt: 2000,
                isStreaming: true,
              },
            ],
            options: { assistant: { name: "OpenClaw", avatar: null } },
          },
        }}
      />
    ));
    flush();
    expect(view.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "OpenClaw",
      "Details",
    ]);
    expect(view.container.querySelectorAll(".chat-bubble")).toHaveLength(3);
  });

  it("mounts sender headings only for the current virtual window and exposes earlier turns on scroll", async () => {
    installTranscriptDomMocks();
    const flushFrames = stubAnimationFrames();
    const rows = Array.from({ length: 100 }, (_, index) => ({
      kind: "content" as const,
      key: `turn:${index}`,
      content: renderMessageGroup(
        createMessageGroup({ role: "assistant", content: `Reply ${index}` }, "assistant", {
          key: `turn:${index}`,
        }),
        { assistantName: `Assistant ${index}`, showReasoning: false },
      ),
    }));
    const { container, transcript, renderRows } = await mountTestTranscript("heading-window", rows);
    try {
      const headings = () => [...container.querySelectorAll("h2")];
      expect(headings().length).toBeGreaterThan(0);
      expect(headings().length).toBeLessThan(rows.length);
      expect(headings().at(-1)?.textContent).toBe("Assistant 99");
      expect(headings().some((heading) => heading.textContent === "Assistant 0")).toBe(false);
      const oldHeadings = headings();
      const scroller = container.querySelector<HTMLElement>(
        ".chat-thread-inner--virtual",
      )!.parentElement!;
      transcript.scrollToOffset(0);
      renderRows(rows);
      flushFrames();
      flush();
      scroller.dispatchEvent(new Event("scroll"));
      renderRows(rows);
      expect(headings()[0]?.textContent).toBe("Assistant 0");
      expect(headings().length).toBeLessThan(rows.length);
      expect(oldHeadings.every((heading) => !heading.isConnected)).toBe(true);
    } finally {
      transcript.hostDisconnected();
      resetTranscriptTestDom();
    }
  });
});
