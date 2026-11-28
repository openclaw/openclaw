// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached as extractToolCards } from "../../lib/chat/tool-cards.ts";
import {
  groupsOf,
  message as chatMessage,
  messagesOf,
} from "./chat-thread-fixtures.test-support.ts";
import * as threadItems from "./chat-thread-items.ts";
import { buildItems } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";

beforeEach(() => resetChatThreadState());

const user = chatMessage.bind(null, "user");
const assistant = chatMessage.bind(null, "assistant");

function canvasToolOutput(viewId: string, title: string, preferredHeight: number): string {
  return JSON.stringify({
    kind: "canvas",
    view: {
      backend: "canvas",
      id: viewId,
      url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
      title,
      preferred_height: preferredHeight,
    },
    presentation: { target: "assistant_message" },
  });
}

it("lifts the last Canvas card, not the last result, past trailing non-Canvas output", () => {
  const first = canvasToolOutput("cv_first", "First", 240);
  const last = canvasToolOutput("cv_last", "Last", 320);
  const message = assistant(
    [
      { type: "toolcall", id: "first", name: "show_widget", arguments: {} },
      { type: "toolcall", id: "last", name: "show_widget", arguments: {} },
      {
        type: "toolresult",
        id: "last",
        name: "show_widget",
        runId: "nested-run",
        parentToolCallId: "wrapper",
        text: last,
      },
      { type: "toolresult", id: "first", name: "show_widget", text: first },
      { type: "toolresult", id: "tail", name: "read", text: "Done" },
    ],
    1_002,
  );
  const source = threadItems.extractChatMessagePreview(message);
  expect(source).toEqual({
    runId: "nested-run",
    parentToolCallId: "wrapper",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId: "cv_last",
      url: "/__openclaw__/canvas/documents/cv_last/index.html",
      title: "Last",
      preferredHeight: 320,
    },
    text: last,
    timestamp: 1_002,
  });
  expect(source?.preview).toBe(extractToolCards(message)[1]?.preview);
  const groups = groupsOf(
    buildItems({
      messages: [user("Show previews", 1_000)],
      toolMessages: [message],
      showToolCalls: false,
    }),
  );
  expect(
    messagesOf(groups)
      .flatMap((entry) => normalizeMessage(entry).content)
      .filter((block) => block.type === "canvas" && block.preview.kind === "canvas"),
  ).toEqual([{ type: "canvas", preview: source?.preview, rawText: last }]);
});

it("keeps the text fallback, absent previews, and catalog references separate", () => {
  const text = canvasToolOutput("cv_text", "Text fallback", 240);
  const fallback = assistant(text, 1_001);
  expect(extractToolCards(fallback)).toEqual([]);
  expect(threadItems.extractChatMessagePreview(fallback)).toEqual({
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId: "cv_text",
      url: "/__openclaw__/canvas/documents/cv_text/index.html",
      title: "Text fallback",
      preferredHeight: 240,
    },
    text,
    timestamp: 1_001,
  });
  expect(threadItems.extractChatMessagePreview(assistant("No preview", 1_002))).toBeNull();
  expect(
    threadItems.extractChatMessagePreview({ ...fallback, __openclaw: { catalogSource: true } }),
  ).toBeNull();
});
