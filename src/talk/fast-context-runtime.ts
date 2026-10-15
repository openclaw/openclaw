/**
 * Fast context lookup for realtime voice consults.
 *
 * When memory/session search can answer quickly, Talk can return concise
 * context without launching a full agent consult; otherwise callers may fall
 * back to the normal consult flow.
 */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { MemoryCallerContext, MemorySearchHit } from "../plugins/memory-provider-types.js";
import { withTimeout } from "../utils/with-timeout.js";
import type { RealtimeVoiceAgentConsultResult } from "./agent-consult-runtime.js";
import { parseRealtimeVoiceAgentConsultArgs } from "./agent-consult-tool.js";

type Logger = {
  debug?: (message: string) => void;
};

export type RealtimeVoiceFastContextConfig = {
  enabled: boolean;
  /** Maximum memory/session hits to include in the spoken-context prompt. */
  maxResults: number;
  /** Search backends allowed for the quick lookup. */
  sources: Array<"memory" | "sessions">;
  /** Deadline before the quick lookup gives up. */
  timeoutMs: number;
  /** Whether miss/unavailable/timeout should fall back to a full consult. */
  fallbackToConsult: boolean;
};

export type RealtimeVoiceFastContextLabels = {
  audienceLabel: string;
  contextName: string;
};

type FastContextHit = { source: string; location: string; snippet: string };

type FastContextLookupResult =
  | { status: "unavailable"; error?: string }
  | { status: "hits"; hits: FastContextHit[] };

/**
 * Owner-held liveness of the live voice request. The realtime surface that owns
 * the call supplies it; the lookup checks it before and after every provider call.
 */
type RealtimeVoiceFastContextLiveness = {
  /** Aborts when the owning consult or call is cancelled. */
  signal?: AbortSignal;
  /** Throws once the call that owns this request is no longer live. */
  assertCurrent(): void;
};

export type RealtimeVoiceFastContextConsultResult =
  | { handled: false }
  | { handled: true; result: RealtimeVoiceAgentConsultResult };

const MAX_SNIPPET_CHARS = 700;

function normalizeSnippet(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SNIPPET_CHARS) {
    return normalized;
  }
  // Keep individual memory snippets bounded so several hits still fit in a
  // short realtime response prompt.
  return `${truncateUtf16Safe(normalized, MAX_SNIPPET_CHARS - 1).trimEnd()}...`;
}

function buildContextText(params: {
  query: string;
  hits: FastContextHit[];
  labels: RealtimeVoiceFastContextLabels;
}): string {
  const hits = params.hits
    .map(
      (hit, index) =>
        `${index + 1}. [${hit.source}] ${hit.location}\n${normalizeSnippet(hit.snippet)}`,
    )
    .join("\n\n");
  return [
    `Fast ${params.labels.contextName} found for the live ${params.labels.audienceLabel}.`,
    `Use this context only if it answers the ${params.labels.audienceLabel}'s question. If it is not relevant, say briefly that you do not have that context handy.`,
    `Question:\n${params.query}`,
    `Context:\n${hits}`,
  ].join("\n\n");
}

function buildMissText(query: string, labels: RealtimeVoiceFastContextLabels): string {
  return [
    `No relevant ${labels.contextName} was found quickly for the live ${labels.audienceLabel}.`,
    `Answer briefly that you do not have that context handy. Do not keep checking unless the ${labels.audienceLabel} asks you to.`,
    `Question:\n${query}`,
  ].join("\n\n");
}

// Native hits cite provider references; their excerpts are already prompt text.
function toNativeFastContextHit(hit: MemorySearchHit): FastContextHit {
  return {
    source: hit.source ?? hit.reference.providerId,
    location:
      hit.citations?.map((citation) => citation.label).join(", ") ||
      `${hit.reference.providerId}:${hit.reference.id}`,
    snippet: hit.excerpt,
  };
}

