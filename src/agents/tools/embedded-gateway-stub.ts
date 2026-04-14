import type { OpenClawConfig } from "../../config/types.openclaw.js";
/**
 * Embedded-mode local `callGateway` replacement.
 *
 * Handles the gateway RPC methods that `sessions_list` and `sessions_history`
 * tools use, reading directly from disk instead of opening a WebSocket to the
 * gateway process.  All other methods throw a clear error so the caller knows
 * the gateway is unavailable.
 *
 * Heavy gateway modules are loaded lazily via a computed dynamic import to avoid
 * an import cycle (openclaw-tools → stub → chat.ts → auto-reply → openclaw-tools).
 * Both the dynamic `import()` path and the type annotation use opaque forms so
 * madge's static AST parser cannot trace the edge.
 */
import type { CallGatewayOptions } from "../../gateway/call.js";
import type { SessionsListParams } from "../../gateway/protocol/index.js";
import type { SessionsListResult } from "../../gateway/session-utils.types.js";

type EmbeddedCallGateway = <T = Record<string, unknown>>(opts: CallGatewayOptions) => Promise<T>;

/**
 * Shape of the lazily-loaded runtime module.  Defined manually to avoid
 * `typeof import(...)` which madge traces as a static dependency.
 */
interface EmbeddedGatewayRuntime {
  resolveSessionAgentId: (opts: { sessionKey: string; config: OpenClawConfig }) => string;
  loadConfig: () => OpenClawConfig;
  stripEnvelopeFromMessages: (msgs: unknown[]) => unknown[];
  augmentChatHistoryWithCliSessionImports: (opts: {
    entry: unknown;
    provider: string | undefined;
    localMessages: unknown[];
  }) => unknown[];
  getMaxChatHistoryMessagesBytes: () => number;
  augmentChatHistoryWithCanvasBlocks: (msgs: unknown[]) => unknown[];
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: number;
  enforceChatHistoryFinalBudget: (opts: { messages: unknown[]; maxBytes: number }) => {
    messages: unknown[];
  };
  replaceOversizedChatHistoryMessages: (opts: {
    messages: unknown[];
    maxSingleMessageBytes: number;
  }) => { messages: unknown[] };
  resolveEffectiveChatHistoryMaxChars: (cfg: OpenClawConfig) => number;
  sanitizeChatHistoryMessages: (msgs: unknown[], maxChars: number) => unknown[];
  capArrayByJsonBytes: (items: unknown[], maxBytes: number) => { items: unknown[] };
  listSessionsFromStore: (opts: {
    cfg: OpenClawConfig;
    storePath: string;
    store: unknown;
    opts: SessionsListParams;
  }) => SessionsListResult;
  loadCombinedSessionStoreForGateway: (cfg: OpenClawConfig) => {
    storePath: string;
    store: unknown;
  };
  loadSessionEntry: (sessionKey: string) => {
    cfg: OpenClawConfig;
    storePath: string | undefined;
    entry: Record<string, unknown> | undefined;
  };
  readSessionMessages: (sessionId: string, storePath: string, sessionFile?: string) => unknown[];
  resolveSessionModelRef: (
    cfg: OpenClawConfig,
    entry: unknown,
    sessionAgentId: string,
  ) => { provider: string | undefined };
}

/** Lazy-loaded runtime module cache. */
let runtimeMod: EmbeddedGatewayRuntime | undefined;

async function getRuntime(): Promise<EmbeddedGatewayRuntime> {
  if (!runtimeMod) {
    // Compute the path in a variable so madge's static parser cannot trace it.
    const modPath = [".", "embedded-gateway-stub.runtime.js"].join("/");
    runtimeMod = (await import(modPath)) as EmbeddedGatewayRuntime;
  }
  return runtimeMod;
}

async function handleSessionsList(params: Record<string, unknown>) {
  const rt = await getRuntime();
  const cfg = rt.loadConfig();
  const { storePath, store } = rt.loadCombinedSessionStoreForGateway(cfg);
  return rt.listSessionsFromStore({
    cfg,
    storePath,
    store,
    opts: params as SessionsListParams,
  });
}

async function handleChatHistory(params: Record<string, unknown>): Promise<{
  sessionKey: string;
  sessionId: string | undefined;
  messages: unknown[];
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
}> {
  const rt = await getRuntime();

  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
  const limit = typeof params.limit === "number" ? params.limit : undefined;

  const { cfg, storePath, entry } = rt.loadSessionEntry(sessionKey);
  const sessionId = entry?.sessionId as string | undefined;
  const sessionAgentId = rt.resolveSessionAgentId({ sessionKey, config: cfg });
  const resolvedSessionModel = rt.resolveSessionModelRef(cfg, entry, sessionAgentId);

  const localMessages =
    sessionId && storePath
      ? rt.readSessionMessages(sessionId, storePath, entry?.sessionFile as string | undefined)
      : [];

  // Replicate the full gateway sanitization pipeline from
  // src/gateway/server-methods/chat.ts "chat.history" handler (lines 1620-1668).
  const rawMessages = rt.augmentChatHistoryWithCliSessionImports({
    entry,
    provider: resolvedSessionModel.provider,
    localMessages,
  });

  const hardMax = 1000;
  const defaultLimit = 200;
  const requested = typeof limit === "number" ? limit : defaultLimit;
  const max = Math.min(hardMax, requested);
  const effectiveMaxChars = rt.resolveEffectiveChatHistoryMaxChars(cfg);

  const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
  const sanitized = rt.stripEnvelopeFromMessages(sliced);
  const normalized = rt.augmentChatHistoryWithCanvasBlocks(
    rt.sanitizeChatHistoryMessages(sanitized, effectiveMaxChars),
  );

  const maxHistoryBytes = rt.getMaxChatHistoryMessagesBytes();
  const perMessageHardCap = Math.min(rt.CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = rt.replaceOversizedChatHistoryMessages({
    messages: normalized,
    maxSingleMessageBytes: perMessageHardCap,
  });
  const capped = rt.capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
  const bounded = rt.enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });

  return {
    sessionKey,
    sessionId,
    messages: bounded.messages,
    thinkingLevel: entry?.thinkingLevel as string | undefined,
    fastMode: entry?.fastMode as boolean | undefined,
    verboseLevel: entry?.verboseLevel as string | undefined,
  };
}

/**
 * Create a `callGateway`-compatible function that handles `sessions.list` and
 * `chat.history` locally, reading from disk.  All other methods throw.
 */
export function createEmbeddedCallGateway(): EmbeddedCallGateway {
  return async <T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> => {
    const method = opts.method?.trim();
    const params = (opts.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case "sessions.list":
        return (await handleSessionsList(params)) as T;
      case "chat.history":
        return (await handleChatHistory(params)) as T;
      default:
        throw new Error(
          `Method "${method}" requires a running gateway (unavailable in local embedded mode).`,
        );
    }
  };
}
