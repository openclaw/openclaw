import { resetToolStream } from "../app-tool-stream.ts";
import { extractText, extractThinking } from "../chat/message-extract.ts";
import { formatConnectError } from "../connect-error.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

function isSilentReplyStream(text: string): boolean {
  return SILENT_REPLY_PATTERN.test(text);
}
/** Client-side defense-in-depth: detect assistant messages whose text is purely NO_REPLY. */
function isAssistantSilentReply(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  if (role !== "assistant") {
    return false;
  }
  // entry.text takes precedence — matches gateway extractAssistantTextForSilentCheck
  if (typeof entry.text === "string") {
    return isSilentReplyStream(entry.text);
  }
  const text = extractText(message);
  return typeof text === "string" && isSilentReplyStream(text);
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamMessage?: unknown | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

function maybeResetToolStream(state: ChatState) {
  const toolHost = state as ChatState & Partial<Parameters<typeof resetToolStream>[0]>;
  if (
    toolHost.toolStreamById instanceof Map &&
    Array.isArray(toolHost.toolStreamOrder) &&
    Array.isArray(toolHost.chatToolMessages) &&
    Array.isArray(toolHost.chatStreamSegments)
  ) {
    resetToolStream(toolHost as Parameters<typeof resetToolStream>[0]);
  }
}

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = await state.client.request<{ messages?: Array<unknown>; thinkingLevel?: string }>(
      "chat.history",
      {
        sessionKey: state.sessionKey,
        limit: 200,
      },
    );
    const messages = Array.isArray(res.messages) ? res.messages : [];
    state.chatMessages = messages.filter((message) => !isAssistantSilentReply(message));
    state.chatThinkingLevel = res.thinkingLevel ?? null;
    // Clear all streaming state — history includes tool results and text
    // inline, so keeping streaming artifacts would cause duplicates.
    maybeResetToolStream(state);
    state.chatStream = null;
    state.chatStreamMessage = null;
    state.chatStreamStartedAt = null;
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      state.chatMessages = [];
      state.chatThinkingLevel = null;
      state.lastError = formatMissingOperatorReadScopeMessage("existing chat history");
    } else {
      state.lastError = String(err);
    }
  } finally {
    state.chatLoading = false;
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : roleValue.toLowerCase();
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

type StreamingAssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string };

type StreamingAssistantMessage = {
  role: "assistant";
  content: StreamingAssistantBlock[];
  timestamp: number;
};

function toStreamingAssistantBlocks(message: unknown): StreamingAssistantBlock[] {
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const blocks = content
        .map((block) => {
          const item = block as Record<string, unknown>;
          if (item.type === "thinking" && typeof item.thinking === "string" && item.thinking.trim()) {
            return { type: "thinking", thinking: item.thinking } as const;
          }
          if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
            return { type: "text", text: item.text } as const;
          }
          return null;
        })
        .filter((block): block is StreamingAssistantBlock => block !== null);
      if (blocks.length > 0) {
        return blocks;
      }
    }
  }

  const thinking = extractThinking(message)?.trim() ?? "";
  const explicitText =
    message &&
    typeof message === "object" &&
    typeof (message as Record<string, unknown>).text === "string"
      ? ((message as Record<string, unknown>).text as string).trim()
      : "";
  const text = explicitText || extractText(message)?.trim() || "";
  const blocks: StreamingAssistantBlock[] = [];
  if (thinking) {
    blocks.push({ type: "thinking", thinking });
  }
  if (text) {
    blocks.push({ type: "text", text });
  }
  return blocks;
}

function normalizeStreamingAssistantMessage(
  message: unknown,
  fallbackSerialized?: string | null,
): StreamingAssistantMessage | null {
  const fallbackMessage =
    !message && fallbackSerialized?.trim()
      ? ({ role: "assistant", content: fallbackSerialized } as const)
      : undefined;
  const source = message ?? fallbackMessage;
  if (!source) {
    return null;
  }
  const content = toStreamingAssistantBlocks(source);
  if (content.length === 0) {
    return null;
  }
  const timestamp =
    source &&
    typeof source === "object" &&
    typeof (source as Record<string, unknown>).timestamp === "number"
      ? ((source as Record<string, unknown>).timestamp as number)
      : Date.now();
  return {
    role: "assistant",
    content,
    timestamp,
  };
}

