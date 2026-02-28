import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  isValidCloudCodeAssistToolId,
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

function expectSingleToolCallRewrite(
  out: AgentMessage[],
  expectedId: string,
  mode: "strict" | "strict9",
): void {
  const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
  const toolCall = assistant.content?.[0] as { id?: string };
  expect(toolCall.id).toBe(expectedId);
  expect(isValidCloudCodeAssistToolId(toolCall.id as string, mode)).toBe(true);

  const result = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
  expect(result.toolCallId).toBe(toolCall.id);
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
          content: [{ type: "toolCall", id: "call|item:123", name: "read", arguments: {} }],
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
      // Strict mode strips all non-alphanumeric characters
      expectSingleToolCallRewrite(out, "callitem123", "strict");
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
      // Strict mode strips all non-alphanumeric characters
      expectSingleToolCallRewrite(out, "whatsapplogin17687998415271", "strict");
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
    it("is a no-op for already-valid 9-char alphanumeric IDs", () => {
      const input = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "abc123XYZ", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "abc123XYZ",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
        },
      ] as unknown as AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict9");
      expect(out).toBe(input);
    });

    it("enforces alphanumeric IDs with length 9", () => {
      const input = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_abc|item:123", name: "read", arguments: {} },
            { type: "toolCall", id: "call_abc|item:456", name: "read", arguments: {} },
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
