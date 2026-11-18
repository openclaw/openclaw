import { expect, it, vi } from "vitest";
import { buildCurrentConversationContextBlock } from "./run-current-context.js";

const contextParams = {
  agentId: "main",
  sourceSessionEntry: { sessionId: "source-session", updatedAt: 0 },
  sourceSessionKey: "agent:main:telegram:direct:42",
  storePath: "/tmp/store.sqlite",
};

async function buildContext(messages: unknown[] | Error) {
  return await buildCurrentConversationContextBlock(contextParams, {
    readSessionMessages:
      messages instanceof Error
        ? vi.fn().mockRejectedValue(messages)
        : vi.fn().mockResolvedValue(messages),
  });
}

function assistantText(text: string, phase: string) {
  return {
    type: "text",
    text,
    textSignature: JSON.stringify({ v: 1, id: `item_${phase}`, phase }),
  };
}

it("keeps recent user and assistant text while filtering other roles and empty content", async () => {
  await expect(
    buildContext([
      { role: "system", content: "system prompt" },
      { role: "user", content: " first\n fact " },
      { role: "tool", content: "tool result" },
      { role: "assistant", content: [{ type: "text", text: "noted" }] },
      { role: "assistant", content: [{ type: "toolCall", name: "search" }] },
      { role: "user", content: "  " },
    ]),
  ).resolves.toBe("Recent conversation:\n- User: first fact\n- Assistant: noted");
});

it("projects raw transcript envelopes and assistant phases before truncation", async () => {
  await expect(
    buildContext([
      {
        role: "user",
        content: "Conversation info: ⟦openclaw:ctx⟧\n```json\n{}\n```\n\nActual user fact",
      },
      ...Array.from({ length: 15 }, () => ({ role: "toolResult", content: "tool output" })),
      {
        role: "assistant",
        content: [
          assistantText("internal reasoning", "commentary"),
          assistantText("Visible answer", "final_answer"),
        ],
      },
    ]),
  ).resolves.toBe("Recent conversation:\n- User: Actual user fact\n- Assistant: Visible answer");
});

it("caps line and block sizes while retaining the newest messages in order", async () => {
  const context = await buildContext(
    Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}:${"x".repeat(300)}`,
    })),
  );
  expect(context).toBeDefined();
  const lines = context?.split("\n") ?? [];
  expect(context?.length).toBeLessThanOrEqual(1400);
  expect(lines.slice(1).every((line) => line.length <= 220)).toBe(true);
  const indexes = lines.slice(1).map((line) => line.match(/^- (?:User|Assistant): (\d+):/u)?.[1]);
  expect(indexes).toEqual("6 7 8 9 10 11".split(" "));
});

it("ignores empty and unreadable transcripts", async () => {
  await expect(buildContext([])).resolves.toBeUndefined();
  await expect(buildContext(new Error("unreadable"))).resolves.toBeUndefined();
});
