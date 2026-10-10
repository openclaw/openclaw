import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { createToolResultPromptProjectionState } from "../../agents/embedded-agent-runner/session-prompt-state.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  SQLITE_USAGE_TAIL_MAX_EVENTS,
  type SessionTranscriptAccountingSnapshot,
  type SessionTranscriptUsageSnapshot,
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
  scope: TranscriptScope,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  const readLegacyProjection = async () => {
    signal?.throwIfAborted();
    const messages = (await readSessionMessagesAsync(scope, {
      mode: "full",
      reason: "preflight-compaction-estimate-legacy",
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const context = await SessionManager.openModelContextAsync(target, { signal });
      const messages = context.buildSessionContext().messages;
      if (messages.length > 0 || context.getEntries().length > 0) {
        return messages;
      }
      // Headerless legacy projections have no canonical model-context entries.
      return await readLegacyProjection();
    } catch (error) {
      if (error instanceof SessionTranscriptReadFenceError && attempt === 0) {
        continue;
      }
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
  throw new Error("Preflight transcript context retry exhausted");
}

export async function readSessionLogSnapshot(params: {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  includeByteSize: boolean;
  includeTurnTaint?: boolean;
  includeUsage: boolean;
  usageEventLimit?: number;
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
        usageEventLimit: params.usageEventLimit,
      },
      params.abortSignal,
    );
    params.abortSignal?.throwIfAborted();
    return snapshot;
  } catch {
    params.abortSignal?.throwIfAborted();
    return params.includeTurnTaint ? { turnTainted: true } : {};
  }
}

export type TranscriptTokenEstimate = {
  promptTokens: number;
  promptTokenSource:
    | "provider_usage"
    | "provider_usage_plus_prompt_projection"
    | "prompt_projection";
  outputTokens?: number;
  promptIncludesOutput?: boolean;
  transcriptByteSize?: number;
};

function hasUsableProviderPromptUsage(
  usage: SessionTranscriptUsageSnapshot | undefined,
): usage is SessionTranscriptUsageSnapshot & { promptTokens: number } {
  return (
    typeof usage?.promptTokens === "number" &&
    Number.isFinite(usage.promptTokens) &&
    usage.promptTokens > 0
  );
}

// Fresh totals include the provider usage anchor and any later projected messages.
async function estimateProviderPromptTokens(
  messages: AgentMessage[],
  contextWindowTokens: number,
  priorPromptTokens = 0,
): Promise<number | undefined> {
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
  return Number.isFinite(tokens) && tokens >= 0
    ? Math.ceil(priorPromptTokens) + Math.ceil(tokens)
    : undefined;
}

export async function estimatePromptTokensFromSessionTranscript(
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
        includeByteSize: true,
        includeUsage: true,
        abortSignal,
      }));
    let usage = snapshot.usage;
    if (
      !hasUsableProviderPromptUsage(usage) &&
      typeof snapshot.eventCount === "number" &&
      snapshot.eventCount > SQLITE_USAGE_TAIL_MAX_EVENTS
    ) {
      usage = (
        await readSessionLogSnapshot({
          agentId: params.agentId,
          sessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          includeByteSize: false,
          includeUsage: true,
          usageEventLimit: snapshot.eventCount,
          abortSignal,
        })
      ).usage;
    }
    const normalizedOutputTokens =
      usage?.outputTokens === undefined ? undefined : Math.ceil(usage.outputTokens);
    const providerUsage = hasUsableProviderPromptUsage(usage) ? usage : undefined;
    const messages = providerUsage
      ? providerUsage.trailingMessages
      : await readPreflightTranscriptContextMessages({ ...params, sessionId }, abortSignal);
    const promptTokens = await estimateProviderPromptTokens(
      messages,
      params.contextWindowTokens,
      providerUsage?.promptTokens,
    );
    if (promptTokens === undefined) {
      return undefined;
    }
    return {
      promptTokens,
      promptTokenSource: providerUsage
        ? messages.length > 0
          ? "provider_usage_plus_prompt_projection"
          : "provider_usage"
        : "prompt_projection",
      // Full-message estimation already includes assistant content. Preserve
      // output only for projection against a separate persisted prompt fact.
      ...(!providerUsage ? { promptIncludesOutput: true } : {}),
      outputTokens: normalizedOutputTokens,
      transcriptByteSize: snapshot.byteSize,
    };
  } catch (error) {
    abortSignal?.throwIfAborted();
    return error instanceof SessionTranscriptReadFenceError ? Promise.reject(error) : undefined;
  }
}
