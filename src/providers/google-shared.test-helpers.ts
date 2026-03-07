import type { Model } from "@mariozechner/pi-ai";
import { expect } from "vitest";
import { makeZeroUsageSnapshot } from "../agents/usage.js";

export const asRecord = (value: unknown): Record<string, unknown> => {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
};

type ConvertedTools = ReadonlyArray<{
  functionDeclarations?: ReadonlyArray<{
    parametersJsonSchema?: unknown;
    parameters?: unknown;
  }>;
}>;

export const getFirstToolParameters = (converted: ConvertedTools): Record<string, unknown> => {
  const functionDeclaration = asRecord(converted?.[0]?.functionDeclarations?.[0]);
  return asRecord(functionDeclaration.parametersJsonSchema ?? functionDeclaration.parameters);
};

export const makeModel = (id: string): Model<"google-generative-ai"> =>
  ({
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"google-generative-ai">;

export const makeGeminiCliModel = (id: string): Model<"google-gemini-cli"> =>
  ({
    id,
    name: id,
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"google-gemini-cli">;

export function makeGoogleAssistantMessage(model: string, content: unknown) {
  return {
    role: "assistant",
    content,
    api: "google-generative-ai",
    provider: "google",
    model,
    usage: makeZeroUsageSnapshot(),
    stopReason: "stop",
    timestamp: 0,
  };
}

export function makeGeminiCliAssistantMessage(model: string, content: unknown) {
  return {
    role: "assistant",
    content,
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    model,
    usage: makeZeroUsageSnapshot(),
    stopReason: "stop",
    timestamp: 0,
  };
}

export function expectConvertedRoles(contents: Array<{ role?: string }>, expectedRoles: string[]) {
  expect(contents).toHaveLength(expectedRoles.length);
  for (const [index, role] of expectedRoles.entries()) {
    expect(contents[index]?.role).toBe(role);
  }
}

// Vendored from @mariozechner/pi-ai@0.57.0 (providers/google-shared.js and providers/transform-messages.js and utils/sanitize-unicode.js)
// to avoid importing internal modules that are no longer exported.

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

// transform-messages.js
function transformMessages(
  messages: unknown[],
  model: unknown,
  normalizeToolCallId: (id: string, model: unknown, msg: unknown) => string,
): unknown[] {
  // Build a map of original tool call IDs to normalized IDs
  const toolCallIdMap = new Map();
  // First pass: transform messages (thinking blocks, tool call ID normalization)
  const transformed = messages.map((msg) => {
    // User messages pass through unchanged
    if (msg.role === "user") {
      return msg;
    }
    // Handle toolResult messages - normalize toolCallId if we have a mapping
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return { ...msg, toolCallId: normalizedId };
      }
      return msg;
    }
    // Assistant messages need transformation check
    if (msg.role === "assistant") {
      const assistantMsg = msg;
      const isSameModel =
        assistantMsg.provider === model.provider &&
        assistantMsg.api === model.api &&
        assistantMsg.model === model.id;
      const transformedContent = assistantMsg.content.flatMap((block) => {
        if (block.type === "thinking") {
          // Redacted thinking is opaque encrypted content, only valid for the same model.
          // Drop it for cross-model to avoid API errors.
          if (block.redacted) {
            return isSameModel ? block : [];
          }
          // For same model: keep thinking blocks with signatures (needed for replay)
          // even if the thinking text is empty (OpenAI encrypted reasoning)
          if (isSameModel && block.thinkingSignature) {
            return block;
          }
          // Skip empty thinking blocks, convert others to plain text
          if (!block.thinking || block.thinking.trim() === "") {
            return [];
          }
          if (isSameModel) {
            return block;
          }
          return {
            type: "text",
            text: block.thinking,
          };
        }
        if (block.type === "text") {
          if (isSameModel) {
            return block;
          }
          return {
            type: "text",
            text: block.text,
          };
        }
        if (block.type === "toolCall") {
          const toolCall = block;
          let normalizedToolCall = toolCall;
          if (!isSameModel && toolCall.thoughtSignature) {
            normalizedToolCall = { ...toolCall };
            delete normalizedToolCall.thoughtSignature;
          }
          if (!isSameModel && normalizeToolCallId) {
            const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
            if (normalizedId !== toolCall.id) {
              toolCallIdMap.set(toolCall.id, normalizedId);
              normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
            }
          }
          return normalizedToolCall;
        }
        return block;
      });
      return {
        ...assistantMsg,
        content: transformedContent,
      };
    }
    return msg;
  });
  // Second pass: insert synthetic empty tool results for orphaned tool calls
  // This preserves thinking signatures and satisfies API requirements
  const result = [];
  let pendingToolCalls = [];
  let existingToolResultIds = new Set();
  for (let i = 0; i < transformed.length; i++) {
    const msg = transformed[i];
    if (msg.role === "assistant") {
      // If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
      if (pendingToolCalls.length > 0) {
        for (const tc of pendingToolCalls) {
          if (!existingToolResultIds.has(tc.id)) {
            result.push({
              role: "toolResult",
              toolCallId: tc.id,
              toolName: tc.name,
              content: [{ type: "text", text: "No result provided" }],
              isError: true,
              timestamp: Date.now(),
            });
          }
        }
        pendingToolCalls = [];
        existingToolResultIds = new Set();
      }
      // Skip errored/aborted assistant messages entirely.
      // These are incomplete turns that shouldn't be replayed:
      // - May have partial content (reasoning without message, incomplete tool calls)
      // - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
      // - The model should retry from the last valid state
      const assistantMsg = msg;
      if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
        continue;
      }
      // Track tool calls from this assistant message
      const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall");
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }
      result.push(msg);
    } else if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === "user") {
      // User message interrupts tool flow - insert synthetic results for orphaned calls
      if (pendingToolCalls.length > 0) {
        for (const tc of pendingToolCalls) {
          if (!existingToolResultIds.has(tc.id)) {
            result.push({
              role: "toolResult",
              toolCallId: tc.id,
              toolName: tc.name,
              content: [{ type: "text", text: "No result provided" }],
              isError: true,
              timestamp: Date.now(),
            });
          }
        }
        pendingToolCalls = [];
        existingToolResultIds = new Set();
      }
      result.push(msg);
    } else {
      result.push(msg);
    }
  }
  return result;
}