async function lookupFastContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  config: RealtimeVoiceFastContextConfig;
  query: string;
  context: MemoryCallerContext;
  callerSuppliedLiveness: boolean;
}): Promise<FastContextLookupResult> {
  const {
    authorizeActiveMemorySearchHits,
    getActiveMemoryProviderCore,
    getActiveMemorySearchManagerCore,
    isActiveMemoryProviderNative,
  } = await import("../plugins/memory-runtime.js");
  if (isActiveMemoryProviderNative({ cfg: params.cfg, agentId: params.agentId })) {
    // A native provider reads only under the live call's owner-held liveness. Callers
    // released before liveness existed get the unavailable outcome, never a provider read.
    if (!params.callerSuppliedLiveness) {
      return { status: "unavailable", error: "caller supplied no request liveness" };
    }
    const memory = await getActiveMemoryProviderCore({
      cfg: params.cfg,
      agentId: params.agentId,
      context: params.context,
    });
    if (!memory.provider) {
      return { status: "unavailable", error: memory.error ?? "no active memory provider" };
    }
    try {
      const { hits } = await memory.provider.search({
        query: params.query,
        maxResults: params.config.maxResults,
        sources: params.config.sources,
      });
      params.context.assertCurrent();
      return { status: "hits", hits: hits.map(toNativeFastContextHit) };
    } finally {
      await memory.provider.close();
      params.context.assertCurrent();
    }
  }

  // The memory runtime owns whether memory/session search is active for this
  // agent. Talk only consumes the current manager when it is already available.
  const memory = await getActiveMemorySearchManagerCore({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  params.context.assertCurrent();
  if (!memory.manager) {
    return {
      status: "unavailable",
      error: memory.error ?? "no active memory manager",
    };
  }
  const rawHits = await memory.manager.search(params.query, {
    maxResults: params.config.maxResults,
    sessionKey: params.sessionKey,
    sources: params.config.sources,
  });
  params.context.assertCurrent();
  // This shortcut runs before an agent sandbox exists, but it still carries
  // the voice session identity needed for ordinary session-history visibility.
  const hits = await authorizeActiveMemorySearchHits({
    cfg: params.cfg,
    agentId: params.agentId,
    requesterSessionKey: params.sessionKey,
    sandboxed: false,
    hits: rawHits,
  });
  params.context.assertCurrent();
  return {
    status: "hits",
    hits: hits.map((hit) => ({
      source: hit.source,
      location: `${hit.path}:${hit.startLine}-${hit.endLine}`,
      snippet: hit.snippet,
    })),
  };
}

export async function resolveRealtimeVoiceFastContextConsult(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  config: RealtimeVoiceFastContextConfig;
  args: unknown;
  logger: Logger;
  labels?: Partial<RealtimeVoiceFastContextLabels>;
  /** Optional for plugins released before it existed; native providers require it. */
  liveness?: RealtimeVoiceFastContextLiveness;
}): Promise<RealtimeVoiceFastContextConsultResult> {
  if (!params.config.enabled) {
    return { handled: false };
  }

  const labels = {
    audienceLabel: params.labels?.audienceLabel?.trim() || "person",
    contextName: params.labels?.contextName?.trim() || "OpenClaw memory context",
  };
  const parsed = parseRealtimeVoiceAgentConsultArgs(params.args);
  const query = [parsed.question, parsed.context].filter(Boolean).join("\n\n");
  // The lookup's own lifetime ends on return or timeout; aborting it cancels
  // provider work still in flight instead of letting it outlive the request.
  const lookupLifetime = new AbortController();
  const signal = params.liveness?.signal
    ? AbortSignal.any([params.liveness.signal, lookupLifetime.signal])
    : lookupLifetime.signal;
  // The host derives session authority from the call's session key; the call
  // owner only supplies liveness, so it cannot widen the caller's authority.
  const context: MemoryCallerContext = {
    authority: { kind: "session", sessionKey: params.sessionKey, sandboxed: false },
    signal,
    assertCurrent() {
      if (lookupLifetime.signal.aborted) {
        throw new Error("voice context request has ended");
      }
      signal.throwIfAborted();
      params.liveness?.assertCurrent();
    },
  };
  try {
    const timeoutMs = resolveTimerTimeoutMs(params.config.timeoutMs, 1);
    const lookup = await withTimeout(
      lookupFastContext({
        cfg: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        config: params.config,
        query,
        context,
        callerSuppliedLiveness: params.liveness !== undefined,
      }),
      timeoutMs,
      { createError: () => new Error(`fast context lookup timed out after ${timeoutMs}ms`) },
    );
    context.assertCurrent();
    if (lookup.status === "unavailable") {
      params.logger.debug?.(`[talk] fast context unavailable: ${lookup.error}`);
    } else if (lookup.hits.length > 0) {
      return {
        handled: true,
        result: { text: buildContextText({ query, hits: lookup.hits, labels }) },
      };
    }
  } catch (error) {
    const message = formatErrorMessage(error);
    params.logger.debug?.(`[talk] fast context lookup failed: ${message}`);
  } finally {
    lookupLifetime.abort(new Error("voice context request has ended"));
  }
  // Misses, unavailable context, and failures share the caller's fallback policy.
  return params.config.fallbackToConsult
    ? { handled: false }
    : { handled: true, result: { text: buildMissText(query, labels) } };
}
