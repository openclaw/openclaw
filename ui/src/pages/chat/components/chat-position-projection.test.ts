/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { message } from "./chat-position-rail.test-support.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function toolResult(id: string, text: string, seq: number, toolCallId = "read-1") {
  return { ...message(id, "toolResult", text, seq, "run-1"), toolName: "read", toolCallId };
}
const imageContent = [
  { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
];

function withPositionIndex(
  props: Parameters<typeof projectChatTranscript>[0],
  check: (read: () => ReturnType<typeof projectChatTranscript>["positionIndex"]) => void,
) {
  const transcript = createTestTranscript();
  try {
    transcript.renderSession(props.sessionKey, (session) =>
      check(() => projectChatTranscript(props, session).positionIndex),
    );
  } finally {
    transcript.dispose();
  }
}

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);
it.each([
  {
    name: "keeps completed answers and attachment landmarks",
    session: "agent:main:projection",
    tail: [
      message("commentary", "assistant", "Checking the files", 2, "run-1"),
      toolResult("tool", "File contents", 3),
      message("answer", "assistant", "The design is ready", 4, "run-1"),
      message("attachment", "user", imageContent, 5),
    ],
    selected: [0, 3, 4],
    options: {},
  },
  {
    name: "prefers final answers to later dashboard activity",
    session: "agent:main:dashboard:audit",
    tail: [
      { ...message("final", "assistant", "Design ready", 2, "run-1"), phase: "final_answer" },
      toolResult("tool-1", "File contents", 3),
      {
        ...message("tail", "assistant", "Checking result", 4, "run-1"),
        phase: "commentary",
      },
      toolResult("tool-2", "Saved", 5, "read-2"),
    ],
    selected: [0, 1],
    options: { showToolCalls: true, persistCommentary: true, runWorking: false },
  },
])("$name", ({ session, tail, selected, options }) => {
  const messages = [message("question", "user", "Inspect the design", 1), ...tail];
  const props = { ...threadProps("rail-projection", session, messages), ...options };
  withPositionIndex(props, (read) => {
    expect(read().markers.map((marker) => marker.message)).toEqual(
      selected.map((index) => messages[index]),
    );
  });
});
it.each<[string, unknown, string, number]>([
  [
    "tools and thinking only",
    [
      { type: "thinking", thinking: "Private planning" },
      { type: "toolCall", id: "read-1", name: "read", arguments: {} },
    ],
    "toolUse",
    0,
  ],
  ["tagged thinking", [{ type: "text", text: "<thinking>Plan</thinking>" }], "stop", 0],
  ["error without a response", [], "error", 0],
  ["partial error", [{ type: "text", text: "Checked section one" }], "error", 1],
  ["image-only response", imageContent, "stop", 1],
  [
    "widget-only response",
    [
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
    "stop",
    1,
  ],
])("indexes visible response content for %s", (_name, content, stopReason, assistantMarkers) => {
  const props = threadProps("rail-content", "agent:main:main", [
    message("question", "user", "Inspect the card", 1),
    {
      ...message("response", "assistant", content, 2, "run-1"),
      stopReason,
      errorMessage: stopReason === "error" ? "Request failed" : undefined,
    },
    toolResult("tool", "Read progress and result", 3),
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
  const response = (content: string) => message("response", "assistant", content, 2, "edited-run");
  const props = threadProps("rail-edited", "agent:main:main", [question, response("Visible")]);
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

it("aggregates a steered run without losing consecutive users or participants", () => {
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
    expect(index.markers.map((marker) => marker.message)).toEqual(
      [0, 1, 4, 3].map((i) => messages[i]),
    );
    expect(index.markers[2]?.anchorId).toBe("first");
    const messageOrder = ["user-1", "user-2", "first", "mira", "last"];
    expect([...index.markerIdsByMessageId.keys()]).toEqual(messageOrder);
  });
});
