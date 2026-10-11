import { isAudioFileName } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
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
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { deliveryContextKey } from "../utils/delivery-context.shared.js";
import { commitBackgroundResultToSession } from "./background-session-result.js";

export type ConfirmedVisibleMessageParams = {
  config: OpenClawConfig;
  channel: ChannelId;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  route?: OutboundSessionRoute;
  producer?: OutboundSessionContext;
  payload: ReplyPayload;
  deliveryId: string;
  payloadIndex: number;
  signal?: AbortSignal;
  expectedGeneration?: { sessionId: string; lifecycleRevision?: string };
  assertCurrent?: () => void;
};

/** Commits only confirmed external output; a producing conversation already owns its own turn. */
export async function commitConfirmedVisibleMessage(
  params: ConfirmedVisibleMessageParams,
): Promise<{ ok: true; skipped?: boolean; diagnostics?: string } | { ok: false; reason: string }> {
  const agentId = params.producer?.agentId ?? resolveDefaultAgentId(params.config);
  const route =
    params.route ??
    (await resolveOutboundSessionRoute({
      cfg: params.config,
      channel: params.channel,
      agentId,
      accountId: params.accountId,
      target: params.to,
      threadId: params.threadId,
    }));
  if (!route) {
    return { ok: true, skipped: true };
  }
  if (
    normalizeAgentId(
      resolveAgentRoute({
        cfg: params.config,
        channel: params.channel,
        defaultAgentId: agentId,
        accountId: params.accountId,
        peer: route.peer,
      }).agentId,
    ) !== normalizeAgentId(agentId)
  ) {
    return {
      ok: true,
      skipped: true,
      diagnostics: "Conversation context skipped: the destination belongs to a different agent.",
    };
  }
  const storePath = resolveSessionStorePathCore(params.config.session?.store, { agentId });
  const producerKey = params.producer?.key
    ? toAgentStoreSessionKey({
        agentId,
        requestKey: params.producer.key,
        mainKey: params.config.session?.mainKey,
      })
    : undefined;
  const destinationKey = toAgentStoreSessionKey({
    agentId,
    requestKey: route.sessionKey,
    mainKey: params.config.session?.mainKey,
  });
  if (producerKey === destinationKey) {
    return { ok: true, skipped: true };
  }
  if (producerKey) {
    const producer = await readSessionEntryInWorker({
      sessionKey: producerKey,
      storePath,
      readConsistency: "latest",
    });
    const context = deliveryContextFromSession(producer);
    const destinationContext = deliveryContextKey({
      channel: params.channel,
      to: route.to,
      accountId: normalizeAccountId(params.accountId),
      threadId: route.threadId ?? params.threadId ?? undefined,
    });
    if (
      destinationContext ===
      deliveryContextKey({
        ...context,
        accountId: normalizeAccountId(context?.accountId),
      })
    ) {
      return { ok: true, skipped: true };
    }
    const sourceRoute =
      context?.channel === params.channel && context.to
        ? await resolveOutboundSessionRoute({
            cfg: params.config,
            channel: params.channel,
            agentId,
            accountId: context.accountId,
            target: context.to,
            threadId: context.threadId,
          })
        : undefined;
    const sourceContext = deliveryContextKey({
      ...context,
      to: sourceRoute?.to ?? context?.to,
      accountId: normalizeAccountId(context?.accountId),
      threadId: sourceRoute?.threadId ?? context?.threadId,
    });
    if (destinationContext && destinationContext === sourceContext) {
      return { ok: true, skipped: true };
    }
  }

  const spokenText = normalizeOptionalString(params.payload.spokenText);
  const payload = spokenText
    ? copyReplyPayloadMetadata(params.payload, {
        ...params.payload,
        text: spokenText,
        spokenText: undefined,
        audioAsVoice: undefined,
        mediaUrl: undefined,
        mediaUrls: [params.payload.mediaUrl, ...(params.payload.mediaUrls ?? [])].filter(
          (url): url is string => Boolean(url) && !isAudioFileName(url),
        ),
      })
    : params.payload;
  const mirror = projectOutboundPayloadPlanForMirror(createOutboundPayloadPlan([payload]));
  const text = resolveMirroredTranscriptText(mirror);
  if (!text) {
    return hasReplyChannelData(payload.channelData)
      ? { ok: true, skipped: true, diagnostics: "native-only payload not added to conversation" }
      : { ok: true, skipped: true };
  }
  params.assertCurrent?.();
  await bindOutboundSessionEntry({
    cfg: params.config,
    channel: params.channel,
    accountId: params.accountId,
    route,
    sourceSessionKey: producerKey,
    assertCommitAllowed: params.assertCurrent,
  });
  const entry = await readSessionEntryInWorker({
    sessionKey: destinationKey,
    storePath,
    readConsistency: "latest",
  });
  if (!entry) {
    return { ok: false, reason: "destination conversation is unavailable" };
  }
  let preparedContent: Record<string, unknown>[] | undefined;
  let appended = false;
  try {
    return await commitBackgroundResultToSession({
      agentId,
      sessionKey: destinationKey,
      expectedGeneration: params.expectedGeneration ?? {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
      },
      text,
      idempotencyKey: `outbound-delivery:${params.deliveryId}:${params.payloadIndex}`,
      config: params.config,
      signal: params.signal,
      assertCurrent: params.assertCurrent,
      prepareDisplayContent: async () => {
        const { assistantContent } = await buildAssistantReplyContent({
          sessionKey: destinationKey,
          agentId,
          payloads: [
            copyReplyPayloadMetadata(payload, {
              ...payload,
              text: resolveOutboundPayloadMirrorText(payload),
            }),
          ],
          managedMediaLocalRoots: getAgentScopedMediaLocalRootsForSources({
            cfg: params.config,
            agentId,
            mediaSources: mirror.mediaUrls,
          }),
          includeSensitiveMedia: false,
          onManagedMediaPrepareError: (message) =>
            logWarn(`Outbound result media embedding skipped: ${message}`),
        });
        preparedContent = assistantContent;
        return hasAssistantDisplayMediaContent(preparedContent) ? preparedContent : undefined;
      },
      onMessageCommitted: (result, acceptCompletion) => {
        appended = result.appended;
        const blocks = readAssistantDisplayContent(result.message);
        if (hasManagedOutgoingAssistantContent(blocks)) {
          acceptCompletion(async () => {
            if (
              !(await attachManagedOutgoingMediaToMessage({ messageId: result.messageId, blocks }))
            ) {
              throw new Error("Outbound result media ownership could not be persisted");
            }
          });
        }
      },
    });
  } finally {
    if (!appended && preparedContent) {
      await removeManagedOutgoingMediaBlocks({ blocks: preparedContent, messageId: null });
    }
  }
}
