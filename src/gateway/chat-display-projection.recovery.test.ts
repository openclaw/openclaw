import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { expect, it } from "vitest";
import { createPreSessionStartAnnouncePairFilter } from "./chat-display-projection.history.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { SessionHistorySseState } from "./session-history-state.js";

const user = { role: "user", content: "hello", __openclaw: { seq: 1 } };
const failed = {
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: "model unavailable",
  __openclaw: { id: "failed", seq: 2, runId: "run-a" },
};
const text = (value: string) => ({ type: "text", text: value });
const tool = { type: "toolCall", id: "partial-call", name: "read", arguments: {} };
const answer = {
  role: "assistant",
  content: [text("Recovered answer")],
  stopReason: "stop",
  __openclaw: { id: "answer", seq: 3, runId: "run-a" },
};
const projectedIds = (messages: unknown[]) =>
  projectChatDisplayMessages(messages).map((message) => message["__openclaw"]);

it.each([
  { name: "structured", content: [tool] },
  {
    name: "phased commentary",
    content: [
      {
        ...text("PRIVATE_COMMENTARY"),
        textSignature: '{"v":1,"id":"commentary","phase":"commentary"}',
      },
    ],
  },
  {
    name: "over-limit phased final",
    content: [
      {
        ...text("Partial reply ".repeat(700)),
        textSignature: '{"v":1,"id":"long","phase":"final_answer"}',
      },
    ],
  },
  { name: "string content", content: "Partial reply" },
  { name: "text alias", content: [], text: "Partial reply" },
])("retains safe incomplete-tool guidance in $name history", ({ name: _name, ...partial }) => {
  const message = {
    ...failed,
    ...partial,
    errorCode: "incomplete_tool_call",
    errorMessage: "PRIVATE_PROVIDER_DETAIL",
  };
  const original = structuredClone(message);
  const messages = projectChatDisplayMessages([user, message]);
  expect(messages.at(-1)).toMatchObject({
    stopReason: "error",
    content: expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(
          "⚠️ The provider returned an unfinished tool call. Earlier actions may have completed; verify their results before continuing.",
        ),
      }),
    ]),
  });
  const serialized = JSON.stringify(messages);
  expect(serialized).not.toContain("PRIVATE_PROVIDER_DETAIL");
  expect(serialized).not.toContain("PRIVATE_COMMENTARY");
  expect(serialized.split("The provider returned an unfinished tool call.")).toHaveLength(2);
  if (JSON.stringify(partial).includes("Partial reply")) {
    expect(serialized).toContain("Partial reply");
  }
  if (JSON.stringify(partial).includes("partial-call")) {
    expect(serialized).toContain("partial-call");
  }
  expect(projectChatDisplayMessages(messages)).toEqual(messages);
  expect(message).toEqual(original);
});

it("retires repeated non-visible failed attempts after their run answers", () => {
  const failures = Array.from({ length: 4 }, (_, attempt) => ({
    ...failed,
    content: [{ type: "input_text", text: STREAM_ERROR_FALLBACK_TEXT }],
    __openclaw: { ...failed["__openclaw"], id: "attempt-" + attempt, seq: attempt + 2 },
  }));
  const final = { ...answer, __openclaw: { ...answer["__openclaw"], seq: 6 } };
  const raw = [user, ...failures, final];
  const original = structuredClone(raw);
  expect(projectChatDisplayMessages(raw)).toEqual([user, final]);
  expect(raw).toEqual(original);
});

it.each([
  { ...answer, provider: "openclaw", model: "gateway-injected" },
  { ...answer, stopReason: "toolUse" },
])("keeps the failure without a successful runtime answer: %j", (later) => {
  expect(projectedIds([user, failed, later])).toContainEqual(failed["__openclaw"]);
});

it("keeps unattributed failures and failures separated by a new user turn", () => {
  const unattributed = { ...failed, __openclaw: { id: "failed", seq: 2 } };
  expect(projectedIds([user, unattributed, answer])).toContainEqual(unattributed["__openclaw"]);
  expect(projectedIds([user, failed, { ...user, content: "next turn" }, answer])).toContainEqual(
    failed["__openclaw"],
  );
  expect(projectedIds([user, failed])).toContainEqual(failed["__openclaw"]);
});

it("preserves partial content even when the redundant text field is empty", () => {
  const partial = { ...failed, text: "", content: [text("Partial reply")] };
  expect(projectChatDisplayMessages([user, partial, answer])[1]).toMatchObject({
    content: [text("Partial reply")],
  });
});

it("repairs only matching attempts when run identities interleave", () => {
  const other = { ...failed, __openclaw: { id: "other", seq: 3, runId: "run-b" } };
  expect(projectedIds([user, failed, other, answer])).toEqual([
    user["__openclaw"],
    other["__openclaw"],
    answer["__openclaw"],
  ]);
});

it("retires the empty failure when its fallback answer reaches the output limit", () => {
  expect(projectedIds([user, failed, { ...answer, stopReason: "length" }])).toEqual([
    user["__openclaw"],
    answer["__openclaw"],
  ]);
});

it("refreshes SSE history after an appended failure recovers", () => {
  const state = SessionHistorySseState.fromSnapshot({
    target: { sessionId: "session", sessionKey: "agent:main:test" },
    snapshot: {
      history: { items: [user], messages: [user], hasMore: false },
      rawTranscriptSeq: 1,
      turnBoundaryPending: false,
      assistantErrorPending: false,
    },
  });
  expect(state.appendInlineMessage({ message: failed, messageSeq: 2 })?.message).toMatchObject({
    stopReason: "error",
  });
  expect(state.appendInlineMessage({ message: answer, messageSeq: 3 })).toEqual({
    shouldRefresh: true,
  });
});

it("drops only old announce pairs across adjacent chunks", () => {
  const announce = {
    role: "user",
    timestamp: 10,
    content: "Earlier child finished",
    provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
  };
  const oldReply = { role: "assistant", timestamp: 11, content: "Acknowledged" };
  const newReply = { ...oldReply, timestamp: 30 };
  const rows = [announce, oldReply, announce, newReply, user];
  for (let split = 1; split < rows.length; split++) {
    const filter = createPreSessionStartAnnouncePairFilter(20);
    expect([...filter(rows.slice(0, split)), ...filter(rows.slice(split))]).toEqual([
      newReply,
      user,
    ]);
  }
});
