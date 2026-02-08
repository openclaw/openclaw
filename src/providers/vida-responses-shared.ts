import { calculateCost, parseStreamingJson } from "@mariozechner/pi-ai";

// =============================================================================
// Utilities
// =============================================================================
/** Fast deterministic hash to shorten long strings */
function shortHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

/**
 * Removes unpaired Unicode surrogate characters from a string.
 */
function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

// =============================================================================
// Message conversion
// =============================================================================
function transformMessages(
  messages: any[],
  model: any,
  normalizeToolCallId?: (id: string, model: any, msg: any) => string,
): any[] {
  const toolCallIdMap = new Map<string, string>();
  const transformed = messages.map((msg) => {
    if (msg.role === "user") {
      return msg;
    }
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return { ...msg, toolCallId: normalizedId };
      }
      return msg;
    }
    if (msg.role === "assistant") {
      const assistantMsg = msg;
      const isSameModel =
        assistantMsg.provider === model.provider &&
        assistantMsg.api === model.api &&
        assistantMsg.model === model.id;
      const transformedContent = assistantMsg.content.flatMap((block: any) => {
        if (block.type === "thinking") {
          if (isSameModel && block.thinkingSignature) return block;
          if (!block.thinking || block.thinking.trim() === "") return [];
          if (isSameModel) return block;
          return {
            type: "text",
            text: block.thinking,
          };
        }
        if (block.type === "text") {
          if (isSameModel) return block;
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
  const result: any[] = [];
  let pendingToolCalls: any[] = [];
  let existingToolResultIds = new Set<string>();
  for (let i = 0; i < transformed.length; i++) {
    const msg = transformed[i];
    if (msg.role === "assistant") {
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
      const assistantMsg = msg;
      if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
        continue;
      }
      const toolCalls = assistantMsg.content.filter((b: any) => b.type === "toolCall");
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }
      result.push(msg);
    } else if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === "user") {
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

export function convertResponsesMessages(
  model: any,
  context: any,
  allowedToolCallProviders: Set<string>,
  options?: { includeSystemPrompt?: boolean },
): any[] {
  const messages: any[] = [];
  const normalizeToolCallId = (id: string): string => {
    if (!allowedToolCallProviders.has(model.provider)) return id;
    if (!id.includes("|")) return id;
    const [callId, itemId] = id.split("|");
    const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
    let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!sanitizedItemId.startsWith("fc")) {
      sanitizedItemId = `fc_${sanitizedItemId}`;
    }
    let normalizedCallId =
      sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
    let normalizedItemId =
      sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
    normalizedCallId = normalizedCallId.replace(/_+$/, "");
    normalizedItemId = normalizedItemId.replace(/_+$/, "");
    return `${normalizedCallId}|${normalizedItemId}`;
  };
  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    const role = model.reasoning ? "developer" : "system";
    messages.push({
      role,
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }
  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
        });
      } else {
        const content = msg.content.map((item: any) => {
          if (item.type === "text") {
            return {
              type: "input_text",
              text: sanitizeSurrogates(item.text),
            };
          }
          return {
            type: "input_image",
            detail: "auto",
            image_url: `data:${item.mimeType};base64,${item.data}`,
          };
        });
        const filteredContent = !model.input.includes("image")
          ? content.filter((c: any) => c.type !== "input_image")
          : content;
        if (filteredContent.length === 0) continue;
        messages.push({
          role: "user",
          content: filteredContent,
        });
      }
    } else if (msg.role === "assistant") {
      const output: any[] = [];
      const assistantMsg = msg;
      const isSameModel =
        assistantMsg.model === model.id &&
        assistantMsg.provider === model.provider &&
        assistantMsg.api === model.api;
      const isDifferentModel =
        assistantMsg.model !== model.id &&
        assistantMsg.provider === model.provider &&
        assistantMsg.api === model.api;
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            const reasoningItem = JSON.parse(block.thinkingSignature);
            output.push(reasoningItem);
          }
        } else if (block.type === "text") {
          const textBlock = block;
          let msgId = textBlock.textSignature;
          if (!msgId) {
            msgId = `msg_${msgIndex}`;
          } else if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          output.push({
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] },
            ],
            status: "completed",
            id: msgId,
          });
        } else if (block.type === "toolCall") {
          const toolCall = block as any;
          const [callId, itemIdRaw] = toolCall.id.split("|");
          let itemId = itemIdRaw;
          if (isDifferentModel && itemId?.startsWith("fc_")) {
            itemId = undefined;
          }
          const functionCallItem: any = {
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          };
          const providerMetadata = isSameModel ? toolCall.providerMetadata : undefined;
          if (providerMetadata !== undefined) {
            functionCallItem.provider_metadata = providerMetadata;
          }
          output.push(functionCallItem);
        }
      }
      if (output.length === 0) continue;
      messages.push(...output);
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      const hasImages = msg.content.some((c: any) => c.type === "image");
      const hasText = textResult.length > 0;
      const [callId] = msg.toolCallId.split("|");
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
      });
      if (hasImages && model.input.includes("image")) {
        const contentParts: any[] = [];
        contentParts.push({
          type: "input_text",
          text: "Attached image(s) from tool result:",
        });
        for (const block of msg.content) {
          if (block.type === "image") {
            contentParts.push({
              type: "input_image",
              detail: "auto",
              image_url: `data:${block.mimeType};base64,${block.data}`,
            });
          }
        }
        messages.push({
          role: "user",
          content: contentParts,
        });
      }
    }
    msgIndex++;
  }
  return messages;
}

