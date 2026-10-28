import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { readAcpSessionEntryAsync } from "../../acp/runtime/session-meta.js";
import { resolvePersistedOverrideModelRef } from "../../agents/model-selection.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveExplicitAgentSessionKey,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  loadVoiceWakeRoutingConfig,
  resolveVoiceWakeRouteByTrigger,
} from "../../infra/voicewake-routing.js";
import { classifySessionKeyShape, isAcpSessionKey } from "../../routing/session-key.js";
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
  stripImageMediaMarkers,
  type ChatAttachment,
} from "../chat-attachments.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { respondError } from "../server-methods/response.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { resolveGatewayModelSupportsImages, resolveSessionModelRef } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { AgentRequestReservationEndedError } from "./agent-dedupe.js";
import type { AgentTurnContext } from "./types.js";

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
  explicitRecipientSession?: Awaited<
    ReturnType<
      typeof import("../../infra/outbound/agent-delivery.js").resolveAgentExplicitRecipientSession
    >
  >;
  knownAgents: string[];
  assertAdmissionCurrent?: () => void;
  onTargetResolved?: (target: {
    sessionKey?: string;
    agentId?: string;
  }) => boolean | void | Promise<boolean | void>;
}) {
  const transcriptInputText = params.request.message.trim();
  let content: Awaited<ReturnType<typeof parseMessageWithAttachments>> = {
    message: params.isRawModelRun
      ? transcriptInputText
      : annotateInterSessionPromptText(transcriptInputText, params.inputProvenance),
    images: [],
    imageOrder: [],
    media: [],
    offloadedRefs: [],
  };
  let needsImageUnderstanding = false;
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
      respondError(
        params.respond,
        ErrorCodes.INVALID_REQUEST,
        `invalid agent params: unknown channel: ${normalized}`,
      );
      return undefined;
    }
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
          const cfg = params.cfg;
          const { canonicalKey } = resolveSessionStoreIdentity({
            cfg,
            sessionKey: params.requestedSessionKeyRaw!,
            ...(agentId ? { agentId } : {}),
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
      if ("agentId" in route) {
        if (params.knownAgents.includes(route.agentId)) {
          agentId = route.agentId;
          requestedSessionKey = resolveExplicitAgentSessionKey({ cfg: params.cfg, agentId });
        } else {
          params.context.logGateway.warn(
            `voicewake routing ignored unknown agentId="${route.agentId}" trigger="${voiceWakeTrigger}"`,
          );
        }
      } else if ("sessionKey" in route) {
        if (classifySessionKeyShape(route.sessionKey) !== "malformed_agent") {
          const { canonicalKey } = resolveSessionStoreIdentity({
            cfg: params.cfg,
            sessionKey: route.sessionKey,
          });
          const routedAgentId = resolveAgentIdFromSessionKey(canonicalKey);
          if (params.knownAgents.includes(routedAgentId)) {
            requestedSessionKey = canonicalKey;
            agentId = routedAgentId;
          } else {
            params.context.logGateway.warn(
              `voicewake routing ignored unknown session agent="${routedAgentId}" sessionKey="${canonicalKey}" trigger="${voiceWakeTrigger}"`,
            );
          }
        } else {
          params.context.logGateway.warn(
            `voicewake routing ignored malformed sessionKey="${route.sessionKey}" trigger="${voiceWakeTrigger}"`,
          );
        }
      }
    } catch (err) {
      params.context.logGateway.warn(`voicewake routing load failed: ${formatForLog(err)}`);
    }
  }

  params.assertAdmissionCurrent?.();
  if ((await params.onTargetResolved?.({ sessionKey: requestedSessionKey, agentId })) === false) {
    return undefined;
  }
  if (params.normalizedAttachments.length > 0) {
    let session: Awaited<ReturnType<typeof readAcpSessionEntryAsync>> = null;
    let catalogAgentId = agentId;
    const attachmentSessionKey = requestedSessionKey ?? params.requestedSessionKeyRaw;
    if (attachmentSessionKey) {
      const target = resolveSessionStoreIdentity({
        cfg: params.cfg,
        sessionKey: attachmentSessionKey,
        agentId,
      });
      session = await readAcpSessionEntryAsync({
        cfg: params.cfg,
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        assertCurrent: params.assertAdmissionCurrent,
      });
      params.assertAdmissionCurrent?.();
      catalogAgentId = target.agentId;
    }
    const baseModel = resolveSessionModelRef(
      session?.cfg ?? params.cfg,
      session?.entry,
      catalogAgentId,
    );
    const model = params.modelOverride
      ? (resolvePersistedOverrideModelRef({
          defaultProvider: params.providerOverride ?? baseModel.provider,
          overrideProvider: params.providerOverride,
          overrideModel: params.modelOverride,
        }) ?? baseModel)
      : { provider: params.providerOverride ?? baseModel.provider, model: baseModel.model };
    const isConfirmedAcpSession =
      params.request.acpTurnSource === "manual_spawn" &&
      params.requestedSessionKeyRaw !== undefined &&
      isAcpSessionKey(params.requestedSessionKeyRaw) &&
      session?.acp != null;
    const supportsImages =
      isConfirmedAcpSession ||
      (await resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: params.context.loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot: params.context.loadGatewayModelCatalogSnapshot,
        agentId: catalogAgentId,
        ...model,
      }));
    needsImageUnderstanding = !supportsImages;
    params.assertAdmissionCurrent?.();
    try {
      content = await parseMessageWithAttachments(content.message, params.normalizedAttachments, {
        maxBytes: resolveChatAttachmentMaxBytes(params.cfg),
        log: params.context.logGateway,
        supportsImages,
        acceptNonImage: false,
        assertCurrent: params.assertAdmissionCurrent,
      });
      content.message = (
        needsImageUnderstanding
          ? stripImageMediaMarkers(content.message, content.offloadedRefs)
          : content.message
      ).trim();
    } catch (err) {
      // A retired request owns its terminal response even when media parsing
      // fails while the captured input is being cancelled.
      params.assertAdmissionCurrent?.();
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
    needsImageUnderstanding,
    effectiveTranscriptInputText: transcriptInputText,
    ...content,
    replyTo,
    recipientChannel,
    recipientAccountId,
    recipientThreadId,
    to,
  };
}
