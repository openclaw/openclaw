import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { readAcpSessionEntryAsync } from "../../acp/runtime/session-meta.js";
import { resolveAgentIdFromSessionKey, resolveAgentMainSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  loadVoiceWakeRoutingConfig,
  resolveVoiceWakeRouteByTrigger,
} from "../../infra/voicewake-routing.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import {
  annotateInterSessionPromptText,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import {
  isGatewayMessageChannel,
  isInternalNonDeliveryChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { resolveChatAttachmentMaxBytes } from "../chat-attachment-policy.js";
import {
  MediaOffloadError,
  logAttachmentFailure,
  parseMessageWithAttachments,
  type ChatAttachment,
  type ChatImageContent,
  type OffloadedRef,
} from "../chat-attachments.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import {
  loadSessionEntry,
  resolveGatewayModelSupportsImages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { resolveVoiceWakeSessionTarget } from "../voicewake-session-target.js";
import { formatForLog } from "../ws-log.js";
import { AgentRequestReservationEndedError } from "./agent-dedupe.js";
import type { AgentTurnContext } from "./types.js";

type ExplicitRecipientSession = Awaited<
  ReturnType<
    typeof import("../../infra/outbound/agent-delivery.js").resolveAgentExplicitRecipientSession
  >
>;

export async function prepareAgentContentPhase(params: {
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  context: AgentTurnContext;
  respond: GatewayRequestHandlerOptions["respond"];
  isRawModelRun: boolean;
  inputProvenance?: InputProvenance;
  normalizedAttachments: ChatAttachment[];
  requestedSessionKeyRaw?: string;
  requestedSessionKey?: string;
  requestedSessionId?: string;
  requestedToRaw?: string;
  sessionKeyFromTo?: string;
  agentId?: string;
  providerOverride?: string;
  modelOverride?: string;
  explicitRecipientSession?: ExplicitRecipientSession;
  knownAgents: string[];
  assertAdmissionCurrent?: () => void;
}) {
  const transcriptInputText = params.request.message.trim();
  let message = params.isRawModelRun
    ? transcriptInputText
    : annotateInterSessionPromptText(transcriptInputText, params.inputProvenance);
  let images: ChatImageContent[] = [];
  let imageOrder: PromptImageOrderEntry[] = [];
  let media: MediaFact[] = [];
  let offloadedRefs: OffloadedRef[] = [];
  let supportsInlineImages: boolean | undefined;
  let agentId = params.agentId;
  let requestedSessionKey = params.requestedSessionKey;

  const isKnownGatewayChannel = (value: string): boolean =>
    isGatewayMessageChannel(value) || isInternalNonDeliveryChannel(value);
  const channelHints = normalizeTrimmedStringList([
    params.request.channel,
    params.request.replyChannel,
  ]);
  for (const rawChannel of channelHints) {
    const normalized = normalizeMessageChannel(rawChannel);
    if (normalized && normalized !== "last" && !isKnownGatewayChannel(normalized)) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: unknown channel: ${normalized}`,
        ),
      );
      return undefined;
    }
  }

  if (params.normalizedAttachments.length > 0) {
    let baseProvider: string | undefined;
    let baseModel: string | undefined;
    let catalogAgentId = agentId;
    let isConfirmedAcpSession = false;
    if (params.requestedSessionKeyRaw) {
      const target = resolveSessionStoreIdentity({
        cfg: params.cfg,
        sessionKey: params.requestedSessionKeyRaw,
        agentId,
      });
      const session = await readAcpSessionEntryAsync({
        cfg: params.cfg,
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        assertCurrent: params.assertAdmissionCurrent,
      });
      params.assertAdmissionCurrent?.();
      catalogAgentId = target.agentId;
      const modelRef = resolveSessionModelRef(
        session?.cfg ?? params.cfg,
        session?.entry,
        target.agentId,
      );
      baseProvider = modelRef.provider;
      baseModel = modelRef.model;
      isConfirmedAcpSession =
        params.request.acpTurnSource === "manual_spawn" &&
        isAcpSessionKey(params.requestedSessionKeyRaw) &&
        session?.acp != null;
    }
    supportsInlineImages = isConfirmedAcpSession
      ? true
      : await resolveGatewayModelSupportsImages({
          loadGatewayModelCatalog: params.context.loadGatewayModelCatalog,
          loadGatewayModelCatalogSnapshot: params.context.loadGatewayModelCatalogSnapshot,
          agentId: catalogAgentId,
          provider: params.providerOverride || baseProvider,
          model: params.modelOverride || baseModel,
        });
  }

  const voiceWakeTrigger = normalizeOptionalString(params.request.voiceWakeTrigger) ?? "";
  const replyTo = normalizeOptionalString(params.request.replyTo) ?? "";
  const recipientChannel = params.explicitRecipientSession?.channel ?? params.request.channel;
  const recipientAccountId = params.explicitRecipientSession?.accountId ?? params.request.accountId;
  const recipientThreadId = params.explicitRecipientSession?.threadId ?? params.request.threadId;
  const to = params.sessionKeyFromTo
    ? ""
    : (params.explicitRecipientSession?.to ?? params.requestedToRaw ?? "");
  const canAutoRouteVoiceWake =
    Object.hasOwn(params.request, "voiceWakeTrigger") &&
    !normalizeOptionalString(params.request.agentId) &&
    !params.requestedSessionId &&
    !replyTo &&
    !to;
  const explicitVoiceWakeSessionTarget =
    canAutoRouteVoiceWake && params.requestedSessionKeyRaw
      ? (() => {
          const { cfg, canonicalKey } = loadSessionEntry(params.requestedSessionKeyRaw!, {
            ...(agentId ? { agentId } : {}),
            clone: false,
            projection: "list",
          });
          const routedAgentId = resolveAgentIdFromSessionKey(canonicalKey, agentId);
          const compatibilityOwner = tryResolveSessionCompatibilityOwnerAgentId(cfg, canonicalKey);
          if (!compatibilityOwner || routedAgentId !== compatibilityOwner) {
            return true;
          }
          return canonicalKey !== resolveAgentMainSessionKey({ cfg, agentId: routedAgentId });
        })()
      : false;
  if (canAutoRouteVoiceWake && !explicitVoiceWakeSessionTarget) {
    try {
      const route = resolveVoiceWakeRouteByTrigger({
        trigger: voiceWakeTrigger || undefined,
        config: await loadVoiceWakeRoutingConfig(),
      });
      const target = resolveVoiceWakeSessionTarget({
        route,
        cfg: params.cfg,
        knownAgents: params.knownAgents,
        trigger: voiceWakeTrigger,
        warn: (message) => params.context.logGateway.warn(message),
      });
      if (target) {
        agentId = target.agentId;
        requestedSessionKey = target.sessionKey;
      }
    } catch (err) {
      params.context.logGateway.warn(`voicewake routing load failed: ${formatForLog(err)}`);
    }
  }

  if (params.normalizedAttachments.length > 0) {
    params.assertAdmissionCurrent?.();
    try {
      const parsed = await parseMessageWithAttachments(message, params.normalizedAttachments, {
        maxBytes: resolveChatAttachmentMaxBytes(params.cfg),
        log: params.context.logGateway,
        supportsInlineImages,
        acceptNonImage: false,
        assertCurrent: params.assertAdmissionCurrent,
      });
      message = parsed.message.trim();
      images = parsed.images;
      imageOrder = parsed.imageOrder;
      media = parsed.media;
      offloadedRefs = parsed.offloadedRefs;
    } catch (err) {
      if (err instanceof AgentRequestReservationEndedError) {
        throw err;
      }
      logAttachmentFailure(params.context.logGateway, "agent attachment parse failed", err);
      params.respond(
        false,
        undefined,
        err instanceof SessionMutationAuthorizationChangedError
          ? err.error
          : errorShape(
              err instanceof MediaOffloadError
                ? ErrorCodes.UNAVAILABLE
                : ErrorCodes.INVALID_REQUEST,
              String(err),
            ),
      );
      return undefined;
    }
  }

  return {
    agentId,
    requestedSessionKey,
    effectiveTranscriptInputText: transcriptInputText,
    message,
    images,
    imageOrder,
    media,
    offloadedRefs,
    replyTo,
    recipientChannel,
    recipientAccountId,
    recipientThreadId,
    to,
  };
}
