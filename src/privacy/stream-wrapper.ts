/**
 * StreamFn privacy filter wrapper — intercepts outbound payloads to replace
 * sensitive content, and intercepts inbound responses to restore originals.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  Context as PiContext,
  Message,
  TextContent,
  UserMessage,
} from "@mariozechner/pi-ai";
import { PrivacyDetector } from "./detector.js";
import { PrivacyMappingStore } from "./mapping-store.js";
import { PrivacyReplacer } from "./replacer.js";
import type { PrivacyConfig } from "./types.js";
import { DEFAULT_PRIVACY_CONFIG } from "./types.js";

export interface PrivacyFilterContext {
  detector: PrivacyDetector;
  replacer: PrivacyReplacer;
  store: PrivacyMappingStore;
  config: PrivacyConfig;
}

/** Create a shared privacy filter context for a session. */
export function createPrivacyFilterContext(
  sessionId: string,
  config?: DeepPartial<PrivacyConfig>,
): PrivacyFilterContext {
  const cfg: PrivacyConfig = {
    ...DEFAULT_PRIVACY_CONFIG,
    ...config,
    encryption: {
      ...DEFAULT_PRIVACY_CONFIG.encryption,
      ...config?.encryption,
    },
    mappings: {
      ...DEFAULT_PRIVACY_CONFIG.mappings,
      ...config?.mappings,
    },
    log: {
      ...DEFAULT_PRIVACY_CONFIG.log,
      ...config?.log,
    },
  };
  const detector = new PrivacyDetector(cfg.rules);
  const replacer = new PrivacyReplacer(sessionId);
  const store = new PrivacyMappingStore({
    storePath: cfg.mappings.storePath || undefined,
    salt: cfg.encryption.salt || undefined,
  });

  // Load existing session mappings.
  const existing = store.loadSession(sessionId);
  if (existing.length > 0) {
    replacer.loadMappings(existing);
  }

  return { detector, replacer, store, config: cfg };
}

/**
 * Filter a single text string: detect sensitive content, replace, persist mappings.
 * Returns the filtered text.
 */
export function filterText(text: string, ctx: PrivacyFilterContext): string {
  if (!text || !ctx.config.enabled) {
    return text;
  }

  const result = ctx.detector.detect(text);
  if (!result.hasPrivacyRisk) {
    return text;
  }

  const { replaced, newMappings } = ctx.replacer.replaceAll(text, result.matches);

  // Persist new mappings.
  if (newMappings.length > 0) {
    try {
      ctx.store.append(newMappings);
    } catch {
      // Non-fatal — filtering still works without persistence.
    }
  }

  return replaced;
}

/** Restore a text by reversing all known replacements. */
export function restoreText(text: string, ctx: PrivacyFilterContext): string {
  if (!text || !ctx.config.enabled) {
    return text;
  }
  return ctx.replacer.restore(text);
}

/**
 * Filter messages array — applies privacy replacement to user and assistant message text content.
 * Returns a new messages array with filtered content (does not mutate originals).
 */
export function filterMessages(messages: Message[], ctx: PrivacyFilterContext): Message[] {
  if (!ctx.config.enabled) {
    return messages;
  }

  let changed = false;
  const filtered = messages.map((msg) => {
    if (msg.role === "user") {
      const next = filterUserMessage(msg, ctx);
      if (next !== msg) {
        changed = true;
      }
      return next;
    }
    if (msg.role === "assistant") {
      const next = filterAssistantMessage(msg, ctx);
      if (next !== msg) {
        changed = true;
      }
      return next;
    }
    return msg;
  });

  return changed ? filtered : messages;
}

/**
 * Wrap a StreamFn with privacy filtering.
 * - Outbound: filters messages in the payload before sending to LLM.
 * - Inbound: wraps the response stream to restore originals in LLM output.
 */