function serializeStreamingAssistantMessage(message: unknown): string {
  const normalized = normalizeStreamingAssistantMessage(message);
  if (!normalized) {
    return "";
  }
  return normalized.content
    .map((block) =>
      block.type === "thinking"
        ? `<thinking>\n${block.thinking.trim()}\n</thinking>`
        : block.text.trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}

function mergeStreamingAssistantMessage(
  currentMessage: unknown,
  currentSerialized: string | null,
  message: unknown,
): StreamingAssistantMessage | null {
  const previous = normalizeStreamingAssistantMessage(currentMessage, currentSerialized);
  const incoming = normalizeStreamingAssistantMessage(message);
  if (!incoming) {
    return previous;
  }

  const incomingText = extractText(incoming)?.trim() ?? "";
  const incomingThinking = extractThinking(incoming)?.trim() ?? "";
  if (incomingText && isSilentReplyStream(incomingText) && !incomingThinking) {
    return previous;
  }

  if (!previous) {
    return incoming;
  }

  const mergedContent = previous.content.map((block) => ({ ...block })) as StreamingAssistantBlock[];
  for (const block of incoming.content) {
    const last = mergedContent[mergedContent.length - 1];
    if (last?.type === block.type) {
      if (block.type === "thinking") {
        const previousValue = last.thinking.trim();
        const nextValue = block.thinking.trim();
        last.thinking = nextValue.length >= previousValue.length ? block.thinking : last.thinking;
      } else {
        const previousValue = last.text.trim();
        const nextValue = block.text.trim();
        last.text = nextValue.length >= previousValue.length ? block.text : last.text;
      }
      continue;
    }
    mergedContent.push({ ...block });
  }

  return {
    role: "assistant",
    content: mergedContent,
    timestamp: previous.timestamp,
  };
}

function mergeTerminalAssistantMessage(
  currentMessage: unknown,
  currentSerialized: string | null,
  message: unknown,
): StreamingAssistantMessage | null {
  const terminal = normalizeStreamingAssistantMessage(message);
  if (!terminal) {
    return normalizeStreamingAssistantMessage(currentMessage, currentSerialized);
  }
  const previous = normalizeStreamingAssistantMessage(currentMessage, currentSerialized);
  if (!previous) {
    return terminal;
  }
  const terminalHasThinking = terminal.content.some((block) => block.type === "thinking");
  if (terminalHasThinking) {
    return terminal;
  }
  const previousThinking = previous.content
    .filter((block): block is Extract<StreamingAssistantBlock, { type: "thinking" }> => block.type === "thinking")
    .map((block) => ({ ...block }));
  if (previousThinking.length === 0) {
    return terminal;
  }
  return {
    role: "assistant",
    content: [...previousThinking, ...terminal.content.map((block) => ({ ...block }))],
    timestamp: terminal.timestamp,
  };
}

function appendStreamMessageToHistory(state: ChatState, fallbackMessage?: unknown) {
  const mergedMessage = fallbackMessage
    ? mergeTerminalAssistantMessage(state.chatStreamMessage ?? null, state.chatStream, fallbackMessage)
    : normalizeStreamingAssistantMessage(state.chatStreamMessage ?? null, state.chatStream);
  if (mergedMessage && !isAssistantSilentReply(mergedMessage)) {
    state.chatMessages = [...state.chatMessages, mergedMessage];
  }
}

function clearStreamingAssistantState(state: ChatState) {
  state.chatStream = null;
  state.chatStreamMessage = null;
  state.chatRunId = null;
  state.chatStreamStartedAt = null;
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }

  const now = Date.now();

  // Build user message content blocks
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamMessage = null;
  state.chatStreamStartedAt = now;

  // Convert attachments to API format
  const apiAttachments = hasAttachments
    ? attachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed) {
            return null;
          }
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;

  try {
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
      attachments: apiAttachments,
    });
    return runId;
  } catch (err) {
    const error = formatConnectError(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamMessage = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = formatConnectError(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  if (payload.sessionKey !== state.sessionKey) {
    return null;
  }

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage && !isAssistantSilentReply(finalMessage)) {
        state.chatMessages = [...state.chatMessages, finalMessage];
        return null;
      }
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    const nextMessage = mergeStreamingAssistantMessage(
      state.chatStreamMessage ?? null,
      state.chatStream,
      payload.message,
    );
    if (nextMessage) {
      const nextSerialized = serializeStreamingAssistantMessage(nextMessage);
      const currentSerialized = state.chatStream ?? "";
      state.chatStreamMessage = nextMessage;
      if (!currentSerialized || nextSerialized.length >= currentSerialized.length) {
        state.chatStream = nextSerialized;
      }
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage && !isAssistantSilentReply(finalMessage)) {
      appendStreamMessageToHistory(state, finalMessage);
    } else if (state.chatStream?.trim()) {
      appendStreamMessageToHistory(state);
    }
    clearStreamingAssistantState(state);
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !isAssistantSilentReply(normalizedMessage)) {
      appendStreamMessageToHistory(state, normalizedMessage);
    } else {
      const streamedText = state.chatStream?.trim() ?? "";
      if (streamedText && !isSilentReplyStream(streamedText)) {
        appendStreamMessageToHistory(state);
      }
    }
    clearStreamingAssistantState(state);
  } else if (payload.state === "error") {
    clearStreamingAssistantState(state);
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
