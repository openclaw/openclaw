// Tool-call id tests cover provider-safe rewrites, collision handling, replay
// preservation for signed thinking turns, and strict short-id mode.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessages } from "./test-helpers/agent-message-fixtures.js";
import { sparseAssistant } from "./test-helpers/sparse-transcript.test-support.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "./tool-call-id.js";

const readToolCall = (id: string) => ({
  type: "toolCall" as const,
  id,
  name: "read",
  arguments: {},
});

const buildToolResult = (params: {
  toolCallId: string;
  text: string;
  toolName?: string;
  toolUseId?: string;
}) => ({
  role: "toolResult" as const,
  toolCallId: params.toolCallId,
  ...(params.toolUseId ? { toolUseId: params.toolUseId } : {}),
  toolName: params.toolName ?? "read",
  content: [{ type: "text" as const, text: params.text }],
});

function sanitizeSingleToolCallId(id: string, mode: "strict" | "strict9" = "strict"): string {
  const out = sanitizeToolCallIdsForCloudCodeAssist(
    castAgentMessages([
      sparseAssistant([{ type: "toolCall", id, name: "read", arguments: {} }]),
      buildToolResult({ toolCallId: id, text: "ok" }),
    ]),
    mode,
  );
  const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
  const toolCall = assistant.content?.[0] as { id?: string };
  if (!toolCall.id) {
    throw new Error("expected sanitized tool-call id");
  }
  return toolCall.id;
}

const signedReadAssistant = (signature: string, id: string) => ({
  role: "assistant" as const,
  content: [
    { type: "thinking" as const, thinking: "internal", thinkingSignature: signature },
    readToolCall(id),
  ],
});

const buildRepeatedEditIdInput = (params: { includeToolUseId?: boolean } = {}) =>
  castAgentMessages([
    sparseAssistant([
      { type: "toolCall", id: "edit:22", name: "edit", arguments: {} },
      { type: "toolCall", id: "edit:22", name: "edit", arguments: {} },
    ]),
    buildToolResult({
      toolCallId: "edit:22",
      toolName: "edit",
      ...(params.includeToolUseId ? { toolUseId: "edit:22" } : {}),
      text: "one",
    }),
    buildToolResult({
      toolCallId: "edit:22",
      toolName: "edit",
      ...(params.includeToolUseId ? { toolUseId: "edit:22" } : {}),
      text: "two",
    }),
  ]);

const buildRepeatedSharedToolResultIdInput = () =>
  buildRepeatedEditIdInput({ includeToolUseId: true });

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
  expect(sanitizeSingleToolCallId(a.id as string, mode)).toBe(a.id);
  expect(sanitizeSingleToolCallId(b.id as string, mode)).toBe(b.id);

  const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
  const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;
  expect(r1.toolCallId).toBe(a.id);
  expect(r2.toolCallId).toBe(b.id);
  return { aId: a.id as string, bId: b.id as string };
}

function expectToolUseIdsFollowDistinctToolCallIds(
  out: AgentMessage[],
  mode: "strict" | "strict9",
): { aId: string; bId: string } {
  const ids = expectCollisionIdsRemainDistinct(out, mode);
  const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }> & { toolUseId?: string };
  const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }> & { toolUseId?: string };
  expect(r1.toolUseId).toBe(ids.aId);
  expect(r2.toolUseId).toBe(ids.bId);
  return ids;
}

function expectStrict9IdLengths(ids: { aId: string; bId: string }) {
  expect(ids.aId.length).toBe(9);
  expect(ids.bId.length).toBe(9);
}

function expectDistinctStrict9Ids(out: AgentMessage[], input: AgentMessage[]) {
  expect(out).not.toBe(input);
  const ids = expectCollisionIdsRemainDistinct(out, "strict9");
  expectStrict9IdLengths(ids);
}

