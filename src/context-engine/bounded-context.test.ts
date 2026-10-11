import { describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { boundContextEngineAssembly } from "./bounded-context.js";
import type { AssembleResult } from "./types.js";

const user = (content: string, timestamp = 1) => ({ role: "user" as const, content, timestamp });
const call = () =>
  makeAssistantMessageFixture({
    content: [{ type: "toolCall", id: "repeated-id", name: "read", arguments: {} }],
    stopReason: "toolUse",
  });
const result = (text: string) => ({
  role: "toolResult" as const,
  toolCallId: "repeated-id",
  toolName: "read",
  content: [{ type: "text" as const, text }],
  isError: false,
  timestamp: 2,
});

describe("bounded context assembly", () => {
  it("drops displaced call/result occurrences together and retains the newest complete pair", () => {
    const messages = [
      user("older history ".repeat(1000)),
      call(),
      user("displaced user"),
      result("old result"),
      user("recent ask"),
      call(),
      result("recent result"),
    ];
    const original = JSON.stringify(messages);
    const assembled: AssembleResult = { messages, estimatedTokens: 10_000 };
    const cap = Buffer.byteLength(JSON.stringify(messages.slice(2))) + 1;
    const bounded = boundContextEngineAssembly(assembled, cap);
    expect(bounded.messages).toEqual(messages.slice(4));
    expect(JSON.stringify(messages)).toBe(original);
    expect(Buffer.byteLength(JSON.stringify(bounded.messages))).toBeLessThanOrEqual(cap);
  });

  it("omits an oversized latest historical turn instead of overflowing or slicing its bytes", () => {
    const assembled: AssembleResult = { messages: [user("界".repeat(500))], estimatedTokens: 500 };
    expect(boundContextEngineAssembly(assembled, 1024).messages).toEqual([]);
  });

  it.each([undefined, 4096])(
    "preserves an unchanged context and its projection below the cap (%s)",
    (cap) => {
      const assembled: AssembleResult = {
        messages: [user("recent ask")],
        estimatedTokens: 10,
        contextProjection: {
          mode: "thread_bootstrap",
          epoch: "engine-epoch",
          fingerprint: "engine-fingerprint",
        },
      };
      expect(boundContextEngineAssembly(assembled, cap, 1)).toBe(assembled);
    },
  );

  it("keeps required instructions and advances projection identity when engine context changes", () => {
    const assembled: AssembleResult = {
      messages: [user("old".repeat(1000)), user("recent")],
      estimatedTokens: 1000,
      systemPromptAddition: "Required instructions",
      contextProjection: { mode: "thread_bootstrap", epoch: "engine-epoch" },
    };
    const first = boundContextEngineAssembly(assembled, 1024);
    expect(first.systemPromptAddition).toBe(assembled.systemPromptAddition);
    expect(boundContextEngineAssembly(assembled, 1024).contextProjection).toEqual(
      first.contextProjection,
    );
    expect(
      boundContextEngineAssembly(
        {
          ...assembled,
          contextProjection: { mode: "thread_bootstrap", epoch: "next-engine-epoch" },
        },
        1024,
      ).contextProjection,
    ).not.toEqual(first.contextProjection);
    expect(
      boundContextEngineAssembly(
        { ...assembled, messages: [...assembled.messages, user("next ask", 3)] },
        1024,
      ).contextProjection,
    ).not.toEqual(first.contextProjection);
  });
});
