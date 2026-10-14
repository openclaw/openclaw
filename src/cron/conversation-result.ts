import { isAudioFileName } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveMirroredTranscriptText } from "../config/sessions/transcript-mirror.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  attachManagedOutgoingMediaToMessage,
  removeManagedOutgoingMediaBlocks,
} from "../gateway/managed-image-attachments.js";
import {
  buildAssistantReplyContent,
  hasAssistantDisplayMediaContent,
  hasManagedOutgoingAssistantContent,
} from "../gateway/server-methods/chat-assistant-content.js";
import { bindOutboundSessionEntry } from "../infra/outbound/outbound-session.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
  resolveOutboundPayloadMirrorText,
} from "../infra/outbound/payloads.js";
import { hasReplyChannelData } from "../interactive/payload.js";
import { logWarn } from "../logger.js";
import { getAgentScopedMediaLocalRootsForSources } from "../media/local-roots.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { commitBackgroundResultToSession } from "../sessions/background-session-result.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import type { CronCompletionDeliveryFence } from "./delivery-attempt-fence.js";
import type { DeliveryTargetResolution } from "./isolated-agent/delivery-target.js";
import { createCronRunDiagnosticsFromError } from "./run-diagnostics.js";
import { createCronExecutionId } from "./run-id.js";
import type { CronRunDiagnostics } from "./types.js";

export type CronConversationResultParams = {
  config: OpenClawConfig;
  agentId: string;
  jobId: string;
  runStartedAt: number;
  conversation: { sessionKey: string; sessionId: string; lifecycleRevision?: string };
  payloads: ReplyPayload[];
  text?: string;
  signal?: AbortSignal;
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
};

export type CronResultConversation = {
  conversation?: CronConversationResultParams["conversation"];
  diagnostics?: CronRunDiagnostics;
};

type CronResultConversationParams = {
  config: OpenClawConfig;
  agentId: string;
  delivery: DeliveryTargetResolution;
  source?: CronConversationResultParams["conversation"];
  sourceSessionKey?: string;
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
};

/** Resolve existing context without creating a destination or changing its remembered route. */
export async function resolveCronResultConversation(
  params: CronResultConversationParams,
): Promise<CronResultConversation> {
  return resolveCronResultConversationEntry(params, false);
}

/** Bind destination context only after a confirmed external delivery. */
export async function bindCronResultConversation(
  params: CronResultConversationParams,
): Promise<CronResultConversation> {
  return resolveCronResultConversationEntry(params, true);
}

async function resolveCronResultConversationEntry(
  params: CronResultConversationParams,
  bindDestination: boolean,
): Promise<CronResultConversation> {
  if (!params.delivery.ok) {
    return { conversation: params.source };
  }
  const route = params.delivery.sessionRoute;
  if (!route) {
    throw new Error("cron destination has no conversation route");
  }
  if (
    route.recipientSessionExact === false &&
    normalizeAgentId(
      resolveAgentRoute({
        cfg: params.config,
        channel: params.delivery.channel,
        defaultAgentId: params.agentId,
        accountId: params.delivery.accountId,
        peer: route.peer,
      }).agentId,
    ) !== normalizeAgentId(params.agentId)
  ) {
    return {
      diagnostics: createCronRunDiagnosticsFromError(
        "delivery",
        "Conversation context skipped: the destination belongs to a different agent.",
        { severity: "warn" },
      ),
    };
  }
  if (
    !bindDestination &&
    params.source &&
    route.sessionKey ===
      toAgentStoreSessionKey({
        agentId: params.agentId,
        requestKey: params.source.sessionKey,
        mainKey: params.config.session?.mainKey,
      })
  ) {
    return { conversation: { ...params.source, sessionKey: route.sessionKey } };
  }
  const storePath = resolveSessionStorePathCore(params.config.session?.store, {
    agentId: params.agentId,
  });
  if (bindDestination) {
    await params.deliveryAttemptFence?.beforeAttempt();
    await bindOutboundSessionEntry({
      cfg: params.config,
      channel: params.delivery.channel,
      accountId: params.delivery.accountId,
      route,
      sourceSessionKey: params.sourceSessionKey,
      workerGuard: {
        assertMutationAllowed: () => params.deliveryAttemptFence?.assertCurrent(),
      },
    });
  }
  const entry = await readSessionEntryInWorker({
    sessionKey: route.sessionKey,
    storePath,
    readConsistency: "latest",
  });
  if (!entry) {
    if (bindDestination) {
      throw new Error("cron destination conversation is unavailable");
    }
    return {};
  }
  return {
    conversation: {
      sessionKey: route.sessionKey,
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
    },
  };
}