// Vendored google-shared.js
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function isValidThoughtSignature(signature: string | undefined): boolean {
  if (!signature) {
    return false;
  }
  if (signature.length % 4 !== 0) {
    return false;
  }
  return base64SignaturePattern.test(signature);
}

function resolveThoughtSignature(
  isSameProviderAndModel: boolean,
  signature: string | undefined,
): string | undefined {
  return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

export function isThinkingPart(part: unknown): boolean {
  return (part as Record<string, unknown>).thought === true;
}

export function retainThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (typeof incoming === "string" && incoming.length > 0) {
    return incoming;
  }
  return existing;
}

export function requiresToolCallId(modelId: string): boolean {
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

export function convertMessages(model: unknown, context: unknown): unknown[] {
  const contents: unknown[] = [];
  const normalizeToolCallId = (id: string) => {
    if (!requiresToolCallId(model.id)) {
      return id;
    }
    return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  };
  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({
          role: "user",
          parts: [{ text: sanitizeSurrogates(msg.content) }],
        });
      } else {
        const parts = msg.content.map((item) => {
          if (item.type === "text") {
            return { text: sanitizeSurrogates(item.text) };
          } else {
            return {
              inlineData: {
                mimeType: item.mimeType,
                data: item.data,
              },
            };
          }
        });
        const filteredParts = !model.input.includes("image")
          ? parts.filter((p) => p.text !== undefined)
          : parts;
        if (filteredParts.length === 0) {
          continue;
        }
        contents.push({
          role: "user",
          parts: filteredParts,
        });
      }
    } else if (msg.role === "assistant") {
      const parts: unknown[] = [];
      const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
      for (const block of msg.content) {
        if (block.type === "text") {
          if (!block.text || block.text.trim() === "") {
            continue;
          }
          const thoughtSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.textSignature,
          );
          parts.push({
            text: sanitizeSurrogates(block.text),
            ...(thoughtSignature && { thoughtSignature }),
          });
        } else if (block.type === "thinking") {
          if (!block.thinking || block.thinking.trim() === "") {
            continue;
          }
          if (isSameProviderAndModel) {
            const thoughtSignature = resolveThoughtSignature(
              isSameProviderAndModel,
              block.thinkingSignature,
            );
            parts.push({
              thought: true,
              text: sanitizeSurrogates(block.thinking),
              ...(thoughtSignature && { thoughtSignature }),
            });
          } else {
            parts.push({
              text: sanitizeSurrogates(block.thinking),
            });
          }
        } else if (block.type === "toolCall") {
          const thoughtSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.thoughtSignature,
          );
          const isGemini3 = model.id.toLowerCase().includes("gemini-3");
          const effectiveSignature =
            thoughtSignature || (isGemini3 ? SKIP_THOUGHT_SIGNATURE : undefined);
          const part = {
            functionCall: {
              name: block.name,
              args: block.arguments ?? {},
              ...(requiresToolCallId(model.id) ? { id: block.id } : {}),
            },
            ...(effectiveSignature && { thoughtSignature: effectiveSignature }),
          };
          parts.push(part);
        }
      }
      if (parts.length === 0) {
        continue;
      }
      contents.push({
        role: "model",
        parts,
      });
    } else if (msg.role === "toolResult") {
      const textContent = msg.content.filter((c) => c.type === "text");
      const textResult = textContent.map((c) => c.text).join("\n");
      const imageContent = model.input.includes("image")
        ? msg.content.filter((c) => c.type === "image")
        : [];
      const hasText = textResult.length > 0;
      const hasImages = imageContent.length > 0;
      const supportsMultimodalFunctionResponse = model.id.includes("gemini-3");
      const responseValue = hasText
        ? sanitizeSurrogates(textResult)
        : hasImages
          ? "(see attached image)"
          : "";
      const imageParts = imageContent.map((imageBlock) => ({
        inlineData: {
          mimeType: imageBlock.mimeType,
          data: imageBlock.data,
        },
      }));
      const includeId = requiresToolCallId(model.id);
      const functionResponsePart = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseValue } : { output: responseValue },
          ...(hasImages && supportsMultimodalFunctionResponse && { parts: imageParts }),
          ...(includeId ? { id: msg.toolCallId } : {}),
        },
      };
      const lastContent = contents[contents.length - 1];
      if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
        lastContent.parts.push(functionResponsePart);
      } else {
        contents.push({
          role: "user",
          parts: [functionResponsePart],
        });
      }
      if (hasImages && !supportsMultimodalFunctionResponse) {
        contents.push({
          role: "user",
          parts: [{ text: "Tool result image:" }, ...imageParts],
        });
      }
    }
  }
  return contents;
}

export function convertTools(
  tools: unknown[],
  useParameters: boolean = false,
): unknown[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: (tool as Record<string, unknown>).name,
        description: (tool as Record<string, unknown>).description,
        ...(useParameters
          ? { parameters: (tool as Record<string, unknown>).parameters }
          : { parametersJsonSchema: (tool as Record<string, unknown>).parameters }),
      })),
    },
  ];
}
