import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  CODE_CHARS_PER_TOKEN_ESTIMATE,
  estimateMessageTokensApprox,
  estimateMessagesTokensApprox,
  estimateTextTokenChars,
  estimateTextTokensApprox,
  estimateUnknownTokenChars,
} from "./token-approximation.js";

describe("token-approximation", () => {
  it("tracks plain English near the 4 chars per token heuristic", () => {
    const text = "OpenClaw keeps compact replies short and useful.";
    expect(estimateTextTokensApprox(text)).toBe(Math.ceil(text.length / 4));
  });

  it("inflates fenced code blocks more than prose of the same length", () => {
    const prose = "a".repeat(80);
    const code = `\`\`\`ts\n${"x".repeat(80)}\n\`\`\``;

    expect(CODE_CHARS_PER_TOKEN_ESTIMATE).toBeLessThan(4);
    expect(estimateTextTokensApprox(code)).toBeGreaterThan(estimateTextTokensApprox(prose));
  });

  it("treats CJK text closer to one token per character", () => {
    const text = "这是一个测试";
    expect(estimateTextTokensApprox(text)).toBe(text.length);
  });

  it("counts inline code more densely than surrounding prose", () => {
    const prose = "read the file at src/app.ts carefully";
    const withInlineCode = "read the file at `src/app.ts` carefully";

    expect(estimateTextTokenChars(withInlineCode)).toBeGreaterThan(estimateTextTokenChars(prose));
  });

  it("estimates assistant tool-call arguments in message totals", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tool_1",
          name: "read",
          arguments: { path: "src/index.ts", offset: 0, limit: 200 },
        },
      ],
      timestamp: Date.now(),
    } as AgentMessage;

    expect(estimateMessageTokensApprox(message)).toBeGreaterThan(12);
  });

  it("includes tool-result details in the estimate", () => {
    const withDetails = {
      role: "toolResult",
      toolCallId: "tool_1",
      toolName: "read",
      content: [{ type: "text", text: "line 1\nline 2" }],
      details: { offset: 0, truncated: false, metadata: "x".repeat(400) },
      timestamp: Date.now(),
    } as AgentMessage;
    const withoutDetails = {
      ...withDetails,
      details: undefined,
    } as AgentMessage;

    expect(estimateMessageTokensApprox(withDetails)).toBeGreaterThan(
      estimateMessageTokensApprox(withoutDetails),
    );
  });

  it("sums message arrays", () => {
    const messages = [
      { role: "user", content: "hello world", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "hi there" }], timestamp: 2 },
    ] as AgentMessage[];

    expect(estimateMessagesTokensApprox(messages)).toBe(
      estimateMessageTokensApprox(messages[0]) + estimateMessageTokensApprox(messages[1]),
    );
  });

  it("serializes unknown values before estimating", () => {
    const chars = estimateUnknownTokenChars({ query: "OpenClaw", values: [1, 2, 3] });
    expect(chars).toBeGreaterThan(0);
  });
});
