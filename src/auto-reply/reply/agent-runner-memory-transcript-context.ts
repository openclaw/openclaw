import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { resolveEmbeddedSessionContextLimits } from "../../agents/embedded-agent-runner/run/session-context-limits.js";
import { createToolResultPromptProjectionState } from "../../agents/embedded-agent-runner/session-prompt-state.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type {
  SessionTranscriptAccountingSnapshot,
  SessionTranscriptUsageSnapshot,
} from "../../config/sessions/session-transcript-accounting.types.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence.js";
import {
  readSessionMessagesAsync,
  readSessionTranscriptAccountingAsync,
} from "../../gateway/session-transcript-readers.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

const toolResultTruncationRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/embedded-agent-runner/tool-result-truncation.js"),
);

type TranscriptScope = {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
};

export async function readPreflightTranscriptContextMessages(
  scope: TranscriptScope & { contextWindowTokens: number },
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  const limits = resolveEmbeddedSessionContextLimits({
    contextTokenBudget: scope.contextWindowTokens,
  });
  const readLegacyProjection = async () => {
    signal?.throwIfAborted();
    const messages = (await readSessionMessagesAsync(scope, {
      mode: "recent",
      maxMessages: limits.maxEvents,
      maxLines: limits.maxEvents,
      maxBytes: limits.maxBytes,
    })) as AgentMessage[]; // SAFETY: Gateway readers project stored rows as AgentMessage values.
    signal?.throwIfAborted();
    return messages.filter(
      (message) => !("excludeFromContext" in message && message.excludeFromContext === true),
    );
  };

  if (!scope.storePath || !scope.sessionKey) {
    return await readLegacyProjection();
  }
  const target = { ...scope, sessionKey: scope.sessionKey, storePath: scope.storePath };
  try {
    const context = await SessionManager.openModelContextAsync(target, { signal, limits });
    const messages = context.buildSessionContext().messages;
    if (messages.length > 0 || context.getEntries().length > 0) {
      return messages;
    }
    // Headerless legacy projections have no canonical model-context entries.
    return await readLegacyProjection();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !==
        "Persisted legacy session transcripts require doctor/import migration before runtime use"
    ) {
      throw error;
    }
    return await readLegacyProjection();
  }
}

export async function readSessionLogSnapshot(params: {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  includeByteSize: boolean;
  includeTurnTaint?: boolean;
  includeUsage: boolean;
  abortSignal?: AbortSignal;
}): Promise<SessionTranscriptAccountingSnapshot> {
  params.abortSignal?.throwIfAborted();
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  if (!params.sessionId || !params.storePath || !agentId) {
    return params.includeTurnTaint ? { turnTainted: true } : {};
  }
  const scope = {
    agentId,
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    storePath: params.storePath,
  };
  try {
    const snapshot = await readSessionTranscriptAccountingAsync(
      scope,
      {
        includeByteSize: params.includeByteSize,
        includeTurnTaint: params.includeTurnTaint,
        includeUsage: params.includeUsage,
      },
      params.abortSignal,
    );
    params.abortSignal?.throwIfAborted();
    return snapshot;
  } catch {
    params.abortSignal?.throwIfAborted();
    // Accounting is optional; failed reads leave usage unknown and flush taint conservative.
    return params.includeTurnTaint ? { turnTainted: true } : {};
  }
}

export type TranscriptTokenEstimate = {
  contextTokens: number;
};

function hasUsableProviderPromptUsage(
  usage: SessionTranscriptUsageSnapshot | undefined,
): usage is SessionTranscriptUsageSnapshot & { promptTokens: number } {
  return usage?.promptTokens !== undefined && usage.promptTokens > 0;
}

// Fresh totals include the provider usage anchor and any later projected messages.
async function estimateProviderPromptTokens(
  messages: AgentMessage[],
  contextWindowTokens: number,
  priorPromptTokens = 0,
): Promise<number> {
  if (messages.length === 0) {
    return Math.ceil(priorPromptTokens);
  }
  const { truncateOversizedToolResultsInMessages } = await toolResultTruncationRuntimeLoader.load();
  // Match first-dispatch trailing-result protection without freezing replacements
  // owned by the embedded session.
  const projected = truncateOversizedToolResultsInMessages(
    messages,
    contextWindowTokens,
    undefined,
    undefined,
    createToolResultPromptProjectionState(),
  ).messages;
  const tokens = estimateMessagesTokens(projected);
  return Math.ceil(priorPromptTokens) + Math.ceil(tokens);
}

export async function estimateContextTokensFromSessionTranscript(
  {
    abortSignal,
    ...params
  }: Parameters<typeof readPreflightTranscriptContextMessages>[0] & {
    abortSignal?: AbortSignal;
    contextWindowTokens: number;
  },
  initialSnapshot?: SessionTranscriptAccountingSnapshot,
): Promise<TranscriptTokenEstimate | undefined> {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return undefined;
  }
  try {
    const snapshot =
      initialSnapshot ??
      (await readSessionLogSnapshot({
        agentId: params.agentId,
        sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        includeByteSize: false,
        includeUsage: true,
        abortSignal,
      }));
    const usage = snapshot.usage;
    const providerUsage = hasUsableProviderPromptUsage(usage) ? usage : undefined;
    const messages = providerUsage
      ? providerUsage.trailingMessages
      : await readPreflightTranscriptContextMessages({ ...params, sessionId }, abortSignal);
    const contextTokens = await estimateProviderPromptTokens(
      messages,
      params.contextWindowTokens,
      providerUsage ? providerUsage.promptTokens + (providerUsage.outputTokens ?? 0) : 0,
    );
    return {
      contextTokens,
    };
  } catch (error) {
    abortSignal?.throwIfAborted();
    return error instanceof SessionTranscriptReadFenceError ? Promise.reject(error) : undefined;
  }
}
