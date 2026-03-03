import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  extractToolCallsFromAssistant,
  sanitizeToolCallIdsForCloudCodeAssist,
} from "./tool-call-id.js";

describe("sanitizeToolCallIdsForCloudCodeAssist name preservation", () => {
  it("preserves tool names in assistant tool call blocks", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_123|fc_456", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_123|fc_456",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallIdsForCloudCodeAssist(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as { id?: string; name?: string };

    expect(toolCall.id).toBe("call123fc456");
    expect(toolCall.name).toBe("read");

    const toolResult = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.toolName).toBe("read");
  });
});

describe("extractToolCallsFromAssistant empty name handling", () => {
  it("treats empty string names as undefined (issue #33438)", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_123", name: "", arguments: {} }],
    } as Extract<AgentMessage, { role: "assistant" }>;

    const toolCalls = extractToolCallsFromAssistant(msg);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("call_123");
    expect(toolCalls[0].name).toBeUndefined();
  });

  it("trims whitespace from tool names", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_123", name: "  read  ", arguments: {} }],
    } as Extract<AgentMessage, { role: "assistant" }>;

    const toolCalls = extractToolCallsFromAssistant(msg);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("call_123");
    expect(toolCalls[0].name).toBe("read");
  });

  it("treats whitespace-only names as undefined", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_123", name: "   ", arguments: {} }],
    } as Extract<AgentMessage, { role: "assistant" }>;

    const toolCalls = extractToolCallsFromAssistant(msg);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("call_123");
    expect(toolCalls[0].name).toBeUndefined();
  });

  it("preserves valid tool names", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_123", name: "read", arguments: {} }],
    } as Extract<AgentMessage, { role: "assistant" }>;

    const toolCalls = extractToolCallsFromAssistant(msg);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("call_123");
    expect(toolCalls[0].name).toBe("read");
  });
});
