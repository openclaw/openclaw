import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sanitizeToolCallId,
  sanitizeToolCallIdsForCloudCodeAssist,
  isValidCloudCodeAssistToolId,
} from "./tool-call-id.js";
import { resolveTranscriptPolicy } from "./transcript-policy.js";

describe("Tool Call ID Provider Switching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Single Provider Scenarios", () => {
    it("maintains valid IDs when staying on Google provider", () => {
      const rawId = `call_${Date.now()}`;
      const googlePolicy = resolveTranscriptPolicy({
        modelApi: "gemini",
        provider: "google",
        modelId: "gemini-2.0-flash-thinking-exp",
      });
      const mode = googlePolicy.toolCallIdMode ?? "strict";
      const sanitized = sanitizeToolCallId(rawId, mode);

      // Create transcript with sanitized ID
      const messages: AgentMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: sanitized,
              name: "testTool",
              arguments: {},
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: sanitized,
          toolName: "testTool",
          content: [{ type: "text", text: "result" }],
        },
      ];

      // Verify IDs match
      const toolCall = messages[0].content[0] as unknown as { type?: string; id?: string };
      const toolResult = messages[1];
      expect(toolCall.id).toBe(sanitized);
      expect(toolResult.toolCallId).toBe(sanitized);
      expect(isValidCloudCodeAssistToolId(sanitized, mode)).toBe(true);
    });

    it("maintains valid IDs when staying on Mistral provider", () => {
      const rawId = `call_${Date.now()}`;
      const mistralPolicy = resolveTranscriptPolicy({
        modelApi: "openai-completions",
        provider: "mistral",
        modelId: "mistral-large",
      });
      const mode = mistralPolicy.toolCallIdMode ?? "strict9";
      const sanitized = sanitizeToolCallId(rawId, mode);

      const messages: AgentMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: sanitized,
              name: "testTool",
              arguments: {},
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: sanitized,
          toolName: "testTool",
          content: [{ type: "text", text: "result" }],
        },
      ];

      const toolCall = messages[0].content[0] as unknown as { type?: string; id?: string };
      const toolResult = messages[1];
      expect(toolCall.id).toBe(sanitized);
      expect(toolResult.toolCallId).toBe(sanitized);
      expect(isValidCloudCodeAssistToolId(sanitized, mode)).toBe(true);
      expect(sanitized).toHaveLength(9);
    });
  });

  describe("Provider Switching Scenarios", () => {
    it("handles OpenAI → Google provider switch", () => {
      // Step 1: Generate ID on OpenAI (allows underscores)
      const rawId = `call_${Date.now()}`;
      const openaiSanitized = sanitizeToolCallId(rawId, "strict"); // Still sanitize for safety

      // Step 2: Create transcript with OpenAI ID
      const initialMessages: AgentMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: openaiSanitized,
              name: "testTool",
              arguments: {},
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: openaiSanitized,
          toolName: "testTool",
          content: [{ type: "text", text: "result" }],
        },
      ];

      // Step 3: Switch to Google provider (strict mode)
      const googlePolicy = resolveTranscriptPolicy({
        modelApi: "gemini",
        provider: "google",
        modelId: "gemini-2.0-flash-thinking-exp",
      });
      const googleMode = googlePolicy.toolCallIdMode ?? "strict";

      // Step 4: Sanitize for Google
      const googleSanitized = sanitizeToolCallIdsForCloudCodeAssist(initialMessages, googleMode);

      // Verify IDs still match after sanitization
      const toolCall = googleSanitized[0].content[0] as unknown as { type?: string; id?: string };
      const toolResult = googleSanitized[1];
      expect(toolCall.id).toBe(toolResult.toolCallId);
      expect(isValidCloudCodeAssistToolId(toolCall.id, googleMode)).toBe(true);
    });

    it("handles Google → Mistral provider switch", () => {
      // Step 1: Generate ID on Google (strict mode)
      const rawId = `call_${Date.now()}`;
      const googlePolicy = resolveTranscriptPolicy({
        modelApi: "gemini",
        provider: "google",
        modelId: "gemini-2.0-flash-thinking-exp",
      });
      const googleMode = googlePolicy.toolCallIdMode ?? "strict";
      const googleSanitized = sanitizeToolCallId(rawId, googleMode);

      // Step 2: Create transcript
      const initialMessages: AgentMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: googleSanitized,
              name: "testTool",
              arguments: {},
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: googleSanitized,
          toolName: "testTool",
          content: [{ type: "text", text: "result" }],
        },
      ];

      // Step 3: Switch to Mistral (strict9 mode)
      const mistralPolicy = resolveTranscriptPolicy({
        modelApi: "openai-completions",
        provider: "mistral",
        modelId: "mistral-large",
      });
      const mistralMode = mistralPolicy.toolCallIdMode ?? "strict9";

      // Step 4: Sanitize for Mistral
      const mistralSanitized = sanitizeToolCallIdsForCloudCodeAssist(initialMessages, mistralMode);

      // Verify IDs match and are valid
      const toolCall = mistralSanitized[0].content[0] as unknown as { type?: string; id?: string };
      const toolResult = mistralSanitized[1];
      expect(toolCall.id).toBe(toolResult.toolCallId);
      expect(isValidCloudCodeAssistToolId(toolCall.id, mistralMode)).toBe(true);
      expect(toolCall.id).toHaveLength(9);
    });

    it("handles multiple provider switches in sequence", () => {
      const providers = [
        {
          name: "openai",
          api: "openai-responses",
          mode: "strict" as const,
        },
        {
          name: "google",
          api: "gemini",
          mode: "strict" as const,
        },
        {
          name: "mistral",
          api: "openai-completions",
          mode: "strict9" as const,
        },
        {
          name: "openai",
          api: "openai-responses",
          mode: "strict" as const,
        },
      ];

      let messages: AgentMessage[] = [];
      let currentId = `call_${Date.now()}`;

      for (const provider of providers) {
        const policy = resolveTranscriptPolicy({
          modelApi: provider.api,
          provider: provider.name,
          modelId: "test-model",
        });
        const mode = policy.toolCallIdMode ?? provider.mode;
        const sanitized = sanitizeToolCallId(currentId, mode);

        // Create message with sanitized ID
        const newMessages: AgentMessage[] = [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: sanitized,
                name: "testTool",
                arguments: {},
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: sanitized,
            toolName: "testTool",
            content: [{ type: "text", text: "result" }],
          },
        ];

        // Apply sanitization
        messages = sanitizeToolCallIdsForCloudCodeAssist(newMessages, mode);
        currentId = (messages[0].content[0] as unknown as { type?: string; id?: string }).id;

        // Verify consistency
        const toolCall = messages[0].content[0] as unknown as { type?: string; id?: string };
        const toolResult = messages[1];
        expect(toolCall.id).toBe(toolResult.toolCallId);
        expect(isValidCloudCodeAssistToolId(toolCall.id, mode)).toBe(true);
      }
    });
  });

  describe("ID Collision Prevention During Switching", () => {
    it("prevents collisions when sanitizing creates duplicates", () => {
      // Create two different IDs that would collide after removing special chars
      const messages: AgentMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_a_b_c",
              name: "tool1",
              arguments: {},
            },
            {
              type: "toolCall",
              id: "call_a:b:c",
              name: "tool2",
              arguments: {},
            },
          ],
        },
      ];

      const sanitized = sanitizeToolCallIdsForCloudCodeAssist(messages, "strict");
      const toolCall1 = sanitized[0].content[0] as unknown as { type?: string; id?: string };
      const toolCall2 = sanitized[0].content[1] as unknown as { type?: string; id?: string };

      // IDs should be different (no collision) even though they look similar after stripping
      expect(toolCall1.id).not.toBe(toolCall2.id);
      expect(isValidCloudCodeAssistToolId(toolCall1.id, "strict")).toBe(true);
      expect(isValidCloudCodeAssistToolId(toolCall2.id, "strict")).toBe(true);
    });

    it("maintains ID mapping stability during switches", () => {
      const originalId = `call_${Date.now()}`;
      const messages: AgentMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: originalId,
              name: "testTool",
              arguments: {},
            },
          ],
        },
      ];

      // Apply sanitization twice (simulating provider switch back)
      const sanitized1 = sanitizeToolCallIdsForCloudCodeAssist(messages, "strict");
      const sanitized2 = sanitizeToolCallIdsForCloudCodeAssist(sanitized1, "strict");

      const toolCall1 = sanitized1[0].content[0] as unknown as { type?: string; id?: string };
      const toolCall2 = sanitized2[0].content[0] as unknown as { type?: string; id?: string };

      // ID should remain stable (no double-sanitization artifacts)
      expect(toolCall1.id).toBe(toolCall2.id);
      expect(isValidCloudCodeAssistToolId(toolCall1.id, "strict")).toBe(true);
    });
  });

  describe("Edge Cases in Switching", () => {
    it("handles switching from provider with long IDs to strict9", () => {
      // Long ID from OpenAI/Google
      const longId = "call_" + "a".repeat(50);

      const messages: AgentMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: longId,
              name: "testTool",
              arguments: {},
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: longId,
          toolName: "testTool",
          content: [{ type: "text", text: "result" }],
        },
      ];

      // Switch to Mistral (strict9)
      const sanitized = sanitizeToolCallIdsForCloudCodeAssist(messages, "strict9");
      const toolCall = sanitized[0].content[0] as unknown as { type?: string; id?: string };
      const toolResult = sanitized[1];

      expect(toolCall.id).toBe(toolResult.toolCallId);
      expect(isValidCloudCodeAssistToolId(toolCall.id, "strict9")).toBe(true);
      expect(toolCall.id).toHaveLength(9);
    });

    it("preserves IDs when no sanitization needed", () => {
      const alphanumericId = "call1234567890";

      const messages: AgentMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: alphanumericId,
              name: "testTool",
              arguments: {},
            },
          ],
        },
      ];

      // No change expected (already valid)
      const sanitized = sanitizeToolCallIdsForCloudCodeAssist(messages, "strict");
      const toolCall = sanitized[0].content[0] as unknown as { type?: string; id?: string };

      expect(toolCall.id).toBe(alphanumericId);
    });
  });
});