function expectReplaySafeSignedTurnOwnership(params: {
  input: AgentMessage[];
  preservedTurn: "first" | "second";
  firstToolCallIndex: number;
}) {
  // Signed thinking blocks bind the following tool call; replay repair may keep
  // only the safe turn's id and must rewrite the colliding sibling turn.
  const out = sanitizeToolCallIdsForCloudCodeAssist(params.input, "strict", {
    preserveReplaySafeThinkingToolCallIds: true,
    allowedToolNames: ["read"],
  });

  expect(out).not.toBe(params.input);
  const firstAssistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
  const secondAssistant = out[2] as Extract<AgentMessage, { role: "assistant" }>;
  const firstToolCall = firstAssistant.content?.[params.firstToolCallIndex] as { id?: string };
  const secondToolCall = secondAssistant.content?.[1] as { id?: string };

  if (params.preservedTurn === "first") {
    expect(firstToolCall.id).toBe("call1");
    expect(secondToolCall.id).not.toBe("call1");
    expect((out[1] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe("call1");
    expect((out[3] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe(
      secondToolCall.id,
    );
  } else {
    expect(firstToolCall.id).not.toBe("call1");
    expect(secondToolCall.id).toBe("call1");
    expect((out[1] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe(
      firstToolCall.id,
    );
    expect((out[3] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe("call1");
  }

  expect(firstToolCall.id).not.toBe(secondToolCall.id);
}

describe("sanitizeToolCallIdsForCloudCodeAssist", () => {
  describe("strict mode (default)", () => {
    it("caps tool call IDs at 40 chars while preserving uniqueness", () => {
      const longA = `call_${"a".repeat(60)}`;
      const longB = `call_${"a".repeat(59)}b`;
      const input = castAgentMessages([
        sparseAssistant([
          { type: "toolCall", id: longA, name: "read", arguments: {} },
          { type: "toolCall", id: longB, name: "read", arguments: {} },
        ]),
        buildToolResult({ toolCallId: longA, toolName: "read", text: "one" }),
        buildToolResult({ toolCallId: longB, toolName: "read", text: "two" }),
      ]);

      const out = sanitizeToolCallIdsForCloudCodeAssist(input);
      const { aId, bId } = expectCollisionIdsRemainDistinct(out, "strict");
      expect(aId.length).toBeLessThanOrEqual(40);
      expect(bId.length).toBeLessThanOrEqual(40);
    });
  });

  describe("strict mode (alphanumeric only)", () => {
    it("preserves native anthropic ids while sanitizing mixed-provider ids when requested", () => {
      const nativeId = "toolu_01ABCDEF1234567890";
      const nonNativeId = "call_123|fc_123";
      const input = castAgentMessages([
        sparseAssistant([
          { type: "toolUse", id: nativeId, name: "read", input: { path: "IDENTITY.md" } },
          { type: "toolUse", id: nonNativeId, name: "read", input: { path: "README.md" } },
        ]),
        {
          role: "toolResult",
          toolCallId: nativeId,
          toolUseId: nativeId,
          toolName: "read",
          content: [{ type: "text", text: "identity" }],
        },
        {
          role: "toolResult",
          toolCallId: nonNativeId,
          toolUseId: nonNativeId,
          toolName: "read",
          content: [{ type: "text", text: "readme" }],
        },
      ]);

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict", {
        preserveNativeAnthropicToolUseIds: true,
      });

      expect(out).not.toBe(input);
      expect((out[0] as Extract<AgentMessage, { role: "assistant" }>).content).toEqual([
        { type: "toolUse", id: nativeId, name: "read", input: { path: "IDENTITY.md" } },
        { type: "toolUse", id: "call123fc123", name: "read", input: { path: "README.md" } },
      ]);
      expect(
        (out[1] as Extract<AgentMessage, { role: "toolResult" }> & { toolUseId?: string })
          .toolCallId,
      ).toBe(nativeId);
      expect(
        (out[1] as Extract<AgentMessage, { role: "toolResult" }> & { toolUseId?: string })
          .toolUseId,
      ).toBe(nativeId);
      expect(
        (out[2] as Extract<AgentMessage, { role: "toolResult" }> & { toolUseId?: string })
          .toolCallId,
      ).toBe("call123fc123");
      expect(
        (out[2] as Extract<AgentMessage, { role: "toolResult" }> & { toolUseId?: string })
          .toolUseId,
      ).toBe("call123fc123");
    });

    it("preserves replay-safe signed-thinking tool ids when requested", () => {
      const input = castAgentMessages([
        sparseAssistant([
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        ]),
        buildToolResult({ toolCallId: "call_1", toolName: "read", text: "ok" }),
      ]);

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict", {
        preserveReplaySafeThinkingToolCallIds: true,
        allowedToolNames: ["read"],
      });

      expect(out).toBe(input);
      expect(
        ((out[0] as Extract<AgentMessage, { role: "assistant" }>).content[1] as { id?: string }).id,
      ).toBe("call_1");
      expect((out[1] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe("call_1");
    });

    it("rewrites earlier mutable ids away from later preserved signed ids", () => {
      const input = castAgentMessages([
        sparseAssistant([readToolCall("call_1")]),
        buildToolResult({ toolCallId: "call_1", text: "first" }),
        signedReadAssistant("sig_1", "call1"),
        buildToolResult({ toolCallId: "call1", text: "second" }),
      ]);

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict", {
        preserveReplaySafeThinkingToolCallIds: true,
        allowedToolNames: ["read"],
      });

      expect(out).not.toBe(input);
      const firstAssistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const firstToolCall = firstAssistant.content?.[0] as { id?: string };
      expect(firstToolCall.id).not.toBe("call1");

      expectReplaySafeSignedTurnOwnership({
        input,
        preservedTurn: "second",
        firstToolCallIndex: 0,
      });
    });

    it("rewrites later signed turns when an earlier signed turn already owns the raw id", () => {
      const input = castAgentMessages([
        signedReadAssistant("sig_1", "call1"),
        buildToolResult({ toolCallId: "call1", text: "first" }),
        signedReadAssistant("sig_2", "call1"),
        buildToolResult({ toolCallId: "call1", text: "second" }),
      ]);

      expectReplaySafeSignedTurnOwnership({
        input,
        preservedTurn: "first",
        firstToolCallIndex: 1,
      });
    });

    it("rewrites OpenAI-shaped tool result id aliases with the matching assistant id", () => {
      const input = castAgentMessages([
        sparseAssistant([readToolCall("call_mock_image_generate_1")]),
        {
          role: "toolResult",
          call_id: "call_mock_image_generate_1",
          callId: "call_mock_image_generate_1",
          tool_call_id: "call_mock_image_generate_1",
          tool_use_id: "call_mock_image_generate_1",
          toolName: "image_generate",
          content: [{ type: "text", text: "Background task started" }],
        },
      ]);

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict");
      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const toolCall = assistant.content?.[0] as { id?: string };
      const toolResult = out[1] as Extract<AgentMessage, { role: "toolResult" }> & {
        call_id?: string;
        callId?: string;
        tool_call_id?: string;
        tool_use_id?: string;
      };

      expect(toolCall.id).toBe("callmockimagegenerate1");
      expect(toolResult.toolCallId).toBe(toolCall.id);
      expect(toolResult.call_id).toBe(toolCall.id);
      expect(toolResult.callId).toBe(toolCall.id);
      expect(toolResult.tool_call_id).toBe(toolCall.id);
      expect(toolResult.tool_use_id).toBe(toolCall.id);
    });

    it("keeps an existing canonical tool result id when raw aliases match the assistant", () => {
      const input = castAgentMessages([
        sparseAssistant([readToolCall("call_mock_image_generate_1")]),
        {
          role: "toolResult",
          toolCallId: "callmockimagegenerate1",
          call_id: "call_mock_image_generate_1",
          toolName: "image_generate",
          content: [{ type: "text", text: "Background task started" }],
        },
      ]);

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict");
      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const toolCall = assistant.content?.[0] as { id?: string };
      const toolResult = out[1] as Extract<AgentMessage, { role: "toolResult" }> & {
        call_id?: string;
      };

      expect(toolCall.id).toBe("callmockimagegenerate1");
      expect(toolResult.toolCallId).toBe(toolCall.id);
      expect(toolResult.call_id).toBe(toolCall.id);
    });

    it("uses OpenAI-style ids for repeated native Kimi ids when requested", () => {
      const input = castAgentMessages([
        sparseAssistant([
          { type: "toolCall", id: "functions.read:0", name: "read", arguments: {} },
        ]),
        buildToolResult({ toolCallId: "functions.read:0", text: "one" }),
        sparseAssistant([
          { type: "toolCall", id: "functions.read:0", name: "read", arguments: {} },
        ]),
        buildToolResult({ toolCallId: "functions.read:0", text: "two" }),
      ]);
      const options = { duplicateToolCallIdStyle: "openai" as const };

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict", options);
      const firstContent = (out[0] as Extract<AgentMessage, { role: "assistant" }>).content;
      const secondContent = (out[2] as Extract<AgentMessage, { role: "assistant" }>).content;
      if (!Array.isArray(firstContent) || !Array.isArray(secondContent)) {
        throw new Error("Expected assistant tool-call content");
      }
      const firstId = (firstContent[0] as { id?: string }).id;
      const secondId = (secondContent[0] as { id?: string }).id;
      expect(firstId).toBe("functions.read:0");
      expect(secondId).toMatch(/^call_[a-f0-9]{24}$/);
      expect((out[1] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe(firstId);
      expect((out[3] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe(secondId);
      expect(sanitizeToolCallIdsForCloudCodeAssist(out, "strict", options)).toBe(out);
    });
  });

  describe("strict9 mode (Mistral tool call IDs)", () => {
    it("enforces alphanumeric IDs with length 9", () => {
      const input = castAgentMessages([
        sparseAssistant([
          { type: "toolCall", id: "call_abc|item:123", name: "read", arguments: {} },
          { type: "toolCall", id: "call_abc|item:456", name: "read", arguments: {} },
        ]),
        buildToolResult({ toolCallId: "call_abc|item:123", toolName: "read", text: "one" }),
        buildToolResult({ toolCallId: "call_abc|item:456", toolName: "read", text: "two" }),
      ]);

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict9");
      expectDistinctStrict9Ids(out, input);
    });

    it("reuses one rewritten strict9 id when a tool result carries matching toolCallId and toolUseId", () => {
      const input = buildRepeatedSharedToolResultIdInput();

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict9");
      expect(out).not.toBe(input);
      expectStrict9IdLengths(expectToolUseIdsFollowDistinctToolCallIds(out, "strict9"));
    });
  });
});
