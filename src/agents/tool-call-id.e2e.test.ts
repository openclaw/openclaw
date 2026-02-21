import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  isValidCloudCodeAssistToolId,
  normalizeToolCallArguments,
  sanitizeToolCallIdsForCloudCodeAssist,
} from "./tool-call-id.js";

const buildDuplicateIdCollisionInput = () =>
  [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_a|b", name: "read", arguments: {} },
        { type: "toolCall", id: "call_a:b", name: "read", arguments: {} },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call_a|b",
      toolName: "read",
      content: [{ type: "text", text: "one" }],
    },
    {
      role: "toolResult",
      toolCallId: "call_a:b",
      toolName: "read",
      content: [{ type: "text", text: "two" }],
    },
  ] as unknown as AgentMessage[];

function expectCollisionIdsRemainDistinct(
  out: AgentMessage[],
  mode: "strict" | "strict9",
): { aId: string; bId: string } {
  const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
  const a = assistant.content?.[0] as { id?: string };
  const b = assistant.content?.[1] as { id?: string };
  expect(typeof a.id).toBe("string");
  expect(typeof b.id).toBe("string");
  expect(a.id).not.toBe(b.id);
  expect(isValidCloudCodeAssistToolId(a.id as string, mode)).toBe(true);
  expect(isValidCloudCodeAssistToolId(b.id as string, mode)).toBe(true);

  const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
  const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;
  expect(r1.toolCallId).toBe(a.id);
  expect(r2.toolCallId).toBe(b.id);
  return { aId: a.id as string, bId: b.id as string };
}

describe("sanitizeToolCallIdsForCloudCodeAssist", () => {
  describe("strict mode (default)", () => {
    it("is a no-op for already-valid non-colliding IDs", () => {
      const input = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call1", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "call1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
        },
      ] as unknown as AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input);
      expect(out).toBe(input);
    });

    it("strips non-alphanumeric characters from tool call IDs", () => {
      const input = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call|item:123",
              name: "read",
              arguments: {},
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call|item:123",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
        },
      ] as unknown as AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input);
      expect(out).not.toBe(input);

      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const toolCall = assistant.content?.[0] as { id?: string };
      // Strict mode strips all non-alphanumeric characters
      expect(toolCall.id).toBe("callitem123");
      expect(isValidCloudCodeAssistToolId(toolCall.id as string, "strict")).toBe(true);

      const result = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(result.toolCallId).toBe(toolCall.id);
    });

    it("avoids collisions when sanitization would produce duplicate IDs", () => {
      const input = buildDuplicateIdCollisionInput();

      const out = sanitizeToolCallIdsForCloudCodeAssist(input);
      expect(out).not.toBe(input);
      expectCollisionIdsRemainDistinct(out, "strict");
    });

    it("caps tool call IDs at 40 chars while preserving uniqueness", () => {
      const longA = `call_${"a".repeat(60)}`;
      const longB = `call_${"a".repeat(59)}b`;
      const input = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: longA, name: "read", arguments: {} },
            { type: "toolCall", id: longB, name: "read", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: longA,
          toolName: "read",
          content: [{ type: "text", text: "one" }],
        },
        {
          role: "toolResult",
          toolCallId: longB,
          toolName: "read",
          content: [{ type: "text", text: "two" }],
        },
      ] as unknown as AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input);
      const { aId, bId } = expectCollisionIdsRemainDistinct(out, "strict");
      expect(aId.length).toBeLessThanOrEqual(40);
      expect(bId.length).toBeLessThanOrEqual(40);
    });
  });

  describe("strict mode (alphanumeric only)", () => {
    it("strips underscores and hyphens from tool call IDs", () => {
      const input = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "whatsapp_login_1768799841527_1",
              name: "login",
              arguments: {},
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "whatsapp_login_1768799841527_1",
          toolName: "login",
          content: [{ type: "text", text: "ok" }],
        },
      ] as unknown as AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict");
      expect(out).not.toBe(input);

      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const toolCall = assistant.content?.[0] as { id?: string };
      // Strict mode strips all non-alphanumeric characters
      expect(toolCall.id).toBe("whatsapplogin17687998415271");
      expect(isValidCloudCodeAssistToolId(toolCall.id as string, "strict")).toBe(true);

      const result = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(result.toolCallId).toBe(toolCall.id);
    });

    it("avoids collisions with alphanumeric-only suffixes", () => {
      const input = buildDuplicateIdCollisionInput();

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict");
      expect(out).not.toBe(input);
      const { aId, bId } = expectCollisionIdsRemainDistinct(out, "strict");
      // Should not contain underscores or hyphens
      expect(aId).not.toMatch(/[_-]/);
      expect(bId).not.toMatch(/[_-]/);
    });
  });

  describe("strict9 mode (Mistral tool call IDs)", () => {
    it("enforces alphanumeric IDs with length 9", () => {
      const input = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_abc|item:123",
              name: "read",
              arguments: {},
            },
            {
              type: "toolCall",
              id: "call_abc|item:456",
              name: "read",
              arguments: {},
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_abc|item:123",
          toolName: "read",
          content: [{ type: "text", text: "one" }],
        },
        {
          role: "toolResult",
          toolCallId: "call_abc|item:456",
          toolName: "read",
          content: [{ type: "text", text: "two" }],
        },
      ] as unknown as AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict9");
      expect(out).not.toBe(input);
      const { aId, bId } = expectCollisionIdsRemainDistinct(out, "strict9");
      expect(aId.length).toBe(9);
      expect(bId.length).toBe(9);
    });
  });
});