export function wrapStreamFnPrivacyFilter(
  baseFn: StreamFn,
  privacyCtx: PrivacyFilterContext,
): StreamFn {
  if (!privacyCtx.config.enabled) {
    return baseFn;
  }

  return (model, context, options) => {
    // Filter outbound messages.
    const ctx = context;
    const messages = ctx.messages;

    let nextContext: PiContext = context;
    if (Array.isArray(messages)) {
      const filtered = filterMessages(messages, privacyCtx);
      if (filtered !== messages) {
        nextContext = { ...ctx, messages: filtered };
      }
    }

    const maybeStream = baseFn(model, nextContext, options);

    // Wrap stream response for reverse replacement.
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return maybeStream.then((stream) => wrapResponseStream(stream, privacyCtx));
    }
    return wrapResponseStream(maybeStream, privacyCtx);
  };
}

/**
 * Wrap a response stream (async iterable) to restore privacy replacements in LLM output.
 */
function wrapResponseStream<T>(stream: T, ctx: PrivacyFilterContext): T {
  if (!stream || typeof stream !== "object") {
    return stream;
  }

  // Check if it's an async iterable.
  const iterable = stream as unknown as AsyncIterable<unknown> & {
    [Symbol.asyncIterator](): AsyncIterator<unknown>;
  };
  if (typeof iterable[Symbol.asyncIterator] !== "function") {
    return stream;
  }

  const inner = iterable[Symbol.asyncIterator]();

  const wrapped: AsyncIterable<unknown> & AsyncIterator<unknown> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      const result = await inner.next();
      if (result.done) {
        return result;
      }

      const value = result.value;
      if (value && typeof value === "object") {
        return { done: false, value: restoreStreamChunk(value as Record<string, unknown>, ctx) };
      }
      return result;
    },
    async return(value?: unknown) {
      return inner.return?.(value) ?? { done: true as const, value: undefined };
    },
    async throw(error?: unknown) {
      return inner.throw?.(error) ?? { done: true as const, value: undefined };
    },
  };

  return wrapped as T;
}

/** Restore privacy replacements in a single stream chunk. */
function restoreStreamChunk(
  chunk: Record<string, unknown>,
  ctx: PrivacyFilterContext,
): Record<string, unknown> {
  // Handle text deltas.
  if (typeof chunk.text === "string") {
    const restored = restoreText(chunk.text, ctx);
    if (restored !== chunk.text) {
      return { ...chunk, text: restored };
    }
  }

  // Handle content blocks with text.
  if (chunk.type === "content_block_delta" && chunk.delta && typeof chunk.delta === "object") {
    const delta = chunk.delta as Record<string, unknown>;
    if (typeof delta.text === "string") {
      const restored = restoreText(delta.text, ctx);
      if (restored !== delta.text) {
        return { ...chunk, delta: { ...delta, text: restored } };
      }
    }
  }

  return chunk;
}

/** Filter a prompt string directly (for use before activeSession.prompt()). */
export function filterPrompt(prompt: string, ctx: PrivacyFilterContext): string {
  return filterText(prompt, ctx);
}

/** Restore a response text (for use in subscribe callbacks). */
export function restoreResponse(text: string, ctx: PrivacyFilterContext): string {
  return restoreText(text, ctx);
}

function filterUserMessage(msg: UserMessage, ctx: PrivacyFilterContext): UserMessage {
  if (typeof msg.content === "string") {
    const replaced = filterText(msg.content, ctx);
    return replaced === msg.content ? msg : { ...msg, content: replaced };
  }

  let changed = false;
  const nextContent = msg.content.map((block) => {
    if (block.type !== "text") {
      return block;
    }
    const replaced = filterText(block.text, ctx);
    if (replaced === block.text) {
      return block;
    }
    changed = true;
    return { ...block, text: replaced } satisfies TextContent;
  });

  return changed ? { ...msg, content: nextContent } : msg;
}

function filterAssistantMessage(
  msg: AssistantMessage,
  ctx: PrivacyFilterContext,
): AssistantMessage {
  let changed = false;
  const nextContent = msg.content.map((block) => {
    if (block.type !== "text") {
      return block;
    }
    const replaced = filterText(block.text, ctx);
    if (replaced === block.text) {
      return block;
    }
    changed = true;
    return { ...block, text: replaced } satisfies TextContent;
  });

  return changed ? { ...msg, content: nextContent } : msg;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