/** Commit final output, not the private run transcript or an external notification mirror. */
export async function commitCronConversationResult(
  params: CronConversationResultParams,
): Promise<{ ok: true; diagnostics?: CronRunDiagnostics } | { ok: false; reason: string }> {
  const sourceSessionKey = params.conversation.sessionKey.trim();
  if (!sourceSessionKey) {
    return {
      ok: false as const,
      reason: "cron result is missing its destination conversation",
    };
  }
  const sourceSessionGeneration = {
    sessionId: params.conversation.sessionId,
    lifecycleRevision: params.conversation.lifecycleRevision,
  };
  const transcriptPayloads = params.payloads.map((payload) => {
    const spokenText = normalizeOptionalString(payload.spokenText);
    if (!spokenText) {
      return payload;
    }
    const mediaUrls = [payload.mediaUrl, ...(payload.mediaUrls ?? [])].filter(
      (url): url is string => Boolean(url) && !isAudioFileName(url),
    );
    return copyReplyPayloadMetadata(payload, {
      ...payload,
      text: spokenText,
      spokenText: undefined,
      audioAsVoice: undefined,
      mediaUrl: undefined,
      mediaUrls,
    });
  });
  const mirror = projectOutboundPayloadPlanForMirror(createOutboundPayloadPlan(transcriptPayloads));
  const completionText =
    resolveMirroredTranscriptText(mirror) ?? normalizeOptionalString(params.text);
  if (!completionText) {
    if (transcriptPayloads.some((payload) => hasReplyChannelData(payload.channelData))) {
      return {
        ok: true,
        diagnostics: createCronRunDiagnosticsFromError(
          "delivery",
          "native-only payload not added to conversation",
          { severity: "warn" },
        ),
      };
    }
    return { ok: false as const, reason: "cron result has no visible payload" };
  }
  const runId = createCronExecutionId(params.jobId, params.runStartedAt);
  let preparedContent: Record<string, unknown>[] | undefined;
  let appended = false;
  try {
    await params.deliveryAttemptFence?.beforeAttempt();
    const committed = await commitBackgroundResultToSession({
      agentId: params.agentId,
      sessionKey: sourceSessionKey,
      expectedGeneration: sourceSessionGeneration,
      text: completionText,
      prepareDisplayContent: async () => {
        const { assistantContent } = await buildAssistantReplyContent({
          sessionKey: sourceSessionKey,
          agentId: params.agentId,
          payloads: transcriptPayloads.map((payload) =>
            copyReplyPayloadMetadata(payload, {
              ...payload,
              text: resolveOutboundPayloadMirrorText(payload),
            }),
          ),
          managedMediaLocalRoots: getAgentScopedMediaLocalRootsForSources({
            cfg: params.config,
            agentId: params.agentId,
            mediaSources: mirror.mediaUrls,
          }),
          includeSensitiveMedia: false,
          onManagedMediaPrepareError: (message) => {
            logWarn(`[cron:${params.jobId}] result media embedding skipped: ${message}`);
          },
        });
        preparedContent = assistantContent;
        return hasAssistantDisplayMediaContent(preparedContent) ? preparedContent : undefined;
      },
      idempotencyKey: `cron-current-completion:${runId}`,
      provenance: { kind: "cron", jobId: params.jobId, runId },
      config: params.config,
      signal: params.signal,
      assertCurrent: () => {
        params.signal?.throwIfAborted();
        params.deliveryAttemptFence?.assertCurrent();
      },
      onMessageCommitted: (result, acceptCompletion) => {
        // Promote before publication; retries own the original committed blocks.
        // Preserve committed media even when promotion or the later drain fails.
        appended = result.appended;
        const blocks = readAssistantDisplayContent(result.message);
        if (hasManagedOutgoingAssistantContent(blocks)) {
          acceptCompletion(async () => {
            if (
              !(await attachManagedOutgoingMediaToMessage({
                messageId: result.messageId,
                blocks,
              }))
            ) {
              throw new Error("Cron result media ownership could not be persisted");
            }
          });
        }
      },
    });
    if (!committed.ok) {
      return committed;
    }
  } finally {
    if (!appended && preparedContent) {
      await removeManagedOutgoingMediaBlocks({ blocks: preparedContent, messageId: null });
    }
  }
  return { ok: true as const };
}