describe("normalizeToolCallArguments", () => {
  it("is a no-op when arguments have no null values", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call1",
            name: "read",
            arguments: { path: "/tmp" },
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).toBe(input);
  });

  it("removes null-valued properties from tool call arguments", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call1",
            name: "bash",
            arguments: { command: "ls", timeout: null, cwd: undefined },
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as {
      arguments?: Record<string, unknown>;
    };
    expect(toolCall.arguments).toEqual({ command: "ls" });
    expect("timeout" in (toolCall.arguments ?? {})).toBe(false);
    expect("cwd" in (toolCall.arguments ?? {})).toBe(false);
  });

  it("handles real Infercom/Llama 3.3 tool call with null tags array", () => {
    // Real scenario: Llama 3.3 70B returns {"message": "hello", "recipient": "Umut", "tags": null}
    // OpenClaw validation expects tags to be omitted or a valid array, not null
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_send_message",
            name: "send_message",
            arguments: { message: "hello", recipient: "Umut", tags: null },
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as {
      arguments?: Record<string, unknown>;
    };
    // tags: null should be removed, leaving only message and recipient
    expect(toolCall.arguments).toEqual({ message: "hello", recipient: "Umut" });
    expect("tags" in (toolCall.arguments ?? {})).toBe(false);
  });

  it("converts undefined arguments to empty object", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call1",
            name: "status",
            arguments: undefined,
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as {
      arguments?: Record<string, unknown>;
    };
    expect(toolCall.arguments).toEqual({});
  });

  it("converts null arguments to empty object", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call1", name: "status", arguments: null }],
      },
    ] as unknown as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as {
      arguments?: Record<string, unknown>;
    };
    expect(toolCall.arguments).toEqual({});
  });

  it("recursively removes null values in nested objects", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call1",
            name: "config",
            arguments: {
              settings: {
                enabled: true,
                timeout: null,
                nested: { value: "test", empty: null },
              },
            },
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as {
      arguments?: Record<string, unknown>;
    };
    expect(toolCall.arguments).toEqual({
      settings: {
        enabled: true,
        nested: { value: "test" },
      },
    });
  });

  it("handles multiple tool calls in single message", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call1",
            name: "read",
            arguments: { path: "/a", extra: null },
          },
          {
            type: "toolCall",
            id: "call2",
            name: "write",
            arguments: { path: "/b" },
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const tc1 = assistant.content?.[0] as {
      arguments?: Record<string, unknown>;
    };
    const tc2 = assistant.content?.[1] as {
      arguments?: Record<string, unknown>;
    };
    expect(tc1.arguments).toEqual({ path: "/a" });
    expect(tc2.arguments).toEqual({ path: "/b" });
  });

  it("handles toolUse and functionCall block types", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call1",
            name: "read",
            arguments: { opt: null },
          },
          {
            type: "functionCall",
            id: "call2",
            name: "write",
            arguments: { opt: null },
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const tc1 = assistant.content?.[0] as {
      arguments?: Record<string, unknown>;
    };
    const tc2 = assistant.content?.[1] as {
      arguments?: Record<string, unknown>;
    };
    expect(tc1.arguments).toEqual({});
    expect(tc2.arguments).toEqual({});
  });

  it("preserves non-assistant messages unchanged", () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call1",
            name: "read",
            arguments: { opt: null },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
      },
    ] as unknown as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out[0]).toBe(input[0]);
    expect(out[2]).toBe(input[2]);
  });

  it("does not synthesize arguments when field is completely missing", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call1", name: "status" }],
      },
    ] as unknown as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    // Should be unchanged - no arguments field added
    expect(out).toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as unknown as Record<string, unknown>;
    expect("arguments" in toolCall).toBe(false);
    expect("args" in toolCall).toBe(false);
  });
});
