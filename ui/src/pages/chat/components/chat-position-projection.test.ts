/* @vitest-environment jsdom */
import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function message(id: string, role: string, content: unknown, seq: number, runId?: string) {
  return {
    role,
    content,
    timestamp: seq * 1_000,
    __openclaw: { id, seq, ...(runId ? { runId } : {}) },
  };
}

function withPositionIndex(
  props: Parameters<typeof projectChatTranscript>[0],
  check: (read: () => ReturnType<typeof projectChatTranscript>["positionIndex"]) => void,
) {
  const transcript = createTestTranscript();
  try {
    transcript.renderSession(props.sessionKey, (session) => {
      check(() => projectChatTranscript(props, session).positionIndex);
      return html``;
    });
  } finally {
    transcript.hostDisconnected();
  }
}

describe("chat position projection", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);
  it("uses the visible completed answer and keeps attachment-only user landmarks", () => {
    const messages = [
      message("question", "user", "Inspect the design", 1),
      message("commentary", "assistant", "Checking the files", 2, "run-1"),
      {
        ...message("tool", "toolResult", "File contents", 3, "run-1"),
        toolName: "read",
        toolCallId: "read-1",
      },
      message("answer", "assistant", "The design is ready", 4, "run-1"),
      message(
        "attachment",
        "user",
        [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }],
        5,
      ),
    ];
    const props = threadProps("rail-projection", "agent:main:projection", messages);
    withPositionIndex(props, (read) => {
      expect(read().markers.map((marker) => marker.message)).toEqual([
        messages[0],
        messages[3],
        messages[4],
      ]);
    });
  });

  it("targets the visible final answer before later dashboard commentary and tools", () => {
    const messages = [
      message("question", "user", "Inspect the design", 1),
      { ...message("final", "assistant", "Design ready", 2, "run-1"), phase: "final_answer" },
      {
        ...message("tool-1", "toolResult", "File contents", 3, "run-1"),
        toolName: "read",
        toolCallId: "read-1",
      },
      {
        ...message("tail", "assistant", "Checking the saved result", 4, "run-1"),
        phase: "commentary",
      },
      {
        ...message("tool-2", "toolResult", "Saved", 5, "run-1"),
        toolName: "read",
        toolCallId: "read-2",
      },
    ];
    const props = {
      ...threadProps("rail-folded", "agent:main:dashboard:audit", messages),
      showToolCalls: true,
      persistCommentary: true,
      runWorking: false,
    };
    withPositionIndex(props, (read) => {
      expect(read().markers.map((marker) => marker.message)).toEqual([messages[0], messages[1]]);
    });
  });
  it.each([
    {
      name: "tools and thinking only",
      content: [
        { type: "thinking", thinking: "Private planning" },
        { type: "toolCall", id: "read-1", name: "read", arguments: {} },
      ],
      stopReason: "toolUse",
      assistantMarkers: 0,
    },
    {
      name: "tagged thinking only",
      content: [{ type: "text", text: "<thinking>Private planning</thinking>" }],
      stopReason: "stop",
      assistantMarkers: 0,
    },
    { name: "error without a response", content: [], stopReason: "error", assistantMarkers: 0 },
    {
      name: "error after a partial response",
      content: [{ type: "text", text: "I checked the first section" }],
      stopReason: "error",
      assistantMarkers: 1,
    },
    {
      name: "image-only response",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      ],
      stopReason: "stop",
      assistantMarkers: 1,
    },
    {
      name: "widget-only response",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            url: "https://example.com/card",
            viewId: "card",
          },
        },
      ],
      stopReason: "stop",
      assistantMarkers: 1,
    },
  ])("indexes visible response content for $name", ({ content, stopReason, assistantMarkers }) => {
    const props = threadProps("rail-content", "agent:main:main", [
      message("question", "user", "Inspect the card", 1),
      {
        ...message("response", "assistant", content, 2, "content-run"),
        stopReason,
        errorMessage: stopReason === "error" ? "Request failed" : undefined,
      },
      {
        ...message("tool", "toolResult", "Read progress and result", 3, "content-run"),
        toolCallId: "read-1",
        toolName: "read",
      },
    ]);
    props.showToolCalls = true;
    withPositionIndex(props, (read) => {
      const index = read();
      expect(index.markers.filter((marker) => marker.role === "assistant")).toHaveLength(
        assistantMarkers,
      );
      expect(index.markers.filter((marker) => marker.role === "user")).toHaveLength(1);
      expect(index.markerIdsByMessageId.has("tool")).toBe(false);
    });
  });

  it("refreshes navigation visibility when retained message content changes", () => {
    const question = message("question", "user", "Inspect the answer", 1);
    const response = (content: string) =>
      message("response", "assistant", content, 2, "edited-run");
    const props = threadProps("rail-edited", "agent:main:main", [
      question,
      response("Visible answer"),
    ]);
    withPositionIndex(props, (read) => {
      const anchors = () => read().markers.map((marker) => marker.anchorId);
      expect(anchors()).toEqual(["question", "response"]);
      // History owners publish edited messages as replacements, keeping the retained question.
      props.messages = [question, response("<thinking>Private planning</thinking>")];
      expect(anchors()).toEqual(["question"]);
      props.messages = [question, response("The visible answer is ready")];
      expect(anchors()).toEqual(["question", "response"]);
    });
  });

  it("keeps consecutive user messages and another participant while aggregating a run across a steer", () => {
    const messages = [
      message("user-1", "user", "Review the first section", 1),
      message("user-2", "user", "Also check the attachment", 2),
      message("first", "assistant", "Checking the sections", 3, "shared-run"),
      {
        ...message("mira", "user", "Keep the caption short", 4),
        __openclaw: { id: "mira", seq: 4, senderId: "mira", senderName: "Mira" },
      },
      message("last", "assistant", "Both sections are ready", 5, "shared-run"),
    ];
    const props = threadProps("rail-steer", "agent:main:main", messages);
    withPositionIndex(props, (read) => {
      const index = read();
      expect(index.markers.map((marker) => marker.message)).toEqual([
        messages[0],
        messages[1],
        messages[4],
        messages[3],
      ]);
      expect(index.markers[2]?.anchorId).toBe("first");
      expect([...index.markerIdsByMessageId.keys()]).toEqual([
        "user-1",
        "user-2",
        "first",
        "mira",
        "last",
      ]);
    });
  });
});
