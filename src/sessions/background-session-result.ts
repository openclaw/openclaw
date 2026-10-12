import { isAudioFileName } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { resolveCurrentConversationByDelivery } from "../config/sessions/conversation-registry.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { findTranscriptEvent } from "../config/sessions/session-transcript-match.js";
import { resolveMirroredTranscriptText } from "../config/sessions/transcript-mirror.js";
import type { SessionTranscriptAssistantMessage } from "../config/sessions/transcript.js";
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
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  bindOutboundSessionEntry,
  resolveOutboundSessionRoute,
  type OutboundSessionRoute,
} from "../infra/outbound/outbound-session.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
  resolveOutboundPayloadMirrorText,
} from "../infra/outbound/payloads.js";
import type { OutboundSessionContext } from "../infra/outbound/session-context.js";
import { hasReplyChannelData } from "../interactive/payload.js";
import { logWarn } from "../logger.js";
import { getAgentScopedMediaLocalRootsForSources } from "../media/local-roots.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import {
  ASSISTANT_DISPLAY_CONTENT_FIELD,
  readAssistantDisplayContent,
} from "../shared/assistant-display-content.js";
import {
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../shared/transcript-only-openclaw-assistant.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { deliveryContextKey } from "../utils/delivery-context.shared.js";
import {
  getSessionWorkAdmissionRelease,
  runExclusiveSessionLifecycleMutation,
} from "./session-lifecycle-admission.js";

// Background completions are durable conversation output, so this identity
// must stay outside the transcript-only delivery-mirror model set.
const AUTOMATION_RESULT_MODEL = "automation-result" as const;

type BackgroundSessionResultCommit =
  | { ok: true; messageId?: string; skipped?: boolean; diagnostics?: string }
  | { ok: false; reason: string };

type BackgroundSessionResultProvenance = {
  kind: "cron";
  jobId: string;
  runId: string;
};

/** Serializes a background assistant result behind active work on its target conversation. */
export async function commitBackgroundResultToSession(params: {
  agentId: string;
  sessionKey: string;
  /** Pins output to the conversation generation that admitted the background run. */
  expectedGeneration: { sessionId: string; lifecycleRevision: string | undefined };
  text?: string;
  payloads?: ReplyPayload[];
  idempotencyKey: string;
  provenance?: BackgroundSessionResultProvenance;
  config: OpenClawConfig;
  signal?: AbortSignal;
  /** Revalidate the producer after preparation and inside the transcript commit. */
  assertCurrent?: () => void;
}): Promise<BackgroundSessionResultCommit> {
  const sessionKey = params.sessionKey;
  const payloads = params.payloads?.map((payload) => {
    const spokenText = normalizeOptionalString(payload.spokenText);
    return spokenText
      ? copyReplyPayloadMetadata(payload, {
          ...payload,
          text: spokenText,
          spokenText: undefined,
          audioAsVoice: undefined,
          mediaUrl: undefined,
          mediaUrls: [payload.mediaUrl, ...(payload.mediaUrls ?? [])].filter(
            (url): url is string => Boolean(url) && !isAudioFileName(url),
          ),
        })
      : payload;
  });
  const mirror =
    payloads && projectOutboundPayloadPlanForMirror(createOutboundPayloadPlan(payloads));
  const text =
    (mirror && resolveMirroredTranscriptText(mirror)) ?? normalizeOptionalString(params.text);
  if (!text && payloads?.some((payload) => hasReplyChannelData(payload.channelData))) {
    return {
      ok: true,
      skipped: true,
      diagnostics: "native-only payload not added to conversation",
    };
  }
  const idempotencyKey = params.idempotencyKey;
  if (!text) {
    return { ok: false, reason: "background session result is missing required data" };
  }

  const storePath = resolveSessionStorePathCore(params.config.session?.store, {
    agentId: params.agentId,
  });
  const expectedSessionId = params.expectedGeneration.sessionId;
  const expectedLifecycleRevision = normalizeOptionalString(
    params.expectedGeneration.lifecycleRevision,
  );
  const identities = [sessionKey, expectedSessionId];

  let preparedContent: Record<string, unknown>[] | undefined;
  let appended = false;
  try {
    params.assertCurrent?.();
    return await runExclusiveSessionLifecycleMutation("background-result", {
      scope: storePath,
      identities,
      signal: params.signal,
      prepare: async () => {
        const released = getSessionWorkAdmissionRelease({ scope: storePath, identities });
        if (released) {
          await racePromiseWithAbortSignal(released, params.signal);
        }
      },
      run: async () => {
        params.assertCurrent?.();
        const current = loadSessionEntryReadOnly({
          agentId: params.agentId,
          sessionKey,
          storePath,
          readConsistency: "latest",
        });
        if (
          current?.sessionId !== expectedSessionId ||
          normalizeOptionalString(current.lifecycleRevision) !== expectedLifecycleRevision
        ) {
          return { ok: false, reason: `session rebound for sessionKey: ${sessionKey}` };
        }
        const unavailable = resolveSessionWorkStartError(sessionKey, current, {
          expectedSessionId,
          purpose: "accepted-result-settlement",
        });
        if (unavailable) {
          return { ok: false, reason: unavailable };
        }
        const scope = {
          agentId: params.agentId,
          sessionKey,
          sessionId: expectedSessionId,
          storePath,
        };
        // A retry owns the original committed payload, including its managed-media IDs.
        // Restaging media would conflict with the transcript's exact replay contract.
        const prior = await findTranscriptEvent(scope, {
          kind: "idempotency",
          key: idempotencyKey,
        });
        const priorMessage = prior && readTranscriptEventMessage(prior.event);
        const priorId = prior && readTranscriptEventId(prior.event);
        if (prior && (!priorMessage || !priorId)) {
          return { ok: false, reason: "background result transcript identity is unavailable" };
        }
        let displayContent: Record<string, unknown>[] | undefined;
        if (!priorMessage && payloads && mirror) {
          const { assistantContent } = await buildAssistantReplyContent({
            sessionKey,
            agentId: params.agentId,
            payloads: payloads.map((payload) =>
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
            onManagedMediaPrepareError: (message) =>
              logWarn(`Result media embedding skipped: ${message}`),
          });
          preparedContent = assistantContent;
          displayContent = hasAssistantDisplayMediaContent(assistantContent)
            ? assistantContent
            : undefined;
        }
        const message = {
          role: "assistant",
          content: [{ type: "text", text }],
          ...(displayContent ? { [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent } : {}),
          api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
          provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
          model: AUTOMATION_RESULT_MODEL,
          usage: makeZeroUsageSnapshot(),
          stopReason: "stop",
          timestamp: Date.now(),
          idempotencyKey,
          ...(params.provenance ? { openclawAutomation: params.provenance } : {}),
        } satisfies SessionTranscriptAssistantMessage & {
          idempotencyKey: string;
          openclawAutomation?: BackgroundSessionResultProvenance;
        };
        params.assertCurrent?.();
        const committed = await persistSessionTranscriptTurn(scope, {
          cwd: current.spawnedCwd,
          expectedSessionId,
          expectedLifecycleRevision: expectedLifecycleRevision ?? null,
          assertCurrent: () => {
            params.assertCurrent?.();
            params.signal?.throwIfAborted();
          },
          messages: [
            {
              message: priorMessage
                ? {
                    ...priorMessage,
                    content: message.content,
                    ...(params.provenance ? { openclawAutomation: params.provenance } : {}),
                  }
                : message,
              idempotencyLookup: "scan",
              ...(priorId
                ? {
                    eventId: priorId,
                    predicate: {
                      kind: "active-entry" as const,
                      entryId: priorId,
                      errorMessage: "background result no longer owns the active transcript",
                    },
                  }
                : {}),
            },
          ],
          touchSessionEntry: true,
          updateMode: "inline",
          // A retry can finish media ownership after a committed append failed to publish.
          publishWhen: payloads ? "always" : undefined,
          config: params.config,
          onMessageCommitted: (result, acceptCompletion) => {
            appended = result.appended;
            const blocks = readAssistantDisplayContent(result.message);
            if (payloads && hasManagedOutgoingAssistantContent(blocks)) {
              acceptCompletion(async () => {
                if (
                  !(await attachManagedOutgoingMediaToMessage({
                    messageId: result.messageId,
                    blocks,
                  }))
                ) {
                  throw new Error("Result media ownership could not be persisted");
                }
              });
            }
          },
        });
        const resultMessage = committed.messages[0];
        return resultMessage
          ? { ok: true, messageId: resultMessage.messageId }
          : {
              ok: false,
              reason: committed.rejectedReason ?? "background result was not committed",
            };
      },
    });
  } finally {
    if (!appended && preparedContent) {
      await removeManagedOutgoingMediaBlocks({ blocks: preparedContent, messageId: null });
    }
  }
}

export type ConfirmedVisibleMessageParams = {
  config: OpenClawConfig;
  channel: ChannelId;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  route?: OutboundSessionRoute | null;
  producer?: OutboundSessionContext;
  payload: ReplyPayload;
  deliveryId: string;
  payloadIndex: number;
  signal?: AbortSignal;
  expectedGeneration?: { sessionKey?: string; sessionId: string; lifecycleRevision?: string };
  assertCurrent?: () => void;
  /** Fences new route-discovery I/O, not persistence of an accepted delivery. */
  assertDirectAdapterHandoff?: () => void;
};

/** Commits only confirmed external output; a producing conversation already owns its own turn. */
export async function commitConfirmedVisibleMessage(
  params: ConfirmedVisibleMessageParams,
): Promise<{ ok: true; skipped?: boolean; diagnostics?: string } | { ok: false; reason: string }> {
  const agentId = params.producer?.agentId ?? resolveDefaultAgentId(params.config);
  const storePath = resolveSessionStorePathCore(params.config.session?.store, { agentId });
  const keyScope = { agentId, mainKey: params.config.session?.mainKey };
  const producerKey = params.producer?.key
    ? toAgentStoreSessionKey({ ...keyScope, requestKey: params.producer.key })
    : undefined;
  let route = params.route;
  if (
    route &&
    producerKey === toAgentStoreSessionKey({ ...keyScope, requestKey: route.sessionKey })
  ) {
    return { ok: true, skipped: true };
  }
  const producer = producerKey
    ? await readSessionEntryInWorker({
        sessionKey: producerKey,
        storePath,
        readConsistency: "latest",
      })
    : undefined;
  const context = deliveryContextFromSession(producer);
  const producerContext = deliveryContextKey({
    ...context,
    accountId: normalizeAccountId(context?.accountId),
  });
  const matchesProducer = (to: string, threadId: string | number | null | undefined) => {
    const destinationContext = deliveryContextKey({
      channel: params.channel,
      to,
      accountId: normalizeAccountId(params.accountId),
      threadId: threadId ?? undefined,
    });
    return Boolean(producerKey && destinationContext && destinationContext === producerContext);
  };
  if (matchesProducer(route?.to ?? params.to, route?.threadId ?? params.threadId)) {
    return { ok: true, skipped: true };
  }
  const localSelection = route
    ? undefined
    : await resolveCurrentConversationByDelivery(
        { agentId, storePath },
        {
          channel: params.channel,
          accountId: normalizeAccountId(params.accountId),
          target: params.to.trim(),
          threadId: params.threadId == null ? undefined : String(params.threadId),
        },
      );
  const local = localSelection?.conversation;
  if (localSelection?.ambiguous) {
    logWarn("Conversation context lookup is ambiguous: multiple current destinations match.");
    return {
      ok: true,
      skipped: true,
      diagnostics: "Conversation context skipped: multiple current destinations match.",
    };
  }
  if (!local && route === undefined) {
    route = await resolveOutboundSessionRoute({
      cfg: params.config,
      channel: params.channel,
      agentId,
      accountId: params.accountId,
      target: params.to,
      threadId: params.threadId,
      assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
    });
  }
  const destination =
    route ??
    (local?.sessionKey
      ? { sessionKey: local.sessionKey, peer: { kind: local.kind, id: local.peerId } }
      : undefined);
  if (!destination) {
    return {
      ok: true,
      skipped: true,
      diagnostics:
        "Conversation context skipped: destination conversation could not be resolved without a network lookup.",
    };
  }
  if (
    normalizeAgentId(
      resolveAgentRoute({
        cfg: params.config,
        channel: params.channel,
        defaultAgentId: agentId,
        accountId: params.accountId,
        peer: destination.peer,
      }).agentId,
    ) !== normalizeAgentId(agentId)
  ) {
    return {
      ok: true,
      skipped: true,
      diagnostics: "Conversation context skipped: the destination belongs to a different agent.",
    };
  }
  const destinationKey = toAgentStoreSessionKey({
    ...keyScope,
    requestKey: destination.sessionKey,
  });
  if (producerKey === destinationKey) {
    return { ok: true, skipped: true };
  }
  if (route && matchesProducer(route.to, route.threadId ?? params.threadId)) {
    return { ok: true, skipped: true };
  }

  const payload = params.payload;
  if (
    !normalizeOptionalString(payload.text) &&
    !normalizeOptionalString(payload.spokenText) &&
    !payload.mediaUrl &&
    !payload.mediaUrls?.length
  ) {
    return {
      ok: true,
      skipped: true,
      ...(hasReplyChannelData(payload.channelData)
        ? { diagnostics: "native-only payload not added to conversation" }
        : {}),
    };
  }
  params.assertCurrent?.();
  if (route) {
    await bindOutboundSessionEntry({
      cfg: params.config,
      channel: params.channel,
      accountId: params.accountId,
      route,
      sourceSessionKey: producerKey,
      assertCommitAllowed: params.assertCurrent,
    });
  }
  const entry = await readSessionEntryInWorker({
    sessionKey: destinationKey,
    storePath,
    readConsistency: "latest",
  });
  if (!entry) {
    return { ok: false, reason: "destination conversation is unavailable" };
  }
  const expected = params.expectedGeneration;
  const generationMatches =
    !expected?.sessionKey ||
    destinationKey ===
      toAgentStoreSessionKey({
        agentId,
        requestKey: expected.sessionKey,
        mainKey: params.config.session?.mainKey,
      });
  const generation = expected && generationMatches ? expected : entry;
  return commitBackgroundResultToSession({
    agentId,
    sessionKey: destinationKey,
    expectedGeneration: {
      sessionId: generation.sessionId,
      lifecycleRevision: generation.lifecycleRevision,
    },
    payloads: [payload],
    idempotencyKey: `outbound-delivery:${params.deliveryId}:${params.payloadIndex}`,
    config: params.config,
    signal: params.signal,
    assertCurrent: params.assertCurrent,
  });
}