// =============================================================================
// Tool conversion
// =============================================================================
export function convertResponsesTools(tools: any[], options?: { strict?: boolean }): any[] {
  const strict = options?.strict === undefined ? false : options.strict;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict,
  }));
}

// =============================================================================
// Stream processing
// =============================================================================
export async function processResponsesStream(
  openaiStream: AsyncIterable<any>,
  output: any,
  stream: any,
  model: any,
  options?: {
    serviceTier?: string;
    applyServiceTierPricing?: (usage: any, serviceTier: string | undefined) => void;
  },
): Promise<void> {
  let currentItem: any = null;
  let currentBlock: any = null;
  const blocks = output.content as any[];
  const blockIndex = () => blocks.length - 1;
  for await (const event of openaiStream) {
    if (event.type === "response.output_item.added") {
      const item = event.item;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: {},
          partialJson: item.arguments || "",
          ...(item.provider_metadata !== undefined
            ? { providerMetadata: item.provider_metadata }
            : {}),
        };
        output.content.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
      }
    } else if (event.type === "response.reasoning_summary_part.added") {
      if (currentItem && currentItem.type === "reasoning") {
        currentItem.summary = currentItem.summary || [];
        currentItem.summary.push(event.part);
      }
    } else if (event.type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.reasoning_summary_part.done") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += "\n\n";
          lastPart.text += "\n\n";
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: "\n\n",
            partial: output,
          });
        }
      }
    } else if (event.type === "response.content_part.added") {
      if (currentItem?.type === "message") {
        currentItem.content = currentItem.content || [];
        if (event.part.type === "output_text" || event.part.type === "refusal") {
          currentItem.content.push(event.part);
        }
      }
    } else if (event.type === "response.output_text.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "output_text") {
          currentBlock.text += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "refusal") {
          currentBlock.text += event.delta;
          lastPart.refusal += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson += event.delta;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
        });
      }
    } else if (event.type === "response.function_call_arguments.done") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson = event.arguments;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
      }
    } else if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = item.summary?.map((s: any) => s.text).join("\n\n") || "";
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: currentBlock.thinking,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = item.content
          .map((c: any) => (c.type === "output_text" ? c.text : c.refusal))
          .join("");
        currentBlock.textSignature = item.id;
        stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const args =
          currentBlock?.type === "toolCall" && currentBlock.partialJson
            ? JSON.parse(currentBlock.partialJson)
            : JSON.parse(item.arguments);
        const providerMetadata =
          item.provider_metadata ??
          (currentBlock?.type === "toolCall" ? currentBlock.providerMetadata : undefined);
        if (currentBlock?.type === "toolCall" && providerMetadata !== undefined) {
          currentBlock.providerMetadata = providerMetadata;
        }
        const toolCall: any = {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: args,
          ...(providerMetadata !== undefined ? { providerMetadata } : {}),
        };
        currentBlock = null;
        stream.push({
          type: "toolcall_end",
          contentIndex: blockIndex(),
          toolCall,
          partial: output,
        });
      }
    } else if (event.type === "response.completed") {
      const response = event.response;
      if (response?.usage) {
        const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
        output.usage = {
          input: (response.usage.input_tokens || 0) - cachedTokens,
          output: response.usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          totalTokens: response.usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      calculateCost(model, output.usage);
      if (options?.applyServiceTierPricing) {
        const serviceTier = response?.service_tier ?? options.serviceTier;
        options.applyServiceTierPricing(output.usage, serviceTier);
      }
      output.stopReason = mapStopReason(response?.status);
      if (output.content.some((b: any) => b.type === "toolCall") && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
    } else if (event.type === "error") {
      throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
    } else if (event.type === "response.failed") {
      throw new Error("Unknown error");
    }
  }
}

function mapStopReason(status?: string): string {
  if (!status) return "stop";
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default: {
      const _exhaustive: never = status as never;
      throw new Error(`Unhandled stop reason: ${_exhaustive}`);
    }
  }
}
