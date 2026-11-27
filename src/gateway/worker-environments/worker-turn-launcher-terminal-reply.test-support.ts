import type { AgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.types.js";
import type { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";

export const workerTurnTerminalReplyCases: Array<{
  name: string;
  content: Parameters<typeof makeAgentAssistantMessage>[0]["content"];
  visibleText?: string;
  rawText?: string;
  terminalReply?: AgentRunTerminalReplySnapshot;
  costs?: { first: number; last: number; total: number };
}> = [
  {
    name: "visible final answer",
    costs: { first: 0.125, last: 0.25, total: 0.375 },
    content: [
      { type: "thinking", thinking: "Private reasoning" },
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "Usage reply",
        textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
      },
    ],
    visibleText: "Usage reply",
    rawText: "Usage reply",
    terminalReply: { disposition: "visible", text: "Usage reply" },
  },
  {
    name: "mixed-case explicit silence",
    content: [{ type: "text", text: "No_Reply" }],
    visibleText: "",
    rawText: "No_Reply",
    terminalReply: { disposition: "silent" },
  },
  ...(
    [
      ["<think>Private reasoning</think>Usage reply", "Usage reply"],
      ["NO_REPLY.", "NO_REPLY."],
      ['"NO_REPLY"', '"NO_REPLY"'],
      ['{"reply":"NO_REPLY"}', '{"reply":"NO_REPLY"}'],
      ["NO_REPLY\nNO_REPLY", "NO_REPLY"],
      ["NO_REPLY\n<final></final>", ""],
      ["[[reply_to_current]]", "", false],
    ] satisfies Array<[string, string, boolean?]>
  ).map(([rawText, visibleText, preservesRawText = true]) => ({
    name: `prepared final ${JSON.stringify(rawText)}`,
    content: [{ type: "text" as const, text: rawText }],
    rawText: preservesRawText ? rawText : undefined,
    visibleText,
    terminalReply: visibleText
      ? { disposition: "visible" as const, text: visibleText }
      : { disposition: "empty" as const },
  })),
  {
    name: "reasoning-only completion",
    content: [{ type: "thinking", thinking: "Private reasoning" }],
  },
  {
    name: "tool-only completion",
    content: [{ type: "toolCall", id: "call-final", name: "read", arguments: {} }],
  },
  { name: "empty final answer", content: [] },
];
