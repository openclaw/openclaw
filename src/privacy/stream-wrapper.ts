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
  ToolCall,
  ToolResultMessage,
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

  // Clean up expired mappings before loading session data so the mapping
  // file does not grow unbounded beyond the configured retention window.
  if (cfg.mappings.ttl > 0) {
    try {
      store.cleanup(cfg.mappings.ttl);
    } catch {
      // Non-fatal — stale mappings remain but are functionally harmless.
    }
  }

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
    // toolResult messages carry tool output that is forwarded to the LLM on
    // follow-up turns — they can contain secrets returned by tools, so we must
    // filter their text content blocks too.
    if (msg.role === "toolResult") {
      const next = filterToolResultMessage(msg, ctx);
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
    // Filter outbound messages and system prompt.
    const ctx = context;
    const messages = ctx.messages;

    let nextContext: PiContext = context;
    let contextChanged = false;

    if (Array.isArray(messages)) {
      const filtered = filterMessages(messages, privacyCtx);
      if (filtered !== messages) {
        nextContext = { ...ctx, messages: filtered };
        contextChanged = true;
      }
    }

    // Also filter systemPrompt — it can contain secrets injected by prompt hooks
    // and is forwarded verbatim to providers like openai-ws-stream (as `instructions`).
    if (typeof ctx.systemPrompt === "string" && ctx.systemPrompt) {
      const filteredPrompt = filterText(ctx.systemPrompt, privacyCtx);
      if (filteredPrompt !== ctx.systemPrompt) {
        nextContext = { ...(contextChanged ? nextContext : ctx), systemPrompt: filteredPrompt };
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
  const bufferedRestore = createBufferedRestore(ctx);
  const queued: unknown[] = [];

  const wrappedIterator: AsyncIterable<unknown> & AsyncIterator<unknown> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (queued.length > 0) {
        return { done: false as const, value: queued.shift() };
      }

      const result = await inner.next();
      if (result.done) {
        const flushed = bufferedRestore.flush();
        if (flushed.length > 0) {
          queued.push(...flushed);
          return { done: false as const, value: queued.shift() };
        }
        return result;
      }

      const value = result.value;
      if (value && typeof value === "object") {
        return {
          done: false,
          value: restoreStreamChunk(value as Record<string, unknown>, ctx, bufferedRestore),
        };
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

  const wrappedStream = new Proxy(stream as object, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return () => wrappedIterator;
      }
      if (prop === "result") {
        const resultMethod = Reflect.get(target, prop, target);
        if (typeof resultMethod === "function") {
          return async (...args: unknown[]) => {
            const message = await resultMethod.apply(target, args);
            return restoreFinalResultMessage(message, ctx);
          };
        }
        return resultMethod;
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });

  return wrappedStream as T;
}

/** Restore privacy replacements in a single stream chunk. */
function restoreStreamChunk(
  chunk: Record<string, unknown>,
  ctx: PrivacyFilterContext,
  bufferedRestore: ReturnType<typeof createBufferedRestore>,
): Record<string, unknown> {
  // Handle common text_delta shape emitted by providers.
  if (chunk.type === "text_delta" && typeof chunk.delta === "string") {
    const laneKey = `text_delta:${getChunkContentIndex(chunk)}`;
    const restored = bufferedRestore.delta(laneKey, chunk.delta, (text) => ({
      ...chunk,
      delta: text,
    }));
    if (restored !== chunk.delta) {
      return { ...chunk, delta: restored };
    }
  }

  // Handle text deltas.
  if (typeof chunk.text === "string") {
    const restored = bufferedRestore.delta("root:text", chunk.text, (text) => ({ ...chunk, text }));
    if (restored !== chunk.text) {
      return { ...chunk, text: restored };
    }
  }

  // Handle content blocks with text.
  if (chunk.type === "content_block_delta" && chunk.delta && typeof chunk.delta === "object") {
    const delta = chunk.delta as Record<string, unknown>;
    if (typeof delta.text === "string") {
      const laneKey = `content_block_delta:text:${getChunkContentIndex(chunk)}`;
      const restored = bufferedRestore.delta(laneKey, delta.text, (text) => ({
        ...chunk,
        delta: { ...delta, text },
      }));
      if (restored !== delta.text) {
        return { ...chunk, delta: { ...delta, text: restored } };
      }
    }
  }

  // Handle tool-call argument deltas — the model may echo masked secrets into
  // tool arguments; downstream code accumulates these deltas and executes the
  // tool with them, so we must restore placeholders here too.
  // Runtime emits two delta shapes: object { arguments: string } and plain string.
  if (chunk.type === "toolcall_delta") {
    if (typeof chunk.delta === "string") {
      const laneKey = `toolcall_delta:string:${getChunkContentIndex(chunk)}`;
      const restored = bufferedRestore.delta(laneKey, chunk.delta, (text) => ({
        ...chunk,
        delta: text,
      }));
      if (restored !== chunk.delta) {
        return { ...chunk, delta: restored };
      }
    } else if (chunk.delta && typeof chunk.delta === "object") {
      const delta = chunk.delta as Record<string, unknown>;
      if (typeof delta.arguments === "string") {
        const laneKey = `toolcall_delta:arguments:${getChunkContentIndex(chunk)}`;
        const restored = bufferedRestore.delta(laneKey, delta.arguments, (text) => ({
          ...chunk,
          delta: { ...delta, arguments: text },
        }));
        if (restored !== delta.arguments) {
          return { ...chunk, delta: { ...delta, arguments: restored } };
        }
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
  const rawContent = (msg as { content?: unknown }).content;
  if (typeof rawContent === "string") {
    const replaced = filterText(rawContent, ctx);
    return replaced === rawContent
      ? msg
      : ({ ...msg, content: replaced } as unknown as AssistantMessage);
  }
  if (!Array.isArray(rawContent)) {
    // Legacy sessions may carry non-array assistant content at runtime.
    // Keep behavior fail-open here to avoid crashing the request path.
    return msg;
  }

  let changed = false;
  const nextContent = rawContent.map((block) => {
    if (block.type === "text") {
      const replaced = filterText(block.text, ctx);
      if (replaced === block.text) {
        return block;
      }
      changed = true;
      return { ...block, text: replaced } satisfies TextContent;
    }
    if (block.type === "toolCall") {
      const filteredArguments = filterUnknownStrings(block.arguments, ctx) as ToolCall["arguments"];
      if (filteredArguments !== block.arguments) {
        changed = true;
        return { ...block, arguments: filteredArguments } satisfies ToolCall;
      }
      return block;
    }
    return block;
  });

  return changed ? { ...msg, content: nextContent } : msg;
}

function filterToolResultMessage(
  msg: ToolResultMessage,
  ctx: PrivacyFilterContext,
): ToolResultMessage {
  const rawContent = (msg as { content?: unknown }).content;
  if (typeof rawContent === "string") {
    const replaced = filterText(rawContent, ctx);
    return replaced === rawContent
      ? msg
      : ({ ...msg, content: replaced } as unknown as ToolResultMessage);
  }
  if (!Array.isArray(rawContent)) {
    return msg;
  }

  let changed = false;
  const nextContent = rawContent.map((block) => {
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

type BufferedLane = {
  pendingRaw: string;
  makeChunk: (text: string) => Record<string, unknown>;
};

function createBufferedRestore(ctx: PrivacyFilterContext) {
  const lanes = new Map<string, BufferedLane>();
  const replacements = ctx.replacer.getMappings().map((m) => m.replacement);
  const replacementSet = new Set(replacements);

  return {
    delta(
      laneKey: string,
      text: string,
      makeChunk: (text: string) => Record<string, unknown>,
    ): string {
      if (!text || replacements.length === 0) {
        return restoreText(text, ctx);
      }

      const lane = lanes.get(laneKey) ?? { pendingRaw: "", makeChunk };
      lane.makeChunk = makeChunk;

      const combined = lane.pendingRaw + text;
      const holdback = findLongestReplacementPrefixSuffix(combined, replacements, replacementSet);
      const committed = holdback.length > 0 ? combined.slice(0, -holdback.length) : combined;
      lane.pendingRaw = holdback;
      lanes.set(laneKey, lane);
      return restoreText(committed, ctx);
    },
    flush(): Record<string, unknown>[] {
      const flushed: Record<string, unknown>[] = [];
      for (const lane of lanes.values()) {
        if (!lane.pendingRaw) {
          continue;
        }
        const restored = restoreText(lane.pendingRaw, ctx);
        if (restored) {
          flushed.push(lane.makeChunk(restored));
        }
      }
      lanes.clear();
      return flushed;
    },
  };
}

function findLongestReplacementPrefixSuffix(
  text: string,
  replacements: string[],
  replacementSet: ReadonlySet<string>,
): string {
  let best = "";
  for (const replacement of replacements) {
    const maxPrefixLength = Math.min(text.length, replacement.length - 1);
    for (let length = maxPrefixLength; length > best.length; length -= 1) {
      const suffix = text.slice(-length);
      if (text.endsWith(replacement.slice(0, length))) {
        if (replacementSet.has(suffix)) {
          continue;
        }
        best = suffix;
        break;
      }
    }
  }
  return best;
}

function filterUnknownStrings(value: unknown, ctx: PrivacyFilterContext): unknown {
  if (typeof value === "string") {
    return filterText(value, ctx);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const filtered = filterUnknownStrings(item, ctx);
      if (filtered !== item) {
        changed = true;
      }
      return filtered;
    });
    return changed ? next : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const input = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(input)) {
      const filtered = filterUnknownStrings(raw, ctx);
      if (filtered !== raw) {
        changed = true;
      }
      next[key] = filtered;
    }
    return changed ? next : value;
  }
  return value;
}

function getChunkContentIndex(chunk: Record<string, unknown>): string {
  return typeof chunk.contentIndex === "number" ? String(chunk.contentIndex) : "na";
}

function restoreFinalResultMessage(message: unknown, ctx: PrivacyFilterContext): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }

  const msg = message as {
    role?: unknown;
    content?: unknown;
    errorMessage?: unknown;
  };
  if (msg.role !== "assistant") {
    return message;
  }

  let changed = false;
  let next = message as Record<string, unknown>;

  if (typeof msg.content === "string") {
    const restored = restoreText(msg.content, ctx);
    if (restored !== msg.content) {
      next = { ...next, content: restored };
      changed = true;
    }
  } else if (Array.isArray(msg.content)) {
    const nextContent = msg.content.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const typed = block as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        arguments?: unknown;
      };
      if (typed.type === "text" && typeof typed.text === "string") {
        const restored = restoreText(typed.text, ctx);
        if (restored !== typed.text) {
          changed = true;
          return { ...typed, text: restored };
        }
      }
      if (typed.type === "thinking" && typeof typed.thinking === "string") {
        const restored = restoreText(typed.thinking, ctx);
        if (restored !== typed.thinking) {
          changed = true;
          return { ...typed, thinking: restored };
        }
      }
      if (typed.type === "toolCall" && typed.arguments && typeof typed.arguments === "object") {
        const restoredArgs = restoreUnknownStrings(typed.arguments, ctx);
        if (restoredArgs !== typed.arguments) {
          changed = true;
          return { ...typed, arguments: restoredArgs };
        }
      }
      return block;
    });
    if (changed) {
      next = { ...next, content: nextContent };
    }
  }

  if (typeof msg.errorMessage === "string") {
    const restored = restoreText(msg.errorMessage, ctx);
    if (restored !== msg.errorMessage) {
      next = { ...next, errorMessage: restored };
      changed = true;
    }
  }

  return changed ? next : message;
}

function restoreUnknownStrings(value: unknown, ctx: PrivacyFilterContext): unknown {
  if (typeof value === "string") {
    return restoreText(value, ctx);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const restored = restoreUnknownStrings(item, ctx);
      if (restored !== item) {
        changed = true;
      }
      return restored;
    });
    return changed ? next : value;
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(input)) {
      const restored = restoreUnknownStrings(raw, ctx);
      if (restored !== raw) {
        changed = true;
      }
      next[key] = restored;
    }
    return changed ? next : value;
  }
  return value;
}
