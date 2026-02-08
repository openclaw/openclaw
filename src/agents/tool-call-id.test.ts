import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  isValidCloudCodeAssistToolId,
  sanitizeToolCallIdsForCloudCodeAssist,
} from "./tool-call-id.js";

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
      ] satisfies AgentMessage[];

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
      ] satisfies AgentMessage[];

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
      const input = [
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
      ] satisfies AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input);
      expect(out).not.toBe(input);

      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const a = assistant.content?.[0] as { id?: string };
      const b = assistant.content?.[1] as { id?: string };
      expect(typeof a.id).toBe("string");
      expect(typeof b.id).toBe("string");
      expect(a.id).not.toBe(b.id);
      expect(isValidCloudCodeAssistToolId(a.id as string, "strict")).toBe(true);
      expect(isValidCloudCodeAssistToolId(b.id as string, "strict")).toBe(true);

      const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(r1.toolCallId).toBe(a.id);
      expect(r2.toolCallId).toBe(b.id);
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
      ] satisfies AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input);
      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const a = assistant.content?.[0] as { id?: string };
      const b = assistant.content?.[1] as { id?: string };

      expect(typeof a.id).toBe("string");
      expect(typeof b.id).toBe("string");
      expect(a.id).not.toBe(b.id);
      expect(a.id?.length).toBeLessThanOrEqual(40);
      expect(b.id?.length).toBeLessThanOrEqual(40);
      expect(isValidCloudCodeAssistToolId(a.id as string, "strict")).toBe(true);
      expect(isValidCloudCodeAssistToolId(b.id as string, "strict")).toBe(true);

      const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(r1.toolCallId).toBe(a.id);
      expect(r2.toolCallId).toBe(b.id);
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
      ] satisfies AgentMessage[];

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
      const input = [
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
      ] satisfies AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict");
      expect(out).not.toBe(input);

      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const a = assistant.content?.[0] as { id?: string };
      const b = assistant.content?.[1] as { id?: string };
      expect(typeof a.id).toBe("string");
      expect(typeof b.id).toBe("string");
      expect(a.id).not.toBe(b.id);
      // Both should be strictly alphanumeric
      expect(isValidCloudCodeAssistToolId(a.id as string, "strict")).toBe(true);
      expect(isValidCloudCodeAssistToolId(b.id as string, "strict")).toBe(true);
      // Should not contain underscores or hyphens
      expect(a.id).not.toMatch(/[_-]/);
      expect(b.id).not.toMatch(/[_-]/);

      const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(r1.toolCallId).toBe(a.id);
      expect(r2.toolCallId).toBe(b.id);
    });
  });

  describe("strict9 mode (Mistral tool call IDs)", () => {
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
      ] satisfies AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict9");
      expect(out).not.toBe(input);

      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const a = assistant.content?.[0] as { id?: string };
      const b = assistant.content?.[1] as { id?: string };

      expect(typeof a.id).toBe("string");
      expect(typeof b.id).toBe("string");
      expect(a.id).not.toBe(b.id);
      expect(a.id?.length).toBe(9);
      expect(b.id?.length).toBe(9);
      expect(isValidCloudCodeAssistToolId(a.id as string, "strict9")).toBe(true);
      expect(isValidCloudCodeAssistToolId(b.id as string, "strict9")).toBe(true);

      const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(r1.toolCallId).toBe(a.id);
      expect(r2.toolCallId).toBe(b.id);
    });
  });

  describe("anthropic mode (Claude tool_use.id pattern)", () => {
    it("preserves underscores and hyphens in tool call IDs", () => {
      const input = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_abc-123", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "call_abc-123",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
        },
      ] satisfies AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "anthropic");
      // Input is already valid, should be unchanged
      expect(out).toBe(input);
    });

    it("strips pipe and colon characters from Kimi-K2 style IDs", () => {
      // Kimi-K2 generates IDs like: call_vgwbGBht9FiGQwYB1Qxq1qjD|fc_06ea39884e58
      const input = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_vgwbGBht|fc_06ea39", name: "read", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_vgwbGBht|fc_06ea39",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
        },
      ] satisfies AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "anthropic");
      expect(out).not.toBe(input);

      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const toolCall = assistant.content?.[0] as { id?: string };
      // Anthropic mode strips | but keeps _ and -
      expect(toolCall.id).toBe("call_vgwbGBhtfc_06ea39");
      expect(isValidCloudCodeAssistToolId(toolCall.id as string, "anthropic")).toBe(true);

      const result = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(result.toolCallId).toBe(toolCall.id);
    });

    it("handles OpenAI Codex style IDs with pipe separator", () => {
      // Codex generates IDs like: call_vgwbGBht9FiGQwYB1Qxq1qjD|fc_06ea39884e58ce8501696cc853d0708191aedd41fa5859eb31
      const input = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_abc123|fc_def456", name: "exec", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "call_abc123|fc_def456",
          toolName: "exec",
          content: [{ type: "text", text: "done" }],
        },
      ] satisfies AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "anthropic");
      expect(out).not.toBe(input);

      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const toolCall = assistant.content?.[0] as { id?: string };
      expect(toolCall.id).toBe("call_abc123fc_def456");
      // Verify it matches Claude's pattern
      expect(toolCall.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    });
  });
});
