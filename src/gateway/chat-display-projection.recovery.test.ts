import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { describe, expect, it } from "vitest";
import { createChatHistoryRecoveryProjection } from "./chat-display-projection.core.js";
import { createPreSessionStartAnnouncePairFilter } from "./chat-display-projection.history.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { SessionHistorySseState } from "./session-history-state.js";

const user = { role: "user", content: "hello", __openclaw: { seq: 1 } };
const failed = {
  role: "assistant",
  provider: "openai",
  model: "primary",
  content: [],
  stopReason: "error",
  errorMessage: "model unavailable",
  __openclaw: { id: "failed", seq: 2, runId: "run-a" },
};
const answer = {
  role: "assistant",
  provider: "openai",
  model: "backup",
  content: [{ type: "text", text: "Recovered answer" }],
  stopReason: "stop",
  __openclaw: { id: "answer", seq: 3, runId: "run-a" },
};

function projectedIds(messages: unknown[]) {
  return projectChatDisplayMessages(messages).map((message) => message["__openclaw"]);
}

describe("recovered assistant errors", () => {
  it.each([
    { name: "empty", content: [] },
    { name: "partial text", content: [{ type: "text", text: "Partial reply" }] },
    {
      name: "structured",
      content: [{ type: "toolCall", id: "partial-call", name: "read", arguments: {} }],
    },
    {
      name: "phased final text",
      content: [
        {
          type: "text",
          text: "Partial reply",
          textSignature: '{"v":1,"id":"msg_partial","phase":"final_answer"}',
        },
      ],
    },
    {
      name: "phased commentary",
      content: [
        {
          type: "text",
          text: "PRIVATE_COMMENTARY",
          textSignature: '{"v":1,"id":"msg_commentary","phase":"commentary"}',
        },
      ],
    },
    {
      name: "over-limit partial text",
      content: [{ type: "text", text: "Partial reply ".repeat(700) }],
    },
    {
      name: "over-limit phased final",
      content: [
        {
          type: "text",
          text: "Partial reply ".repeat(700),
          textSignature: '{"v":1,"id":"msg_long","phase":"final_answer"}',
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

  it.each([
    { content: [] },
    { content: [{ type: "input_text", text: "" }] },
    { content: [{ type: "input_text", text: STREAM_ERROR_FALLBACK_TEXT }] },
    { content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }] },
    { content: [{ type: "reasoning", text: "Internal reasoning" }] },
    { content: [{ type: "redacted_thinking", data: "redacted" }] },
    { content: "" },
    { content: [{ type: "text", text: "  " }] },
    { content: [{ type: "thinking", thinking: "private reasoning" }] },
  ])("retires repeated non-visible failed attempts after their run answers: %j", ({ content }) => {
    const failures = Array.from({ length: 4 }, (_, attempt) => ({
      ...failed,
      content,
      __openclaw: { ...failed["__openclaw"], id: `attempt-${attempt}`, seq: attempt + 2 },
    }));
    const final = { ...answer, __openclaw: { ...answer["__openclaw"], seq: 6 } };
    const raw = [user, ...failures, final];
    const original = structuredClone(raw);
    expect(projectChatDisplayMessages(raw)).toEqual([user, final]);
    expect(raw).toEqual(original);
  });

  it.each([
    { ...answer, __openclaw: { ...answer["__openclaw"], runId: "run-b" } },
    { ...answer, __openclaw: { id: "answer", seq: 3 } },
    { ...answer, provider: "openclaw", model: "gateway-injected" },
    { ...answer, stopReason: "toolUse" },
    { ...answer, stopReason: "error" },
    { ...answer, stopReason: "aborted" },
    { ...answer, display: false },
  ])("keeps the failure without a successful runtime answer from its own run: %j", (later) => {
    expect(projectedIds([user, failed, later])).toContainEqual(failed["__openclaw"]);
  });

  it("keeps an unattributed failure and failures separated by a new user turn", () => {
    const unattributed = { ...failed, __openclaw: { id: "failed", seq: 2 } };
    expect(projectedIds([user, unattributed, answer])).toContainEqual(unattributed["__openclaw"]);
    expect(projectedIds([user, failed, { ...user, content: "next turn" }, answer])).toContainEqual(
      failed["__openclaw"],
    );
    expect(projectedIds([user, failed])).toContainEqual(failed["__openclaw"]);
  });

  it.each([
    { content: [{ type: "text", text: "A partial answer" }] },
    { content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
    { content: [{ type: "attachment", attachment: { kind: "document", label: "report.txt" } }] },
  ])("preserves failed attempts that already produced visible content: %j", ({ content }) => {
    expect(projectedIds([user, { ...failed, content }, answer])).toContainEqual(
      failed["__openclaw"],
    );
  });

  it("preserves partial content even when a redundant text field is empty", () => {
    const partial = { ...failed, text: "", content: [{ type: "text", text: "Partial reply" }] };
    expect(projectChatDisplayMessages([user, partial, answer])[1]).toMatchObject({
      content: [{ type: "text", text: "Partial reply" }],
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

  it.each([false, true])(
    "refreshes earlier SSE history after recovery (initial error: %s)",
    (initial) => {
      const messages = initial
        ? [
            user,
            {
              role: "assistant",
              provider: "openai",
              model: "primary",
              content: [{ type: "text", text: "The agent run failed before producing a reply." }],
              stopReason: "error",
              __openclaw: failed["__openclaw"],
            },
          ]
        : [user];
      const state = SessionHistorySseState.fromSnapshot({
        target: { sessionId: "session", sessionKey: "agent:main:test" },
        snapshot: {
          history: { items: messages, messages, hasMore: false },
          rawTranscriptSeq: initial ? 2 : 1,
          turnBoundaryPending: false,
          assistantErrorPending: initial,
        },
      });
      if (!initial) {
        expect(
          state.appendInlineMessage({ message: failed, messageSeq: 2 })?.message,
        ).toMatchObject({
          stopReason: "error",
        });
      }
      expect(state.appendInlineMessage({ message: answer, messageSeq: 3 })).toEqual({
        shouldRefresh: true,
      });
    },
  );
});

describe("appended history recovery", () => {
  it("reconciles an earlier delivery mirror after its tool result arrives in another chunk", () => {
    const call = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "send",
          name: "message",
          arguments: { action: "send", message: "Delivered" },
        },
      ],
      __openclaw: { id: "call" },
    };
    const delivery = {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "Delivered" }],
      openclawDeliveryMirror: { kind: "message-tool-source-reply", toolCallId: "send" },
      __openclaw: { id: "delivery" },
    };
    const result = {
      role: "toolResult",
      toolName: "message",
      toolCallId: "send",
      content: { ok: true },
      __openclaw: { id: "result" },
    };
    const rows = [user, failed, call, delivery, result, answer];
    const original = structuredClone(rows);
    for (let split = 1; split < rows.length; split++) {
      const projection = createChatHistoryRecoveryProjection();
      projection.append(rows.slice(0, split));
      projection.append(rows.slice(split));
      const recovered = projection.result();
      expect(recovered.pending).toBe(false);
      expect(recovered.recoveryObserved).toBe(true);
      expect(recovered.messages).toEqual([
        user,
        call,
        { ...delivery, display: false },
        result,
        {
          role: "assistant",
          content: delivery.content,
          openclawMessageToolMirror: { toolName: "message", toolCallId: "send" },
          __openclaw: delivery["__openclaw"],
        },
        answer,
      ]);
    }
    expect(rows).toEqual(original);
  });

  it("drops only old announce pairs when the adjacent assistant starts a later chunk", () => {
    const announce = {
      role: "user",
      timestamp: 10,
      provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      content: "Earlier child finished",
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
});
