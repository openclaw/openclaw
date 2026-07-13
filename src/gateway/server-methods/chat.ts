// Chat gateway methods implement chat.send/history/abort/inject/metadata and
// bridge UI RPCs to agent dispatch, transcripts, media, and streaming state.
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isAudioFileName } from "@openclaw/media-core/mime";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatMetadataParams,
  validateChatMessageGetParams,
  validateChatToolTitlesParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  listAgentIds,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { modelCatalogBrowseRequiresFullDiscovery } from "../../agents/model-catalog-browse.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  stageSandboxMedia,
  type StageSandboxMediaResult,
} from "../../auto-reply/reply/stage-sandbox-media.js";
import type { MsgContext, TemplateContext } from "../../auto-reply/templating.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { resolveTranscriptSessionKeyBySessionId } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearAgentRunContext,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  emitDiagnosticsTimelineEvent,
  measureDiagnosticsTimelineSpan,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage, formatUncaughtError } from "../../infra/errors.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import { parseInboundMediaUri } from "../../media/media-reference.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { deleteMediaBuffer, MEDIA_MAX_BYTES, type SavedMedia } from "../../media/store.js";
import { createChannelMessageReplyPipeline } from "../../plugin-sdk/channel-outbound.js";
import {
  retainGatewayRootWorkAdmissionContinuation,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../process/gateway-work-admission.js";
import { normalizeAgentId, scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.js";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
  stripInlineDirectiveTagsForDisplay,
  sanitizeReplyDirectiveId,
} from "../../utils/directive-tags.js";
import { INTERNAL_MESSAGE_CHANNEL, isOperatorUiClient } from "../../utils/message-channel.js";
import { listGatewayAgentsBasic } from "../agent-list.js";
import {
  boundInFlightRunSnapshotForChatHistory,
  resolveInFlightRunSnapshot,
  updateChatRunProvider,
} from "../chat-abort.js";
import {
  type ChatImageContent,
  MediaOffloadError,
  type OffloadedRef,
  parseMessageWithAttachments,
  persistInboundImagesForTranscript,
  resolveChatAttachmentMaxBytes,
  UnsupportedAttachmentError,
} from "../chat-attachments.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  dropPreSessionStartAnnouncePairs,
  projectChatDisplayMessage,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
} from "../chat-queued-turns.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import {
  isDashboardSessionTitleCandidate,
  maybeGenerateDashboardSessionTitle,
} from "../dashboard-session-title.js";
import { attachManagedOutgoingImagesToMessage } from "../managed-image-attachments.js";
import { chatAbortMarkerTimestampMs, type ChatRunTiming } from "../server-chat-state.js";
import { getMaxChatHistoryMessagesBytes, MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import {
  capArrayByJsonBytes,
  readSessionMessageByIdAsync,
  readSessionMessagesAsync,
} from "../session-transcript-readers.js";
import {
  buildGatewaySessionInfo,
  getSessionDefaults,
  loadSessionEntry,
  listAgentsForGateway,
  resolveGatewayModelSupportsImages,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { ensureChatQueuedTurns } from "./chat-abort-runtime.js";
import {
  buildAssistantDisplayContentFromReplyPayloads,
  extractAssistantDisplayText,
  extractAssistantDisplayTextFromContent,
  hasAssistantDisplayMediaContent,
  hasManagedOutgoingAssistantContent,
  hasSensitiveMediaPayload,
  hasVisibleAssistantFinalMessage,
  isMediaBearingPayload,
  replaceAssistantContentTextBlocks,
  sanitizeAssistantDisplayText,
  scheduleChatHistoryManagedImageCleanup,
  stripManagedOutgoingAssistantContentBlocks,
  type AssistantDisplayContentBlock,
} from "./chat-assistant-content.js";
import {
  broadcastChatError,
  broadcastChatFinal,
  broadcastSideResult,
  isBtwReplyPayload,
  isSourceReplyTranscriptMirrorPayload,
  sendGlobalAwareNodeChatPayload,
} from "./chat-broadcast.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  enforceChatHistoryFinalBudget,
  replaceOversizedChatHistoryMessages,
  reportOmittedChatHistory,
} from "./chat-history-budget.js";
import {
  capChatHistoryAroundMessage,
  readChatHistoryMessageId,
  readChatHistoryMessageSeq,
  readChatHistoryPage,
} from "./chat-history-pages.js";
import {
  explicitOriginTargetsAcpSession,
  explicitOriginTargetsPluginBinding,
  hasGatewayAdminScope,
  isAcpBridgeClient,
  resolveRequestedChatAgentId,
  validateChatSelectedAgent,
} from "./chat-origin-routing.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";
import { admitChatSend } from "./chat-send-admission.js";
import {
  respondChatSessionRoutingChanged,
  runChatSendPreAdmission,
} from "./chat-send-pre-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession } from "./chat-send-session.js";
import {
  chatSendAckServerTimingAttributes,
  emitOperatorChatSendServerTiming,
  roundedChatSendTimingMs,
  shouldIncludeChatSendAckServerTiming,
  type ChatSendServerTimingPhase,
} from "./chat-server-timing.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import type { GatewayInjectedTtsSupplementMarker } from "./chat-transcript-inject.js";
import {
  assistantTranscriptScope,
  appendAssistantTranscriptMessage,
  publishAssistantTranscriptRewrite,
  rewriteSourceReplyTranscriptMirrors,
  type SourceReplyContentState,
  type SourceReplyTranscriptMirrorMetadata,
} from "./chat-transcript-persistence.js";
import {
  buildMediaOnlyTtsSupplementTranscriptMarker,
  buildTtsSupplementTranscriptMarker,
  stripVisibleTextFromTtsSupplement,
} from "./chat-tts-markers.js";
import { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";
import {
  loadOptionalServerMethodModelCatalog,
  loadOptionalServerMethodModelCatalogSnapshot,
  startOptionalServerMethodModelCatalogSnapshotLoad,
} from "./optional-model-catalog.js";
import {
  hasTrackedActiveSessionRun,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

type ChatHistoryMethod = "chat.history" | "chat.startup";

type ChatMetadataResult = {
  commands?: unknown[];
  models?: unknown[];
};

async function handleChatMetadataRequest({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): Promise<void> {
  if (!validateChatMetadataParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid chat.metadata params: ${formatValidationErrors(validateChatMetadataParams.errors)}`,
      ),
    );
    return;
  }
  const metadataParams = params;
  const cfg = context.getRuntimeConfig();
  const requestedAgentId =
    typeof metadataParams.agentId === "string" && metadataParams.agentId.trim()
      ? normalizeAgentId(metadataParams.agentId)
      : resolveDefaultAgentId(cfg);
  if (!listAgentIds(cfg).includes(requestedAgentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${metadataParams.agentId}"`),
    );
    return;
  }
  try {
    respond(
      true,
      await buildChatMetadataResult({
        cfg,
        context,
        agentId: requestedAgentId,
      }),
    );
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
  }
}

async function buildChatMetadataResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId: string;
}): Promise<ChatMetadataResult> {
  const [{ buildModelsListResult }, { buildCommandsListResult }] = await Promise.all([
    import("./models-list-result.js"),
    import("./commands-list-result.js"),
  ]);
  const [models, commands] = await Promise.all([
    buildModelsListResult({
      context: params.context,
      agentId: params.agentId,
      params: { view: "configured" },
    }),
    Promise.resolve(
      buildCommandsListResult({
        cfg: params.cfg,
        agentId: params.agentId,
        includeArgs: true,
        scope: "text",
      }),
    ),
  ]);
  return { ...models, ...commands };
}

async function buildChatStartupMetadataResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId: string;
  modelCatalog: ModelCatalogSnapshot | undefined;
  catalogProjector?: ReturnType<
    (typeof import("./models-list-result.js"))["createGatewayAgentModelCatalogProjector"]
  >;
}): Promise<ChatMetadataResult | undefined> {
  if (!params.modelCatalog) {
    return undefined;
  }
  if (modelCatalogBrowseRequiresFullDiscovery({ cfg: params.cfg, view: "configured" })) {
    return undefined;
  }
  try {
    const { buildModelsListResult } = await import("./models-list-result.js");
    return await buildModelsListResult({
      context: params.context,
      agentId: params.agentId,
      params: { view: "configured" },
      preloadedCatalog: params.modelCatalog,
      ...(params.catalogProjector ? { catalogProjector: params.catalogProjector } : {}),
    });
  } catch (err) {
    params.context.logGateway.debug(
      `chat.startup continuing without metadata: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

async function buildChatStartupModelCatalogProjection(params: {
  cfg: OpenClawConfig;
  snapshot: ModelCatalogSnapshot;
  sessionAgentId: string;
  sessionEntry: ReturnType<typeof loadSessionEntry>["entry"];
  defaultAgentId: string;
  includeAgentsList: boolean;
}) {
  const { createGatewayAgentModelCatalogProjector } = await import("./models-list-result.js");
  const projectorByKey = new Map<
    string,
    ReturnType<typeof createGatewayAgentModelCatalogProjector>
  >();
  const modelCatalogByAgentId = new Map<string, ModelCatalogEntry[]>();
  const getProjector = (
    agentId: string,
    profiles: { preferredProfileId?: string; lockedProfileId?: string } = {},
  ) => {
    const id = normalizeAgentId(agentId);
    const key = `${id}\0${profiles.preferredProfileId ?? ""}\0${profiles.lockedProfileId ?? ""}`;
    let projector = projectorByKey.get(key);
    if (!projector) {
      projector = createGatewayAgentModelCatalogProjector({
        cfg: params.cfg,
        agentId: id,
        snapshot: params.snapshot,
        ...(profiles.preferredProfileId ? { preferredProfileId: profiles.preferredProfileId } : {}),
        ...(profiles.lockedProfileId ? { lockedProfileId: profiles.lockedProfileId } : {}),
      });
      projectorByKey.set(key, projector);
    }
    return projector;
  };
  const agentIds = new Set([params.sessionAgentId, params.defaultAgentId].map(normalizeAgentId));
  if (params.includeAgentsList) {
    for (const agent of listGatewayAgentsBasic(params.cfg).agents) {
      agentIds.add(agent.id);
    }
  }
  await Promise.all(
    [...agentIds].map(async (agentId) => {
      modelCatalogByAgentId.set(agentId, await getProjector(agentId).projectCatalog());
    }),
  );
  const sessionProfileId = params.sessionEntry?.authProfileOverride?.trim();
  const sessionProfileSource = params.sessionEntry?.authProfileOverrideSource;
  // Legacy rows omitted the source; a compaction count is the durable marker
  // that the profile was adopted automatically and may fall through.
  const legacyUserProfile =
    sessionProfileSource === undefined &&
    params.sessionEntry?.authProfileOverrideCompactionCount === undefined;
  const sessionProfiles = sessionProfileId
    ? {
        preferredProfileId: sessionProfileId,
        ...(sessionProfileSource === "user" || legacyUserProfile
          ? { lockedProfileId: sessionProfileId }
          : {}),
      }
    : undefined;
  const sessionCatalogProjector = getProjector(params.sessionAgentId, sessionProfiles);
  const sessionModelCatalog = await sessionCatalogProjector.projectCatalog();
  return { getProjector, modelCatalogByAgentId, sessionCatalogProjector, sessionModelCatalog };
}

function resolveWebchatPromptCacheKey(params: {
  agentId: string;
  model: string;
  provider: string;
  sessionKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        "v1",
        params.provider.trim().toLowerCase(),
        params.model.trim(),
        normalizeAgentId(params.agentId),
        params.sessionKey,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `openclaw-webchat-${digest}`;
}

async function buildWebchatAssistantMediaMessage(
  payloads: ReplyPayload[],
  options?: {
    localRoots?: readonly string[];
    onLocalAudioAccessDenied?: (message: string) => void;
  },
): Promise<{ content: Array<Record<string, unknown>>; transcriptText: string } | null> {
  return buildWebchatAssistantMessageFromReplyPayloads(payloads, {
    localRoots: options?.localRoots,
    onLocalAudioAccessDenied: (err) => {
      options?.onLocalAudioAccessDenied?.(formatForLog(err));
    },
  });
}

export {
  augmentChatHistoryWithCanvasBlocks,
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  dropPreSessionStartAnnouncePairs,
  resolveEffectiveChatHistoryMaxChars,
  sanitizeChatHistoryMessages,
} from "../chat-display-projection.js";
export { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";
export {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  enforceChatHistoryFinalBudget,
  replaceOversizedChatHistoryMessages,
  reportOmittedChatHistory,
} from "./chat-history-budget.js";

const CHAT_STARTUP_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS = 25;
function formatAttachmentFailureForLog(err: unknown): string {
  const primary = formatUncaughtError(err);
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause === undefined) {
    return primary;
  }
  const causeText = formatUncaughtError(cause);
  if (!causeText || causeText === primary) {
    return primary;
  }
  return `${primary}\nCaused by: ${causeText}`;
}

function logAttachmentFailure(
  logGateway: Pick<GatewayRequestContext["logGateway"], "error">,
  label: string,
  err: unknown,
): void {
  logGateway.error(label, {
    error: formatAttachmentFailureForLog(err),
    consoleMessage: `${label}: ${formatForLog(err)}`,
  });
}

function buildTranscriptReplyText(payloads: ReplyPayload[]): string {
  const chunks = payloads
    .map((payload) => {
      if (payload.isReasoning === true) {
        return "";
      }
      const parts = resolveSendableOutboundReplyParts(payload);
      const lines: string[] = [];
      const parsedText = payload.text?.includes("[[")
        ? parseInlineDirectives(payload.text)
        : undefined;
      const replyToId =
        sanitizeReplyDirectiveId(payload.replyToId) ??
        sanitizeReplyDirectiveId(parsedText?.replyToExplicitId);
      if (replyToId) {
        lines.push(`[[reply_to:${replyToId}]]`);
      } else if (payload.replyToCurrent || parsedText?.replyToCurrent) {
        lines.push("[[reply_to_current]]");
      }
      const text = payload.text
        ? stripInlineDirectiveTagsForDelivery(payload.text).text.trim()
        : "";
      if (text && !isSuppressedControlReplyText(text)) {
        lines.push(text);
      }
      for (const mediaUrl of parts.mediaUrls) {
        if (payload.sensitiveMedia === true) {
          continue;
        }
        const trimmed = mediaUrl.trim();
        if (trimmed) {
          lines.push(`Attachment: ${trimmed}`);
        }
      }
      if (
        (payload.audioAsVoice || parsedText?.audioAsVoice) &&
        parts.mediaUrls.some((mediaUrl) => isAudioFileName(mediaUrl))
      ) {
        lines.push("[[audio_as_voice]]");
      }
      return lines.join("\n").trim();
    })
    .filter(Boolean);
  return chunks.join("\n\n").trim();
}

async function persistChatSendImages(params: {
  images: ChatImageContent[];
  imageOrder: PromptImageOrderEntry[];
  offloadedRefs: OffloadedRef[];
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
}): Promise<SavedMedia[]> {
  if (
    (params.images.length === 0 && params.offloadedRefs.length === 0) ||
    isAcpBridgeClient(params.client)
  ) {
    return [];
  }
  return await persistInboundImagesForTranscript({
    images: params.images,
    imageOrder: params.imageOrder,
    offloadedRefs: params.offloadedRefs,
    log: params.logGateway,
    logContext: "chat.send",
  });
}

function stripTrailingOffloadedMediaMarkers(message: string, refs: OffloadedRef[]): string {
  if (refs.length === 0) {
    return message;
  }
  const removableRefs = new Set(refs.map((ref) => ref.mediaRef));
  const lines = message.split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1]?.trim() ?? "";
    const match = /^\[media attached:\s*(media:\/\/inbound\/[^\]\s]+)\]$/.exec(last);
    if (!match?.[1] || !removableRefs.delete(match[1])) {
      break;
    }
    lines.pop();
  }
  return lines.join("\n").trimEnd();
}

function isPdfOffloadedRef(ref: OffloadedRef): boolean {
  const mime = ref.mimeType.trim().toLowerCase();
  if (mime === "application/pdf" || mime.endsWith("+pdf")) {
    return true;
  }
  return path.extname(ref.path.split(/[?#]/u)[0] ?? "").toLowerCase() === ".pdf";
}

// A managed inbound PDF saved to the media store is safe to hand the agent as its
// media path without sandbox staging: host-side media-understanding extracts its
// text (see resolveFileExtractionLimits) by reading the media-store root, so even
// locked-down agents receive the document. This gates both the up-front bypass for
// oversized PDFs and the fallback to the managed path when sandbox staging fails
// for an already-managed PDF. #90097
function isManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  if (!isPdfOffloadedRef(ref)) {
    return false;
  }
  try {
    return parseInboundMediaUri(ref.mediaRef) !== null;
  } catch {
    return false;
  }
}

// Oversized managed PDFs skip sandbox staging up front: copying a large PDF into
// every sandbox is wasteful, and files above the 5MB staging cap would otherwise
// be rejected as a 4xx (see prestageMediaPathOffloads).
function shouldPassThroughManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  return ref.sizeBytes > MEDIA_MAX_BYTES && isManagedInboundPdfOffloadRef(ref);
}

// Stages media-path offloads into the agent sandbox synchronously so chat.send
// can surface 5xx before respond(). Throws MediaOffloadError when staging fails
// for a ref that cannot fall back (ENOSPC / EPERM / partial-stage of a non-PDF or
// unmanaged ref) so the outer chat.send handler maps it to UNAVAILABLE (5xx);
// plain Error would be misclassified as 4xx. Already-managed inbound PDFs instead
// fall back to their managed media path on staging failure (#90097), since
// host-side media-understanding reads them from the media-store root. Offloaded
// refs are cleaned up from the media store before rethrow.
// Callers MUST set ctx.MediaStaged=true when this runs so the dispatch
// pipeline skips its own stageSandboxMedia pass.
//
// Returned paths are absolute media-store paths when no sandbox is active, for
// oversized managed PDFs that bypass staging, or for already-managed PDFs that
// fall back when staging fails (#90097); files staged into the sandbox use
// sandbox-relative paths plus `workspaceDir`. Host-side media-understanding
// resolves both via MediaWorkspaceDir and the media-store root.
async function prestageMediaPathOffloads(params: {
  offloadedRefs: OffloadedRef[];
  includeImageRefs?: boolean;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}): Promise<{ paths: string[]; types: string[]; workspaceDir?: string }> {
  const mediaPathRefs = params.offloadedRefs.filter(
    (ref) => params.includeImageRefs || !ref.mimeType.startsWith("image/"),
  );
  if (mediaPathRefs.length === 0) {
    return { paths: [], types: [] };
  }
  const refsByManagedPath = (refs: OffloadedRef[]) => ({
    paths: refs.map((ref) => ref.path),
    types: refs.map((ref) => ref.mimeType),
  });

  // Oversized managed PDFs bypass sandbox staging and are read host-side, so they
  // do not need a workspace copy or the staging-cap check below.
  const passThroughRefs: OffloadedRef[] = [];
  const refsToStage: OffloadedRef[] = [];
  for (const ref of mediaPathRefs) {
    (shouldPassThroughManagedInboundPdfOffloadRef(ref) ? passThroughRefs : refsToStage).push(ref);
  }
  if (refsToStage.length === 0) {
    return refsByManagedPath(mediaPathRefs);
  }

  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
    });
    if (!sandbox) {
      return refsByManagedPath(mediaPathRefs);
    }

    // stageSandboxMedia caps each file at STAGED_MEDIA_MAX_BYTES (=
    // MEDIA_MAX_BYTES, 5MB) and silently skips oversized files. The parse cap
    // (resolveChatAttachmentMaxBytes, default 20MB) is higher, so a sandboxed
    // session receiving a non-PDF file between the two caps would otherwise
    // pass parse, fail staging, and surface as a retryable 5xx even though
    // retry cannot succeed. Reject here as a client-side 4xx instead. Managed
    // PDFs in that range pass through above instead of being rejected.
    const oversizedForSandbox = refsToStage.filter((ref) => ref.sizeBytes > MEDIA_MAX_BYTES);
    if (oversizedForSandbox.length > 0) {
      const details = oversizedForSandbox
        .map((ref) => `${ref.label} (${ref.sizeBytes} bytes)`)
        .join(", ");
      throw new UnsupportedAttachmentError(
        "non-image-too-large-for-sandbox",
        `attachments exceed sandbox staging limit (${MEDIA_MAX_BYTES} bytes): ${details}`,
      );
    }

    const stagingCtx: MsgContext = {
      MediaPath: expectDefined(refsToStage[0], "refs to stage entry at 0").path,
      MediaPaths: refsToStage.map((ref) => ref.path),
      MediaType: expectDefined(refsToStage[0], "refs to stage entry at 0").mimeType,
      MediaTypes: refsToStage.map((ref) => ref.mimeType),
    };
    let stageResult: StageSandboxMediaResult;
    try {
      stageResult = await stageSandboxMedia({
        ctx: stagingCtx,
        sessionCtx: stagingCtx as TemplateContext,
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        workspaceDir,
      });
    } catch (stageErr) {
      // stageSandboxMedia threw before copying anything (e.g. workspace mkdir
      // ENOSPC/EPERM), so nothing reached the sandbox. Already-managed inbound
      // PDFs still reach the agent via their managed media path (host-side
      // media-understanding reads the media-store root); fail the send only when a
      // ref cannot fall back. #90097
      if (refsToStage.some((ref) => !isManagedInboundPdfOffloadRef(ref))) {
        throw stageErr;
      }
      return refsByManagedPath(mediaPathRefs);
    }

    // stageSandboxMedia silently keeps unstaged entries as their original
    // absolute path, so length parity does not prove every file landed in the
    // sandbox. The RPC max (20MB via resolveChatAttachmentMaxBytes) admits files
    // above the staging cap (STAGED_MEDIA_MAX_BYTES = 5MB); check the returned
    // `staged` map for missing sources. Already-managed inbound PDFs fall back to
    // their absolute managed path (host-side media-understanding reads the
    // media-store root); any other missing source is a 5xx MediaOffloadError the
    // client can retry. #90097
    const stagedSources = stageResult.staged;
    const missing = refsToStage.filter((ref) => !stagedSources.has(ref.path));
    const unstageable = missing.filter((ref) => !isManagedInboundPdfOffloadRef(ref));
    if (unstageable.length > 0) {
      throw new Error(
        `attachment staging incomplete: ${stagedSources.size}/${refsToStage.length} paths staged into sandbox workspace (missing: ${unstageable.map((ref) => ref.path).join(", ")})`,
      );
    }
    const stagedPaths = stagingCtx.MediaPaths ?? [];
    const stagedTypes = stagingCtx.MediaTypes ?? refsToStage.map((ref) => ref.mimeType);

    // Map each ref to its post-staging path. Staged files become sandbox-relative
    // (e.g. `media/inbound/foo.pdf`) so the agent inside the container can read
    // them; pass-through PDFs and managed PDFs that fell back from staging keep
    // their absolute managed path (stagedPaths preserves the absolute path for any
    // unstaged entry). Host-side media-understanding resolves both via
    // ctx.MediaWorkspaceDir plus the media-store root. Preserve attachment order.
    const resolvedByRef = new Map<OffloadedRef, { path: string; mimeType: string }>();
    refsToStage.forEach((ref, index) => {
      resolvedByRef.set(ref, {
        path: stagedPaths[index] ?? ref.path,
        mimeType: stagedTypes[index] ?? ref.mimeType,
      });
    });
    for (const ref of passThroughRefs) {
      resolvedByRef.set(ref, { path: ref.path, mimeType: ref.mimeType });
    }
    const ordered = mediaPathRefs.map(
      (ref) => resolvedByRef.get(ref) ?? { path: ref.path, mimeType: ref.mimeType },
    );
    return {
      paths: ordered.map((entry) => entry.path),
      types: ordered.map((entry) => entry.mimeType),
      workspaceDir: sandbox.workspaceDir,
    };
  } catch (err) {
    await Promise.allSettled(
      params.offloadedRefs.map((ref) => deleteMediaBuffer(ref.id, "inbound")),
    );
    if (err instanceof MediaOffloadError) {
      throw err;
    }
    // Sandbox-oversize rejections are client-side 4xx (see check above). Wrapping
    // them as MediaOffloadError would misclassify them as retryable 5xx.
    if (err instanceof UnsupportedAttachmentError) {
      throw err;
    }
    throw new MediaOffloadError(
      `[Gateway Error] Failed to stage attachments into agent workspace: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
}

type ChatSendManagedMediaFields = Partial<
  Pick<MsgContext, "MediaPath" | "MediaPaths" | "MediaType" | "MediaTypes">
>;

function resolveChatSendManagedMediaFields(savedImages: SavedMedia[]): ChatSendManagedMediaFields {
  const mediaPaths = savedImages.map((entry) => entry.path);
  if (mediaPaths.length === 0) {
    return {};
  }
  const mediaTypes = savedImages.map((entry) => entry.contentType ?? "application/octet-stream");
  return {
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes,
  };
}

function applyChatSendManagedMediaFields(ctx: MsgContext, fields: ChatSendManagedMediaFields) {
  if (!ctx.MediaStaged) {
    Object.assign(ctx, fields);
    return;
  }

  if (ctx.MediaPath === undefined && fields.MediaPath !== undefined) {
    ctx.MediaPath = fields.MediaPath;
  }
  if (ctx.MediaPaths === undefined && fields.MediaPaths !== undefined) {
    ctx.MediaPaths = fields.MediaPaths;
  }
  if (ctx.MediaType === undefined && fields.MediaType !== undefined) {
    ctx.MediaType = fields.MediaType;
  }
  if (ctx.MediaTypes === undefined && fields.MediaTypes !== undefined) {
    ctx.MediaTypes = fields.MediaTypes;
  }
}

function buildChatSendUserTurnMedia(savedMedia: SavedMedia[]): NonNullable<UserTurnInput["media"]> {
  return savedMedia.map((entry) => ({
    path: entry.path,
    contentType: entry.contentType,
  }));
}

function resolveChatHistoryNextOffset(params: {
  messages: unknown[];
  totalMessages: number;
  offset: number;
  rawPageMessages: number;
  replayOldestRecord?: boolean;
}): number {
  const oldestSeq = params.messages
    .map((message) => readChatHistoryMessageSeq(message))
    .find((seq): seq is number => typeof seq === "number");
  if (oldestSeq !== undefined) {
    const recordOffset = params.totalMessages - oldestSeq + 1;
    const replayOffset = recordOffset - 1;
    if (params.replayOldestRecord && replayOffset > params.offset) {
      return replayOffset;
    }
    // A replay cursor that does not advance strands every older record. Skip
    // the pathological projected siblings and continue with the next record.
    return Math.max(params.offset + 1, recordOffset);
  }
  return params.offset + params.rawPageMessages;
}

function shouldReplayOldestChatHistoryRecord(params: {
  projected: unknown[];
  bounded: unknown[];
}): boolean {
  const oldestSeq = params.bounded
    .map((message) => readChatHistoryMessageSeq(message))
    .find((seq): seq is number => typeof seq === "number");
  if (oldestSeq === undefined) {
    return false;
  }
  const projectedCount = params.projected.filter(
    (message) => readChatHistoryMessageSeq(message) === oldestSeq,
  ).length;
  const boundedCount = params.bounded.filter(
    (message) => readChatHistoryMessageSeq(message) === oldestSeq,
  ).length;
  return boundedCount < projectedCount;
}

async function isChatMessageIdVisibleAfterHistoryFilters(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionEntry?: { sessionFile?: string; sessionId?: string };
  sessionKey: string;
  agentId?: string;
  messageId: string;
  sessionStartedAt?: number;
  allowResetArchiveFallback?: boolean;
}): Promise<boolean> {
  if (params.sessionStartedAt === undefined) {
    return true;
  }
  const messages = await readSessionMessagesAsync(
    {
      agentId: params.agentId,
      sessionEntry: params.sessionEntry,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      mode: "full",
      reason: "chat.message.get visibility",
      ...(params.allowResetArchiveFallback === true ? { allowResetArchiveFallback: true } : {}),
    },
  );
  return dropPreSessionStartAnnouncePairs(messages, params.sessionStartedAt).some(
    (message) => readChatHistoryMessageId(message) === params.messageId,
  );
}

async function handleChatHistoryRequest({
  params,
  respond,
  context,
  method,
  includeAgentsList,
  includeMetadata,
}: GatewayRequestHandlerOptions & {
  method: ChatHistoryMethod;
  includeAgentsList?: boolean;
  includeMetadata?: boolean;
}) {
  if (!validateChatHistoryParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${method} params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
      ),
    );
    return;
  }
  const {
    sessionKey,
    limit,
    offset,
    messageId,
    sessionId: requestedSessionId,
    maxChars,
  } = params as {
    sessionKey: string;
    agentId?: string;
    limit?: number;
    offset?: number;
    messageId?: string;
    sessionId?: string;
    maxChars?: number;
  };
  if (offset !== undefined && messageId !== undefined) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "offset and messageId cannot be used together"),
    );
    return;
  }
  if (requestedSessionId !== undefined && messageId === undefined) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "sessionId requires messageId"),
    );
    return;
  }
  const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
  const requestedAgentId = resolveRequestedChatAgentId({
    cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
    requestedSessionKey: sessionKey,
    agentId: agentIdOverride,
  });
  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const { cfg, storePath, store, entry, canonicalKey } = loadSessionEntry(
    sessionKey,
    sessionLoadOptions,
  );
  const selectedAgent = validateChatSelectedAgent({
    cfg,
    requestedSessionKey: sessionKey,
    agentId: requestedAgentId,
  });
  if (!selectedAgent.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
    return;
  }
  const sessionAgentId = resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: selectedAgent.agentId,
  });
  if (requestedSessionId) {
    const transcriptSessionKey = resolveTranscriptSessionKeyBySessionId({
      agentId: sessionAgentId,
      sessionId: requestedSessionId,
      storePath,
    });
    if (
      !transcriptSessionKey ||
      scopeLegacySessionKeyToAgent({
        sessionKey: transcriptSessionKey,
        agentId: sessionAgentId,
      }) !== scopeLegacySessionKeyToAgent({ sessionKey: canonicalKey, agentId: sessionAgentId })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessionId does not belong to sessionKey"),
      );
      return;
    }
  }
  const startupModelCatalogLoad =
    method === "chat.startup"
      ? startOptionalServerMethodModelCatalogSnapshotLoad(context)
      : undefined;
  const modelCatalogPromise = measureDiagnosticsTimelineSpan(
    `gateway.${method}.model_catalog`,
    () =>
      startupModelCatalogLoad
        ? loadOptionalServerMethodModelCatalogSnapshot(context, method, {
            logOnceKey: "chat.startup",
            startedLoad: startupModelCatalogLoad,
            timeoutMs: CHAT_STARTUP_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS,
          })
        : loadOptionalServerMethodModelCatalog(context, method).then((entries) =>
            entries ? { entries, routeVariants: entries } : undefined,
          ),
    {
      config: cfg,
      phase: method,
    },
  );
  if (startupModelCatalogLoad) {
    void modelCatalogPromise.catch(() => undefined);
  }
  const sessionId = requestedSessionId ?? entry?.sessionId;
  const historyEntry =
    requestedSessionId && requestedSessionId !== entry?.sessionId ? undefined : entry;
  const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
  const hardMax = 1000;
  const defaultLimit = 200;
  const requested = typeof limit === "number" ? limit : defaultLimit;
  const max = Math.min(hardMax, requested);
  const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
  const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(cfg, maxChars);
  const historyPage = await readChatHistoryPage({
    entry: historyEntry,
    provider: resolvedSessionModel.provider,
    sessionId,
    storePath,
    sessionAgentId,
    canonicalKey,
    max,
    maxHistoryBytes,
    effectiveMaxChars,
    offset,
    messageId,
  });
  const normalized = historyPage.messages;
  const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = replaceOversizedChatHistoryMessages({
    messages: normalized,
    maxSingleMessageBytes: perMessageHardCap,
  });
  scheduleChatHistoryManagedImageCleanup({
    sessionKey,
    ...(selectedAgent.agentId ? { agentId: selectedAgent.agentId } : {}),
    context,
  });
  const capped = messageId
    ? (capChatHistoryAroundMessage({
        messages: replaced.messages,
        messageId,
        fits: (messages) => jsonUtf8Bytes(messages) <= maxHistoryBytes,
      }) ?? capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items)
    : capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
  const bounded = enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
  const historyBudgetPreserved =
    replaced.replacedCount === 0 &&
    capped.length === normalized.length &&
    bounded.messages.length === capped.length &&
    bounded.messages.every((message, index) => message === capped[index]);
  const pagination = historyPage.pagination;
  const candidateNextOffset =
    pagination === undefined
      ? undefined
      : resolveChatHistoryNextOffset({
          messages: bounded.messages,
          totalMessages: pagination.totalMessages,
          offset: pagination.offset,
          rawPageMessages: pagination.rawPageMessages,
          replayOldestRecord: shouldReplayOldestChatHistoryRecord({
            projected: normalized,
            bounded: bounded.messages,
          }),
        });
  const hasMore =
    pagination !== undefined && candidateNextOffset !== undefined
      ? pagination.exhausted !== true && candidateNextOffset < pagination.totalMessages
      : undefined;
  const nextOffset = hasMore ? candidateNextOffset : undefined;
  reportOmittedChatHistory({
    originalMessages: normalized,
    finalMessages: bounded.messages,
    normalizedBytes: jsonUtf8Bytes(normalized),
    maxHistoryBytes,
    logDebug: (message) => context.logGateway.debug(message),
  });
  const modelCatalogSnapshot = await modelCatalogPromise;
  const modelCatalog = modelCatalogSnapshot?.entries;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const startupCatalogProjection =
    method === "chat.startup" && modelCatalogSnapshot
      ? await buildChatStartupModelCatalogProjection({
          cfg,
          snapshot: modelCatalogSnapshot,
          sessionAgentId,
          sessionEntry: entry,
          defaultAgentId,
          includeAgentsList: includeAgentsList === true,
        })
      : undefined;
  const sessionModelCatalog = startupCatalogProjection?.sessionModelCatalog ?? modelCatalog;
  const defaultModelCatalog =
    startupCatalogProjection?.modelCatalogByAgentId.get(normalizeAgentId(defaultAgentId)) ??
    modelCatalog;
  const startupMetadata = includeMetadata
    ? await buildChatStartupMetadataResult({
        cfg,
        context,
        agentId: sessionAgentId,
        modelCatalog: modelCatalogSnapshot,
        ...(startupCatalogProjection
          ? { catalogProjector: startupCatalogProjection.sessionCatalogProjector }
          : {}),
      })
    : undefined;
  const sessionInfo = buildGatewaySessionInfo({
    cfg,
    storePath,
    store,
    key: canonicalKey,
    entry,
    agentId: selectedAgent.agentId,
    modelCatalog: sessionModelCatalog,
  });
  const activeRunAgentId =
    canonicalKey === "global" ? (selectedAgent.agentId ?? defaultAgentId) : selectedAgent.agentId;
  const activeRunState = resolveVisibleActiveSessionRunState({
    context,
    requestedKey: sessionKey,
    canonicalKey,
    sessionId: entry?.sessionId,
    ...(activeRunAgentId ? { agentId: activeRunAgentId } : {}),
    defaultAgentId,
  });
  sessionInfo.hasActiveRun = activeRunState.active;
  sessionInfo.activeRunIds = activeRunState.runIds;
  const defaults = getSessionDefaults(cfg, defaultModelCatalog, {
    allowPluginNormalization: false,
  });
  const thinkingLevel = sessionInfo.thinkingLevel ?? sessionInfo.thinkingDefault;
  const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
  sessionInfo.verboseLevel = verboseLevel;
  // Surface any run still streaming for this session+agent so a client that
  // switched away (and stopped receiving the run's per-agent-delivered events)
  // can restore the in-flight assistant text on switch-back.
  const inFlightRun = resolveInFlightRunSnapshot({
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    requestedSessionKey: sessionKey,
    canonicalSessionKey: resolveSessionStoreKey({ cfg, sessionKey }),
    agentId: activeRunAgentId,
    defaultAgentId,
  });
  const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({
    snapshot: inFlightRun,
    messages: bounded.messages,
    maxBytes: maxHistoryBytes,
  });
  const payload = {
    sessionKey,
    sessionId,
    messages: bounded.messages,
    ...(historyPage.responseOffset !== undefined ? { offset: historyPage.responseOffset } : {}),
    ...(hasMore ? { nextOffset } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(pagination !== undefined ? { totalMessages: pagination.totalMessages } : {}),
    ...(historyPage.completeCliImport && !hasMore && historyBudgetPreserved
      ? { completeSnapshot: true }
      : {}),
    defaults,
    sessionInfo,
    thinkingLevel,
    fastMode: entry?.fastMode,
    verboseLevel,
    ...(boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}),
    ...(includeAgentsList
      ? {
          agentsList: listAgentsForGateway(
            cfg,
            modelCatalog,
            startupCatalogProjection
              ? { modelCatalogByAgentId: startupCatalogProjection.modelCatalogByAgentId }
              : undefined,
          ),
        }
      : {}),
    ...(startupMetadata ? { metadata: startupMetadata } : {}),
  };
  respond(true, payload);
}

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async (opts) => {
    await handleChatHistoryRequest({ ...opts, method: "chat.history" });
  },
  "chat.startup": async (opts) => {
    await handleChatHistoryRequest({
      ...opts,
      method: "chat.startup",
      includeAgentsList: true,
      includeMetadata: true,
    });
  },
  "chat.metadata": handleChatMetadataRequest,
  "chat.toolTitles": async ({ params, respond, context }) => {
    if (!validateChatToolTitlesParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.toolTitles params: ${formatValidationErrors(validateChatToolTitlesParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    // Opt-in gate: tool titles spend utility-model tokens, so the gateway
    // stays fully deterministic unless the operator enables them explicitly.
    // `disabled: true` lets clients stop asking for the rest of the session.
    if (cfg.gateway?.controlUi?.toolTitles !== true) {
      respond(true, { titles: {}, disabled: true });
      return;
    }
    const agentIdOverride = normalizeOptionalText(params.agentId);
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg,
      requestedSessionKey: params.sessionKey,
      agentId: agentIdOverride,
    });
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: params.sessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    try {
      const sessionAgentId = resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: cfg,
        agentId: selectedAgent.agentId,
      });
      // Session entry carries per-session model overrides; utility routing must
      // derive its small-model default from the provider this session actually
      // uses, not the agent's configured default.
      const { cfg: sessionCfg, entry } = loadSessionEntry(
        params.sessionKey,
        selectedAgent.agentId ? { agentId: selectedAgent.agentId } : undefined,
      );
      const sessionModel = resolveSessionModelRef(sessionCfg, entry, sessionAgentId);
      // Title generation pulls in the simple-completion runtime; load it lazily
      // so gateways that never enable the opt-in skip that cost.
      const { generateToolCallTitles } = await import("../chat-tool-titles.js");
      const titles = await generateToolCallTitles({
        cfg: sessionCfg,
        agentId: sessionAgentId,
        sessionPrimaryProvider: sessionModel.provider,
        sessionAuthProfile: entry?.authProfileOverride?.trim() || undefined,
        items: params.items,
      });
      respond(true, { titles });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "chat.message.get": async ({ params, respond, context }) => {
    if (!validateChatMessageGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.message.get params: ${formatValidationErrors(validateChatMessageGetParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, messageId, maxChars } = params as {
      sessionKey: string;
      agentId?: string;
      messageId: string;
      maxChars?: number;
    };
    const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: sessionKey,
      agentId: agentIdOverride,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey, sessionLoadOptions);
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: sessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }

    const sessionAgentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      agentId: selectedAgent.agentId,
    });
    const resolved = await readSessionMessageByIdAsync(
      {
        agentId: sessionAgentId,
        sessionEntry: entry,
        sessionId,
        sessionKey,
        storePath,
      },
      messageId,
      { allowResetArchiveFallback: true },
    );
    if (!resolved.found) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }
    const visible = await isChatMessageIdVisibleAfterHistoryFilters({
      sessionId,
      storePath,
      sessionEntry: entry,
      sessionKey,
      agentId: sessionAgentId,
      messageId,
      sessionStartedAt:
        typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
      allowResetArchiveFallback: true,
    });
    if (!visible) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }
    if (resolved.oversized) {
      respond(true, { ok: false, unavailableReason: "oversized" });
      return;
    }

    const effectiveMaxChars =
      typeof maxChars === "number" ? maxChars : Math.min(MAX_PAYLOAD_BYTES, 1_000_000);
    const projectedMessage = resolved.message
      ? projectChatDisplayMessage(resolved.message, {
          maxChars: effectiveMaxChars,
        })
      : undefined;
    const projected = projectedMessage
      ? augmentChatHistoryWithCanvasBlocks([projectedMessage])[0]
      : undefined;
    if (!projected) {
      respond(true, { ok: false, unavailableReason: "not_visible" });
      return;
    }

    respond(true, {
      ok: true,
      message: projected,
    });
  },
  "chat.abort": handleChatAbortRequest,
  "chat.send": async ({ params, respond, context, client }) => {
    const normalizedRequest = normalizeChatSendRequest({ params, client });
    if (!normalizedRequest.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, normalizedRequest.error));
      return;
    }
    const {
      chatSendReceivedAtMs,
      clientInfo,
      supportsTaskSuggestions,
      p,
      explicitOrigin,
      inboundMessage,
      systemInputProvenance,
      systemProvenanceReceipt,
      suppressCommandInterpretation,
      normalizedAttachments,
      rawMessage,
      reconnectResumeRequested,
    } = normalizedRequest.value;
    const preparedSession = prepareChatSendSession({
      request: normalizedRequest.value,
      context,
      client,
    });
    if (!preparedSession.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, preparedSession.error));
      return;
    }
    const {
      rawSessionKey,
      clientRunId,
      sessionLoadOptions,
      sessionLoadMs,
      cfg,
      storePath,
      entry,
      sessionKey,
      sessionRoutingChanged,
      selectedAgent,
      requestedSessionId,
      backingSessionId,
      agentId,
      activeRunScopeKey,
      resolvedSessionModel,
      now,
    } = preparedSession.value;
    const shouldAdmit = await runChatSendPreAdmission({
      request: normalizedRequest.value,
      session: preparedSession.value,
      respond,
      context,
      client,
    });
    if (!shouldAdmit) {
      return;
    }
    const admitted = await admitChatSend({
      request: normalizedRequest.value,
      session: preparedSession.value,
      respond,
      context,
      client,
    });
    if (!admitted.ok) {
      return;
    }
    const {
      activeRunAbort,
      admittedSessionId,
      chatSendTraceAttributes,
      cleanupAdmittedRun,
      finishAbortedChatSend,
      gatewayWorkAdmission,
      lifecycleGeneration,
      originatingRoute,
      restartSafeAdmission,
      setReleaseGatewayRootContinuation,
    } = admitted.value;
    let parsedMessage = inboundMessage;
    let parsedImages: ChatImageContent[] = [];
    let imageOrder: PromptImageOrderEntry[] = [];
    let offloadedRefs: OffloadedRef[] = [];
    let mediaPathOffloadPaths: string[] = [];
    let mediaPathOffloadTypes: string[] = [];
    let mediaPathOffloadWorkspaceDir: string | undefined;
    const explicitOriginTargetsPlugin = explicitOriginTargetsPluginBinding(explicitOrigin);
    let prepareAttachmentsMs: number | undefined;
    if (normalizedAttachments.length > 0) {
      const prepareAttachmentsStartedAtMs = performance.now();
      try {
        await measureDiagnosticsTimelineSpan(
          "gateway.chat_send.prepare_attachments",
          async () => {
            const supportsSessionModelImages = await resolveGatewayModelSupportsImages({
              loadGatewayModelCatalog: context.loadGatewayModelCatalog,
              provider: resolvedSessionModel.provider,
              model: resolvedSessionModel.model,
            });
            const explicitOriginSupportsInlineImages =
              explicitOriginTargetsAcpSession(explicitOrigin) || explicitOriginTargetsPlugin;
            // Bound plugin sessions own the real recipient model, so keep image
            // attachments even when the parent OpenClaw session model is text-only.
            const supportsImages = supportsSessionModelImages || explicitOriginSupportsInlineImages;
            const routeImageOffloadsAsMediaPaths = !supportsImages;
            const parsed = await parseMessageWithAttachments(
              inboundMessage,
              normalizedAttachments,
              {
                maxBytes: resolveChatAttachmentMaxBytes(cfg),
                log: context.logGateway,
                supportsImages,
                // chat.send routes selected offloadedRefs into ctx.MediaPaths below
                // so the auto-reply stage pipeline can surface them to the agent.
                acceptNonImage: true,
              },
            );
            parsedMessage = stripTrailingOffloadedMediaMarkers(
              parsed.message,
              routeImageOffloadsAsMediaPaths
                ? parsed.offloadedRefs.filter((ref) => ref.mimeType.startsWith("image/"))
                : [],
            );
            parsedImages = parsed.images;
            imageOrder = routeImageOffloadsAsMediaPaths ? [] : parsed.imageOrder;
            offloadedRefs = parsed.offloadedRefs;
            ({
              paths: mediaPathOffloadPaths,
              types: mediaPathOffloadTypes,
              workspaceDir: mediaPathOffloadWorkspaceDir,
            } = await prestageMediaPathOffloads({
              offloadedRefs,
              // Text-only image offloads need ctx.MediaPaths so media-understanding
              // can describe them via agents.defaults.imageModel. Vision-capable
              // image offloads stay as prompt refs for native image loading.
              includeImageRefs: routeImageOffloadsAsMediaPaths,
              cfg,
              sessionKey,
              agentId,
            }));
          },
          {
            phase: "agent-turn",
            config: cfg,
            attributes: {
              ...chatSendTraceAttributes,
              attachmentCount: normalizedAttachments.length,
            },
          },
        );
        prepareAttachmentsMs = roundedChatSendTimingMs(
          performance.now() - prepareAttachmentsStartedAtMs,
        );
      } catch (err) {
        cleanupAdmittedRun({ force: true });
        clearAgentRunContext(clientRunId, lifecycleGeneration);
        logAttachmentFailure(context.logGateway, "chat.send attachment parse/stage failed", err);
        respond(
          false,
          undefined,
          errorShape(
            err instanceof MediaOffloadError ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
            String(err),
          ),
        );
        return;
      }
    }
    if (activeRunAbort.controller.signal.aborted) {
      finishAbortedChatSend();
      return;
    }

    // Attachment preparation and admission can suspend. Recheck immediately
    // before ACK/dispatch so hot config reload cannot cross the send boundary.
    if (sessionRoutingChanged(context.getRuntimeConfig())) {
      cleanupAdmittedRun({ force: true });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      respondChatSessionRoutingChanged(respond);
      return;
    }

    const admissionStartedAt = Date.now();
    const terminalizeRestartSafeAdmission = async (terminalState: {
      retryable: boolean;
      status: "failed" | "killed";
    }): Promise<boolean> =>
      await terminalizeRestartSafeChatAdmission({
        admittedSessionId,
        clientRunId,
        sessionKey,
        startedAt: admissionStartedAt,
        storePath,
        ...terminalState,
      });

    try {
      const userTurn = createGatewayChatUserTurnController({
        agentId,
        cfg,
        clientRunId,
        initialSessionId: admittedSessionId,
        now,
        ...(systemInputProvenance ? { provenance: systemInputProvenance } : {}),
        rawMessage,
        ...(restartSafeAdmission ? { restartAdmission: restartSafeAdmission } : {}),
        senderIsOwner: hasGatewayAdminScope(client),
        sessionKey,
        ...(sessionLoadOptions ? { sessionLoadOptions } : {}),
        startedAt: admissionStartedAt,
        traceAttributes: chatSendTraceAttributes,
        warn: (message) => context.logGateway.warn(message),
      });
      const {
        baseInput: baseUserTurnInput,
        persist: persistGatewayUserTurnTranscript,
        persistBestEffort: persistGatewayUserTurnTranscriptBestEffort,
        recorder: userTurnRecorder,
      } = userTurn;
      if (restartSafeAdmission) {
        const persistedUserTurn = await persistGatewayUserTurnTranscript();
        const admittedEntry = persistedUserTurn?.sessionEntry;
        // A matching idempotency row and lifecycle claim commit atomically, so
        // retries adopt the durable turn without submitting it twice.
        if (
          !persistedUserTurn ||
          admittedEntry?.status !== "running" ||
          admittedEntry.restartRecoveryDeliveryRunId !== clientRunId
        ) {
          throw new Error("chat turn was not durably admitted");
        }
        if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
          if (activeRunAbort.entry) {
            activeRunAbort.entry.abortStopReason = "restart";
          }
          activeRunAbort.controller.abort(createAgentRunRestartAbortError());
        }
        if (activeRunAbort.controller.signal.aborted) {
          if (
            !(await terminalizeRestartSafeAdmission({
              retryable: activeRunAbort.entry?.abortStopReason === "restart",
              status: "killed",
            }))
          ) {
            throw new Error("chat admission ownership changed before terminalization");
          }
          finishAbortedChatSend();
          return;
        }
        if (sessionRoutingChanged(context.getRuntimeConfig())) {
          if (!(await terminalizeRestartSafeAdmission({ retryable: true, status: "failed" }))) {
            throw new Error("chat admission ownership changed before terminalization");
          }
          cleanupAdmittedRun({ force: true });
          clearAgentRunContext(clientRunId, lifecycleGeneration);
          respondChatSessionRoutingChanged(respond);
          return;
        }
      }

      const serverTiming = shouldIncludeChatSendAckServerTiming(clientInfo)
        ? {
            receivedToAckMs: roundedChatSendTimingMs(performance.now() - chatSendReceivedAtMs),
            loadSessionMs: sessionLoadMs,
            ...(prepareAttachmentsMs !== undefined ? { prepareAttachmentsMs } : {}),
          }
        : undefined;
      const chatSendTiming: ChatRunTiming | undefined =
        serverTiming && typeof client?.connId === "string" && client.connId.trim()
          ? {
              ackedAtMs: performance.now(),
              connId: client.connId.trim(),
              receivedAtMs: chatSendReceivedAtMs,
            }
          : undefined;
      context.addChatRun(clientRunId, {
        sessionKey,
        agentId: selectedAgent.agentId,
        clientRunId,
        ...(chatSendTiming ? { chatSendTiming } : {}),
      });
      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
        ...(serverTiming ? { serverTiming } : {}),
      };
      emitDiagnosticsTimelineEvent(
        {
          type: "mark",
          name: "gateway.chat_send.ack_ready",
          phase: "agent-turn",
          attributes: {
            ...chatSendTraceAttributes,
            ackStatus: ackPayload.status,
            ...chatSendAckServerTimingAttributes(serverTiming),
          },
        },
        { config: cfg },
      );
      respond(true, ackPayload, undefined, { runId: clientRunId });
      const chatSendAckedAtMs = chatSendTiming?.ackedAtMs ?? performance.now();
      const titleSource = stripInlineDirectiveTagsForDisplay(rawMessage).text;
      if (isDashboardSessionTitleCandidate({ sessionKey, userMessage: titleSource })) {
        void runWithGatewayIndependentRootWorkContinuation(async () => {
          const titleEntry =
            entry?.sessionId === admittedSessionId
              ? entry
              : loadSessionEntry(sessionKey, sessionLoadOptions).entry;
          const titleSessionId = titleEntry?.sessionId;
          if (!titleSessionId) {
            return;
          }
          const updated = await maybeGenerateDashboardSessionTitle({
            cfg,
            agentId,
            entry: titleEntry,
            sessionId: titleSessionId,
            sessionKey,
            storePath,
            userMessage: titleSource,
          });
          if (updated) {
            emitSessionsChanged(context, {
              sessionKey,
              agentId,
              reason: "chat.title",
            });
          }
        }).catch((err: unknown) => {
          context.logGateway.warn(
            `dashboard session title generation failed: ${formatForLog(err)}`,
          );
        });
      }
      const persistedImagesPromise = persistChatSendImages({
        images: parsedImages,
        imageOrder,
        offloadedRefs,
        client,
        logGateway: context.logGateway,
      });
      let persistedMediaForTranscript: SavedMedia[] | undefined;
      const getPersistedMediaForTranscript = async () => {
        if (!persistedMediaForTranscript) {
          persistedMediaForTranscript = await persistedImagesPromise;
        }
        return persistedMediaForTranscript;
      };
      const preparedUserTurnMediaPromise =
        normalizedAttachments.length > 0 ? getPersistedMediaForTranscript() : Promise.resolve([]);
      const userTurnMediaPromise = preparedUserTurnMediaPromise.then(buildChatSendUserTurnMedia);
      userTurn.setInputPromise(
        userTurnMediaPromise.then((media) => ({
          ...baseUserTurnInput,
          ...(media.length > 0
            ? {
                media,
                mediaOnlyText: "[User sent media without caption]",
              }
            : {}),
        })),
      );
      const pluginBoundMediaFieldsPromise =
        explicitOriginTargetsPlugin && parsedImages.length > 0
          ? preparedUserTurnMediaPromise.then(resolveChatSendManagedMediaFields)
          : Promise.resolve({});

      const trimmedMessage = parsedMessage.trim();
      const commandBody = parsedMessage;
      const commandSource =
        !suppressCommandInterpretation && trimmedMessage.startsWith("/") ? "text" : undefined;
      const messageForAgent = systemProvenanceReceipt
        ? [systemProvenanceReceipt, parsedMessage].filter(Boolean).join("\n\n")
        : parsedMessage;
      const queuedFollowupOwnerDeviceId = normalizeOptionalText(client?.connect?.device?.id);
      const queuedFollowupOwnerConnId = normalizeOptionalText(client?.connId);
      const queuedFollowupOwnerKey = queuedFollowupOwnerDeviceId
        ? `device:${queuedFollowupOwnerDeviceId}`
        : queuedFollowupOwnerConnId
          ? `connection:${queuedFollowupOwnerConnId}`
          : undefined;
      const {
        originatingChannel,
        originatingTo,
        accountId,
        messageThreadId,
        explicitDeliverRoute,
      } = originatingRoute;
      // The per-message timestamp prefix is now applied at the single LLM
      // boundary (normalizeMessagesForLlmBoundary), derived from each message's
      // own timestamp, so the current turn and all historical turns carry
      // identical bytes on the wire. BodyForAgent uses the same bare text as
      // Body; the transient gateway stamp is removed (stamping the live turn
      // here would diverge from bare stored history and bust the prompt cache).
      // See: https://github.com/openclaw/openclaw/issues/3658
      const ctx: MsgContext = {
        Body: messageForAgent,
        BodyForAgent: messageForAgent,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        InputProvenance: systemInputProvenance,
        SessionKey: sessionKey,
        AgentId: agentId,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: originatingChannel,
        OriginatingTo: originatingTo,
        ExplicitDeliverRoute: explicitDeliverRoute,
        AccountId: accountId,
        MessageThreadId: messageThreadId,
        ChatType: "direct",
        ...(commandSource ? { CommandSource: commandSource } : {}),
        CommandAuthorized: !suppressCommandInterpretation,
        CommandTurn: commandSource
          ? {
              kind: "text-slash",
              source: commandSource,
              authorized: true,
              body: commandBody,
            }
          : {
              kind: "normal",
              source: "message",
              authorized: false,
              body: commandBody,
            },
        MessageSid: clientRunId,
        ApprovalReviewerDeviceId: queuedFollowupOwnerDeviceId,
        ...(!isOperatorUiClient(clientInfo)
          ? {
              SenderId: clientInfo?.id,
              SenderName: clientInfo?.displayName,
              SenderUsername: clientInfo?.displayName,
            }
          : {}),
        GatewayClientScopes: client?.connect?.scopes ?? [],
        GatewayClientCaps: client?.connect?.caps ?? [],
      };
      const isInternalTextSlashCommandTurn =
        ctx.Provider === INTERNAL_MESSAGE_CHANNEL && ctx.CommandSource === "text";
      if (mediaPathOffloadPaths.length > 0) {
        // Inject offloads via the same MsgContext fields the channel
        // path uses so buildInboundMediaNote renders a real `[media attached:
        // <workspace-relative-path>]` line into the agent prompt. Marker
        // blocks the dispatch pipeline from re-running stageSandboxMedia; see
        // prestageMediaPathOffloads.
        ctx.MediaPath = mediaPathOffloadPaths[0];
        ctx.MediaPaths = mediaPathOffloadPaths;
        ctx.MediaType = mediaPathOffloadTypes[0];
        ctx.MediaTypes = mediaPathOffloadTypes;
        ctx.MediaWorkspaceDir = mediaPathOffloadWorkspaceDir;
        ctx.MediaStaged = true;
      }
      const mediaPathOffloadsIncludeImages = mediaPathOffloadTypes.some((type) =>
        type.startsWith("image/"),
      );
      const replyOptionImages = mediaPathOffloadsIncludeImages
        ? undefined
        : parsedImages.length > 0
          ? parsedImages
          : undefined;

      const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
        cfg,
        agentId,
        channel: INTERNAL_MESSAGE_CHANNEL,
      });
      const deliveredReplies: Array<{ payload: ReplyPayload; kind: "block" | "final" }> = [];
      let appendedWebchatAgentMedia = false;
      let agentRunStarted = false;
      let queuedFollowupEnqueued = false;
      let pendingDispatchLifecycleError:
        | {
            endedAt: number;
            error: string;
            sessionId: string;
            startedAt: number;
          }
        | undefined;
      let persistDispatchErrorUserTurn: (() => Promise<void>) | undefined;
      const appendWebchatAgentMediaTranscriptIfNeeded = async (payload: ReplyPayload) => {
        if (!agentRunStarted || appendedWebchatAgentMedia || !isMediaBearingPayload(payload)) {
          return;
        }
        if (isSourceReplyTranscriptMirrorPayload(payload)) {
          return;
        }
        const ttsSupplementMarker = buildTtsSupplementTranscriptMarker(payload);
        const [transcriptPayload] = await normalizeWebchatReplyMediaPathsForDisplay({
          cfg,
          sessionKey,
          agentId,
          accountId,
          payloads: [stripVisibleTextFromTtsSupplement(payload)],
        });
        if (!transcriptPayload) {
          return;
        }
        const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
          sessionKey,
          sessionLoadOptions,
        );
        const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
        const mediaLocalRoots = appendLocalMediaParentRoots(
          getAgentScopedMediaLocalRoots(cfg, agentId),
          latestStorePath ? [latestStorePath] : undefined,
        );
        const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
          sessionKey,
          agentId,
          payloads: [transcriptPayload],
          managedImageLocalRoots: mediaLocalRoots,
          includeSensitiveMedia: transcriptPayload.sensitiveMedia !== true,
          onLocalAudioAccessDenied: (message) => {
            context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
          },
          onManagedImagePrepareError: (message) => {
            context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
          },
        });
        const mediaMessage = await buildWebchatAssistantMediaMessage([transcriptPayload], {
          localRoots: mediaLocalRoots,
          onLocalAudioAccessDenied: (message) => {
            context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
          },
        });
        const persistedAssistantContent = replaceAssistantContentTextBlocks(
          assistantContent,
          mediaMessage,
        );
        const persistedContentForAppend = hasAssistantDisplayMediaContent(persistedAssistantContent)
          ? persistedAssistantContent
          : undefined;
        if (!persistedContentForAppend?.length) {
          return;
        }
        const transcriptReply =
          mediaMessage?.transcriptText ??
          extractAssistantDisplayTextFromContent(assistantContent) ??
          buildTranscriptReplyText([transcriptPayload]);
        if (!transcriptReply && !persistedAssistantContent?.length && !assistantContent?.length) {
          return;
        }
        const appended = await appendAssistantTranscriptMessage({
          sessionKey,
          message: transcriptReply,
          ...(persistedContentForAppend?.length ? { content: persistedContentForAppend } : {}),
          sessionId,
          storePath: latestStorePath,
          sessionFile: latestEntry?.sessionFile,
          agentId,
          createIfMissing: true,
          idempotencyKey: `${clientRunId}:assistant-media`,
          ttsSupplement: ttsSupplementMarker,
          cfg,
        });
        if (appended.ok) {
          if (appended.messageId && assistantContent?.length) {
            await attachManagedOutgoingImagesToMessage({
              messageId: appended.messageId,
              blocks: assistantContent,
            });
          }
          appendedWebchatAgentMedia = true;
          return;
        }
        context.logGateway.warn(
          `webchat transcript append failed for media reply: ${appended.error ?? "unknown error"}`,
        );
      };
      const dispatcher = createReplyDispatcher({
        ...replyPipeline,
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          if (getReplyPayloadMetadata(payload)?.beforeAgentRunBlocked === true) {
            userTurnRecorder.markBlocked();
          }
          switch (info.kind) {
            case "block":
            case "final":
              deliveredReplies.push({ payload, kind: info.kind });
              await appendWebchatAgentMediaTranscriptIfNeeded(payload);
              break;
            case "tool":
              // Tool results that carry audio (e.g. the TTS tool) must be promoted
              // to "final" so the downstream audio extraction path can pick them up.
              // Strip text to avoid leaking tool summary into the combined reply.
              if (isMediaBearingPayload(payload)) {
                deliveredReplies.push({
                  payload: { ...payload, text: undefined },
                  kind: "final",
                });
              }
              break;
          }
        },
      });

      const emitServerTiming = (
        phase: ChatSendServerTimingPhase,
        extra?: Record<string, string | number>,
        dispatchStartedAtMs?: number,
      ) => {
        emitOperatorChatSendServerTiming({
          context,
          client,
          phase,
          runId: clientRunId,
          sessionKey,
          agentId,
          receivedAtMs: chatSendReceivedAtMs,
          ackedAtMs: chatSendAckedAtMs,
          dispatchStartedAtMs,
          extra,
        });
      };
      const dispatchStartedAtMs = performance.now();
      if (chatSendTiming) {
        chatSendTiming.dispatchStartedAtMs = dispatchStartedAtMs;
      }
      emitServerTiming("dispatch-started");
      let firstAssistantServerTimingEmitted = false;
      const emitFirstAssistantServerTiming = () => {
        if (firstAssistantServerTimingEmitted || chatSendTiming?.firstAssistantEventSent) {
          return;
        }
        firstAssistantServerTimingEmitted = true;
        if (chatSendTiming) {
          chatSendTiming.firstAssistantEventSent = true;
        }
        emitServerTiming("first-assistant-event", undefined, dispatchStartedAtMs);
      };
      // Reserve the detached dispatch before this request releases its root. Otherwise
      // its inherited ALS context becomes retired and rejects queued/session work.
      setReleaseGatewayRootContinuation(retainGatewayRootWorkAdmissionContinuation() ?? undefined);
      void gatewayWorkAdmission
        .run(() =>
          measureDiagnosticsTimelineSpan(
            "gateway.chat_send.dispatch_inbound",
            async () => {
              applyChatSendManagedMediaFields(ctx, await pluginBoundMediaFieldsPromise);
              const dispatchResult = await dispatchInboundMessage({
                ctx,
                cfg,
                dispatcher,
                onSessionMetadataChanges: (changes) => {
                  for (const change of changes) {
                    emitSessionsChanged(context, change);
                  }
                },
                replyOptions: {
                  runId: clientRunId,
                  ...(isOperatorUiClient(clientInfo)
                    ? {
                        promptCacheKey: resolveWebchatPromptCacheKey({
                          agentId,
                          provider: resolvedSessionModel.provider,
                          model: resolvedSessionModel.model,
                          sessionKey: activeRunScopeKey,
                        }),
                      }
                    : {}),
                  ...(supportsTaskSuggestions
                    ? { taskSuggestionDeliveryMode: "gateway" as const }
                    : {}),
                  requestedSessionId,
                  ...(restartSafeAdmission
                    ? {
                        expectedExistingSessionId: admittedSessionId,
                        pinExpectedExistingSession: true,
                      }
                    : entry?.sessionId
                      ? { expectedExistingSessionId: entry.sessionId }
                      : {}),
                  resumeRequestedSession: reconnectResumeRequested,
                  onSessionPrepared: (binding) => {
                    if (binding.sessionKey === sessionKey) {
                      userTurn.setAcceptedSessionId(binding.sessionId);
                    }
                  },
                  abortSignal: activeRunAbort.controller.signal,
                  // Keep a Gateway-owned cancel identity after this chat.send
                  // terminalizes while the prompt waits in followup/collect queue.
                  queuedFollowupLifecycle: {
                    ownerKey: queuedFollowupOwnerKey,
                    onEnqueued: () => {
                      queuedFollowupEnqueued = registerQueuedChatTurn({
                        chatQueuedTurns: ensureChatQueuedTurns(context),
                        runId: clientRunId,
                        controller: activeRunAbort.controller,
                        sessionId: backingSessionId ?? clientRunId,
                        sessionKey,
                        agentId: selectedAgent.agentId,
                        ownerConnId: normalizeOptionalText(client?.connId),
                        ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
                      });
                      return queuedFollowupEnqueued;
                    },
                    onCancellationRetired: () => {
                      retireQueuedChatTurnCancellation(
                        ensureChatQueuedTurns(context),
                        clientRunId,
                        activeRunAbort.controller,
                      );
                    },
                    onComplete: () => {
                      completeQueuedChatTurn(
                        ensureChatQueuedTurns(context),
                        clientRunId,
                        activeRunAbort.controller,
                      );
                    },
                  },
                  images: replyOptionImages,
                  imageOrder: imageOrder.length > 0 ? imageOrder : undefined,
                  thinkingLevelOverride: p.thinking,
                  fastModeOverride: p.fastMode,
                  userTurnTranscriptRecorder: userTurnRecorder,
                  ...(restartSafeAdmission ? { suppressNextUserMessagePersistence: true } : {}),
                  fastModeAutoOnSecondsOverride: p.fastAutoOnSeconds,
                  onAgentRunStart: (runId) => {
                    agentRunStarted = true;
                    emitServerTiming(
                      "agent-run-started",
                      runId !== clientRunId ? { agentRunId: runId } : undefined,
                      dispatchStartedAtMs,
                    );
                    const connId = typeof client?.connId === "string" ? client.connId : undefined;
                    const wantsToolEvents = hasGatewayClientCap(
                      client?.connect?.caps,
                      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
                    );
                    if (connId && wantsToolEvents) {
                      context.registerToolEventRecipient(runId, connId);
                      // Register for any other active runs *in the same session* so
                      // late-joining clients (e.g. page refresh mid-response) receive
                      // in-progress tool events without leaking cross-session data.
                      const defaultAgentId = resolveDefaultAgentId(cfg);
                      const selectedGlobalAgentId =
                        sessionKey === "global"
                          ? (selectedAgent.agentId ?? defaultAgentId)
                          : undefined;
                      for (const [activeRunId, active] of context.chatAbortControllers) {
                        const activeGlobalAgentId =
                          active.sessionKey === "global"
                            ? (active.agentId ?? defaultAgentId)
                            : undefined;
                        const sameSelectedGlobalAgent =
                          sessionKey === "global" &&
                          selectedGlobalAgentId !== undefined &&
                          activeGlobalAgentId === selectedGlobalAgentId;
                        const sameSession =
                          active.sessionKey === sessionKey &&
                          (sessionKey !== "global" || sameSelectedGlobalAgent);
                        if (activeRunId !== runId && sameSession) {
                          context.registerToolEventRecipient(activeRunId, connId);
                        }
                      }
                    }
                  },
                  onModelSelected: (modelSelection) => {
                    updateChatRunProvider(context.chatAbortControllers, {
                      runId: clientRunId,
                      providerId: modelSelection.provider,
                      authProviderId: resolveProviderIdForAuth(modelSelection.provider, {
                        config: cfg,
                      }),
                    });
                    onModelSelected(modelSelection);
                    emitServerTiming(
                      "model-selected",
                      {
                        provider: modelSelection.provider,
                        model: modelSelection.model,
                      },
                      dispatchStartedAtMs,
                    );
                  },
                },
              });
              if (dispatchResult.beforeAgentRunBlocked === true) {
                userTurnRecorder.markBlocked();
              }
              return dispatchResult;
            },
            {
              phase: "agent-turn",
              config: cfg,
              attributes: chatSendTraceAttributes,
            },
          ),
        )
        .then(async () => {
          emitServerTiming("dispatch-completed", undefined, dispatchStartedAtMs);
          const postDispatchStartedAtMs = performance.now();
          await measureDiagnosticsTimelineSpan(
            "gateway.chat_send.post_dispatch",
            async () => {
              const returnedAgentErrorPayloads = agentRunStarted
                ? deliveredReplies
                    .map((entryInner) => entryInner.payload)
                    .filter((payload) => payload.isError)
                : [];
              const returnedAgentErrorMessage =
                returnedAgentErrorPayloads
                  .map((payload) => payload.text?.trim())
                  .filter((text): text is string => Boolean(text))
                  .join(" | ") || undefined;
              if (
                agentRunStarted &&
                returnedAgentErrorPayloads.length > 0 &&
                !userTurnRecorder.hasPersisted() &&
                !userTurnRecorder.isBlocked()
              ) {
                await persistGatewayUserTurnTranscriptBestEffort();
              }
              if (
                agentRunStarted &&
                returnedAgentErrorPayloads.length === 0 &&
                !userTurnRecorder.hasPersisted() &&
                !userTurnRecorder.isBlocked() &&
                userTurnRecorder.hasRuntimePersistencePending()
              ) {
                await persistGatewayUserTurnTranscriptBestEffort();
              }
              let broadcastedSourceReplyFinal = false;
              // WebChat persistence has two owners. Agent runs persist model-visible turns
              // through OpenClaw runtime's SessionManager; this dispatcher only owns live delivery payloads.
              // Do not blindly mirror agent-run final payloads into JSONL or chat.history can
              // duplicate normal embedded-agent assistant turns. The non-agent branch below has no
              // runtime-owned assistant turn, so it appends a gateway-injected assistant entry before
              // broadcasting the final UI event.
              if (!agentRunStarted && !queuedFollowupEnqueued) {
                const btwReplies = deliveredReplies
                  .map((entryScoped) => entryScoped.payload)
                  .filter(isBtwReplyPayload);
                const btwText = btwReplies
                  .map((payload) => payload.text.trim())
                  .filter(Boolean)
                  .join("\n\n")
                  .trim();
                if (btwReplies.length > 0 && btwText) {
                  broadcastSideResult({
                    context,
                    payload: {
                      kind: "btw",
                      runId: clientRunId,
                      sessionKey,
                      ...(sessionKey === "global" && agentId ? { agentId } : {}),
                      question: expectDefined(
                        btwReplies[0],
                        "btw replies entry at 0",
                      ).btw.question.trim(),
                      text: btwText,
                      isError: btwReplies.some((payload) => payload.isError),
                      ts: Date.now(),
                    },
                  });
                  broadcastChatFinal({
                    context,
                    runId: clientRunId,
                    sessionKey,
                    agentId,
                  });
                } else {
                  const finalPayloadEntries = deliveredReplies.filter(
                    (entryItem) => entryItem.kind === "final",
                  );
                  const parseReplyInlineDirectives = (payload: ReplyPayload) =>
                    typeof payload.text === "string" && payload.text.includes("[[")
                      ? parseInlineDirectives(payload.text)
                      : undefined;
                  const shouldFoldCommandBlocks = isInternalTextSlashCommandTurn;
                  const commandBlockPayloadEntries = shouldFoldCommandBlocks
                    ? deliveredReplies.filter((entryItem) => entryItem.kind === "block")
                    : [];
                  const replyMediaUrls = (payload: ReplyPayload) =>
                    resolveSendableOutboundReplyParts(payload).mediaUrls;
                  const normalizeCommandMediaDedupeKey = (value: string): string => {
                    const trimmed = value.trim();
                    if (!trimmed) {
                      return "";
                    }
                    if (!trimmed.toLowerCase().startsWith("file://")) {
                      return path.isAbsolute(trimmed) ? path.normalize(trimmed) : trimmed;
                    }
                    try {
                      const parsed = new URL(trimmed);
                      if (parsed.protocol === "file:") {
                        return path.normalize(fileURLToPath(parsed));
                      }
                    } catch {
                      // Keep malformed file URL-like values comparable with the fallback below.
                    }
                    return trimmed.replace(/^file:\/\//iu, "");
                  };
                  const replyMediaDedupeKeys = (payload: ReplyPayload) =>
                    replyMediaUrls(payload).map((mediaUrl) =>
                      normalizeCommandMediaDedupeKey(mediaUrl),
                    );
                  const canonicalizeReplyMedia = (payload: ReplyPayload): ReplyPayload => {
                    const mediaUrls = replyMediaUrls(payload);
                    return {
                      ...payload,
                      mediaUrl: undefined,
                      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
                    };
                  };
                  const mergeDefinedReplySemantics = (
                    target: ReplyPayload,
                    source: ReplyPayload,
                  ): ReplyPayload => {
                    const sourceInlineDirectives = parseReplyInlineDirectives(source);
                    const sourceReplyToId =
                      sanitizeReplyDirectiveId(source.replyToId) ??
                      sanitizeReplyDirectiveId(sourceInlineDirectives?.replyToExplicitId);
                    return {
                      ...target,
                      ...(source.trustedLocalMedia === true || target.trustedLocalMedia === true
                        ? { trustedLocalMedia: true }
                        : {}),
                      ...(source.sensitiveMedia === true || target.sensitiveMedia === true
                        ? { sensitiveMedia: true }
                        : {}),
                      ...(source.presentation !== undefined
                        ? { presentation: source.presentation }
                        : {}),
                      ...(source.delivery !== undefined ? { delivery: source.delivery } : {}),
                      ...(source.interactive !== undefined
                        ? { interactive: source.interactive }
                        : {}),
                      ...(sourceReplyToId !== undefined ? { replyToId: sourceReplyToId } : {}),
                      ...(source.replyToTag === true || target.replyToTag === true
                        ? { replyToTag: true }
                        : {}),
                      ...(source.replyToCurrent === true ||
                      sourceInlineDirectives?.replyToCurrent === true ||
                      target.replyToCurrent === true
                        ? { replyToCurrent: true }
                        : {}),
                      ...(source.audioAsVoice === true ||
                      sourceInlineDirectives?.audioAsVoice === true ||
                      target.audioAsVoice === true
                        ? { audioAsVoice: true }
                        : {}),
                      ...(source.spokenText !== undefined ? { spokenText: source.spokenText } : {}),
                      ...(source.ttsSupplement !== undefined
                        ? { ttsSupplement: source.ttsSupplement }
                        : {}),
                      ...(source.isError === true || target.isError === true
                        ? { isError: true }
                        : {}),
                      ...(source.channelData !== undefined
                        ? { channelData: source.channelData }
                        : {}),
                    };
                  };
                  const mergeMediaReplySemantics = (
                    target: ReplyPayload,
                    source: ReplyPayload,
                  ): ReplyPayload => {
                    const sourceInlineDirectives = parseReplyInlineDirectives(source);
                    return {
                      ...target,
                      ...(source.trustedLocalMedia === true || target.trustedLocalMedia === true
                        ? { trustedLocalMedia: true }
                        : {}),
                      ...(source.sensitiveMedia === true || target.sensitiveMedia === true
                        ? { sensitiveMedia: true }
                        : {}),
                      ...(source.audioAsVoice === true ||
                      sourceInlineDirectives?.audioAsVoice === true ||
                      target.audioAsVoice === true
                        ? { audioAsVoice: true }
                        : {}),
                    };
                  };
                  const hasMergeableReplySemantics = (payload: ReplyPayload): boolean => {
                    const inlineDirectives = parseReplyInlineDirectives(payload);
                    return Boolean(
                      payload.trustedLocalMedia !== undefined ||
                      payload.sensitiveMedia !== undefined ||
                      payload.presentation ||
                      payload.delivery ||
                      payload.interactive ||
                      payload.replyToId ||
                      payload.replyToTag !== undefined ||
                      payload.replyToCurrent !== undefined ||
                      payload.audioAsVoice !== undefined ||
                      inlineDirectives?.hasReplyTag ||
                      inlineDirectives?.hasAudioTag ||
                      payload.spokenText ||
                      payload.ttsSupplement ||
                      payload.isError !== undefined ||
                      payload.channelData,
                    );
                  };
                  const hasUnmergedReplySemantics = (payload: ReplyPayload): boolean =>
                    Boolean(
                      payload.isReasoning ||
                      payload.isReasoningSnapshot ||
                      payload.isCompactionNotice ||
                      payload.isFallbackNotice ||
                      payload.isStatusNotice ||
                      payload.btw,
                    );
                  const hasReplySemantics = (payload: ReplyPayload): boolean =>
                    hasMergeableReplySemantics(payload) || hasUnmergedReplySemantics(payload);
                  const mediaSetsMatch = (
                    leftMediaUrls: readonly string[],
                    rightMediaUrls: readonly string[],
                  ): boolean => {
                    if (leftMediaUrls.length !== rightMediaUrls.length) {
                      return false;
                    }
                    return leftMediaUrls.every(
                      (mediaUrl, index) => mediaUrl === rightMediaUrls[index],
                    );
                  };
                  const replyDisplayText = (payload: ReplyPayload): string =>
                    sanitizeAssistantDisplayText(payload.text) ?? "";
                  const commandBlockPayloadEntriesForDelivery = commandBlockPayloadEntries.map(
                    (entryItem) => ({
                      kind: entryItem.kind,
                      payload: canonicalizeReplyMedia(entryItem.payload),
                    }),
                  );
                  const sensitiveMediaDedupeKeys = new Set(
                    finalPayloadEntries.flatMap((entryItem) =>
                      entryItem.payload.sensitiveMedia === true
                        ? replyMediaDedupeKeys(entryItem.payload).filter(Boolean)
                        : [],
                    ),
                  );
                  if (sensitiveMediaDedupeKeys.size > 0) {
                    for (const entryItem of commandBlockPayloadEntriesForDelivery) {
                      if (
                        replyMediaDedupeKeys(entryItem.payload).some((key) =>
                          sensitiveMediaDedupeKeys.has(key),
                        )
                      ) {
                        entryItem.payload = { ...entryItem.payload, sensitiveMedia: true };
                      }
                    }
                  }
                  const finalPayloadEntriesForDelivery = shouldFoldCommandBlocks
                    ? finalPayloadEntries.flatMap((entryItem) => {
                        const finalMediaUrls = replyMediaUrls(entryItem.payload);
                        const finalMediaKeys = replyMediaDedupeKeys(entryItem.payload);
                        const finalDisplayText = replyDisplayText(entryItem.payload);
                        const matchingMediaBlockEntry =
                          finalMediaUrls.length > 0
                            ? commandBlockPayloadEntriesForDelivery.find((candidate) =>
                                mediaSetsMatch(
                                  replyMediaDedupeKeys(candidate.payload),
                                  finalMediaKeys,
                                ),
                              )
                            : undefined;
                        const matchingTextBlockEntry = finalDisplayText
                          ? commandBlockPayloadEntriesForDelivery.find(
                              (candidate) =>
                                replyDisplayText(candidate.payload) === finalDisplayText,
                            )
                          : undefined;
                        const matchingMediaAndTextBlockEntry =
                          finalMediaUrls.length > 0 && finalDisplayText
                            ? commandBlockPayloadEntriesForDelivery.find(
                                (candidate) =>
                                  replyDisplayText(candidate.payload) === finalDisplayText &&
                                  mediaSetsMatch(
                                    replyMediaDedupeKeys(candidate.payload),
                                    finalMediaKeys,
                                  ),
                              )
                            : undefined;
                        const duplicateBlockEntry =
                          finalMediaUrls.length > 0
                            ? finalDisplayText
                              ? matchingMediaAndTextBlockEntry
                              : matchingMediaBlockEntry
                            : finalMediaUrls.length === 0
                              ? matchingTextBlockEntry
                              : undefined;
                        if (duplicateBlockEntry) {
                          duplicateBlockEntry.payload = mergeDefinedReplySemantics(
                            duplicateBlockEntry.payload,
                            entryItem.payload,
                          );
                        } else if (matchingMediaBlockEntry) {
                          matchingMediaBlockEntry.payload = mergeMediaReplySemantics(
                            matchingMediaBlockEntry.payload,
                            entryItem.payload,
                          );
                        }
                        const remainingFinalMediaUrls = matchingMediaBlockEntry
                          ? []
                          : finalMediaUrls;
                        if (
                          remainingFinalMediaUrls.length === 0 &&
                          ((duplicateBlockEntry && !hasUnmergedReplySemantics(entryItem.payload)) ||
                            (!duplicateBlockEntry &&
                              !finalDisplayText &&
                              !hasReplySemantics(entryItem.payload)))
                        ) {
                          return [];
                        }
                        return [
                          {
                            ...entryItem,
                            payload: {
                              ...entryItem.payload,
                              mediaUrl: undefined,
                              mediaUrls:
                                remainingFinalMediaUrls.length > 0
                                  ? remainingFinalMediaUrls
                                  : undefined,
                            },
                          },
                        ];
                      })
                    : finalPayloadEntries;
                  // Non-agent command paths can enqueue only block replies. If no visible final
                  // supersedes them, fold those blocks into the final WebChat message.
                  const rawFinalPayloads = appendedWebchatAgentMedia
                    ? []
                    : [
                        ...commandBlockPayloadEntriesForDelivery,
                        ...finalPayloadEntriesForDelivery,
                      ].map((entryCandidate) => entryCandidate.payload);
                  const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
                    cfg,
                    sessionKey,
                    agentId,
                    accountId,
                    payloads: rawFinalPayloads,
                  });
                  const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
                    sessionKey,
                    sessionLoadOptions,
                  );
                  const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
                  const mediaLocalRoots = appendLocalMediaParentRoots(
                    getAgentScopedMediaLocalRoots(cfg, agentId),
                    latestStorePath ? [latestStorePath] : undefined,
                  );
                  const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
                    sessionKey,
                    agentId,
                    payloads: finalPayloads,
                    managedImageLocalRoots: mediaLocalRoots,
                    includeSensitiveMedia: false,
                    includeSensitiveDisplay: true,
                    onLocalAudioAccessDenied: (message) => {
                      context.logGateway.warn(
                        `webchat audio embedding denied local path: ${message}`,
                      );
                    },
                    onManagedImagePrepareError: (message) => {
                      context.logGateway.warn(
                        `webchat image embedding skipped attachment: ${message}`,
                      );
                    },
                    onSensitiveDisplayPrepareError: (message) => {
                      context.logGateway.warn(
                        `webchat sensitive display skipped attachment: ${message}`,
                      );
                    },
                  });
                  const mediaMessage = await buildWebchatAssistantMediaMessage(finalPayloads, {
                    localRoots: mediaLocalRoots,
                    onLocalAudioAccessDenied: (message) => {
                      context.logGateway.warn(
                        `webchat audio embedding denied local path: ${message}`,
                      );
                    },
                  });
                  const hasSensitiveMedia = hasSensitiveMediaPayload(finalPayloads);
                  const ttsSupplementMarker = finalPayloads
                    .map((payload) => buildMediaOnlyTtsSupplementTranscriptMarker(payload))
                    .find((marker): marker is GatewayInjectedTtsSupplementMarker =>
                      Boolean(marker),
                    );
                  const persistedAssistantContent = replaceAssistantContentTextBlocks(
                    hasSensitiveMedia
                      ? await buildAssistantDisplayContentFromReplyPayloads({
                          sessionKey,
                          agentId,
                          payloads: finalPayloads,
                          managedImageLocalRoots: mediaLocalRoots,
                          includeSensitiveMedia: false,
                          onLocalAudioAccessDenied: (message) => {
                            context.logGateway.warn(
                              `webchat audio embedding denied local path: ${message}`,
                            );
                          },
                          onManagedImagePrepareError: (message) => {
                            context.logGateway.warn(
                              `webchat image embedding skipped attachment: ${message}`,
                            );
                          },
                        })
                      : assistantContent,
                    mediaMessage,
                  );
                  const persistedContentForAppend = hasAssistantDisplayMediaContent(
                    persistedAssistantContent,
                  )
                    ? persistedAssistantContent
                    : undefined;
                  const broadcastAssistantContent = hasAssistantDisplayMediaContent(
                    assistantContent,
                  )
                    ? assistantContent
                    : hasAssistantDisplayMediaContent(mediaMessage?.content)
                      ? mediaMessage?.content
                      : assistantContent;
                  const displayReply =
                    extractAssistantDisplayTextFromContent(assistantContent) ??
                    buildTranscriptReplyText(finalPayloads);
                  const transcriptDisplayReply = displayReply
                    ? stripInlineDirectiveTagsForDisplay(displayReply).text.trim()
                    : "";
                  const transcriptReply =
                    mediaMessage?.transcriptText ||
                    buildTranscriptReplyText(finalPayloads) ||
                    transcriptDisplayReply;
                  let message: Record<string, unknown> | undefined;
                  const shouldAppendAssistantTranscript = Boolean(
                    transcriptReply || persistedContentForAppend?.length,
                  );
                  if (shouldAppendAssistantTranscript) {
                    await persistGatewayUserTurnTranscriptBestEffort();
                  } else {
                    await persistGatewayUserTurnTranscriptBestEffort();
                  }
                  if (shouldAppendAssistantTranscript) {
                    const appended = await appendAssistantTranscriptMessage({
                      sessionKey,
                      message: transcriptReply,
                      ...(persistedContentForAppend?.length
                        ? { content: persistedContentForAppend }
                        : {}),
                      sessionId,
                      storePath: latestStorePath,
                      sessionFile: latestEntry?.sessionFile,
                      agentId,
                      createIfMissing: true,
                      idempotencyKey: clientRunId,
                      ttsSupplement: ttsSupplementMarker,
                      cfg,
                    });
                    if (appended.ok) {
                      if (appended.messageId && assistantContent?.length) {
                        await attachManagedOutgoingImagesToMessage({
                          messageId: appended.messageId,
                          blocks: assistantContent,
                        });
                      }
                      message = broadcastAssistantContent?.length
                        ? { ...appended.message, content: broadcastAssistantContent }
                        : appended.message;
                    } else {
                      context.logGateway.warn(
                        `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                      );
                      const fallbackAssistantContent =
                        stripManagedOutgoingAssistantContentBlocks(persistedAssistantContent) ??
                        stripManagedOutgoingAssistantContentBlocks(assistantContent);
                      const fallbackText =
                        extractAssistantDisplayText(fallbackAssistantContent) ?? displayReply;
                      const nowValue = Date.now();
                      message = {
                        role: "assistant",
                        ...(fallbackAssistantContent?.length
                          ? { content: fallbackAssistantContent }
                          : fallbackText
                            ? { content: [{ type: "text", text: fallbackText }] }
                            : {}),
                        ...(fallbackText ? { text: fallbackText } : {}),
                        timestamp: nowValue,
                        ...(ttsSupplementMarker
                          ? { openclawTtsSupplement: ttsSupplementMarker }
                          : {}),
                        // Keep this compatible with runner stopReason enums even though this message isn't
                        // persisted to the transcript due to the append failure.
                        stopReason: "stop",
                        usage: { input: 0, output: 0, totalTokens: 0 },
                      };
                    }
                  } else if (broadcastAssistantContent?.length) {
                    message = {
                      role: "assistant",
                      content: broadcastAssistantContent,
                      text: extractAssistantDisplayText(broadcastAssistantContent) ?? "",
                      timestamp: Date.now(),
                      stopReason: "stop",
                      usage: { input: 0, output: 0, totalTokens: 0 },
                    };
                  }
                  if (hasVisibleAssistantFinalMessage(message)) {
                    emitFirstAssistantServerTiming();
                  }
                  broadcastChatFinal({
                    context,
                    runId: clientRunId,
                    sessionKey,
                    agentId,
                    message,
                  });
                }
              } else {
                const hasReturnedAgentErrorPayloads = returnedAgentErrorPayloads.length > 0;
                const agentRunReplyPayloads = deliveredReplies
                  .filter((entryEntry) => entryEntry.kind === "final")
                  .map((entryResult) => entryResult.payload)
                  .filter(
                    (payload) =>
                      isSourceReplyTranscriptMirrorPayload(payload) ||
                      (!hasReturnedAgentErrorPayloads && isReplyPayloadStatusNotice(payload)),
                  );
                if (agentRunReplyPayloads.length > 0) {
                  const hasSourceReplyTranscriptMirror = agentRunReplyPayloads.some(
                    isSourceReplyTranscriptMirrorPayload,
                  );
                  const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
                    cfg,
                    sessionKey,
                    agentId,
                    accountId,
                    payloads: agentRunReplyPayloads,
                  });
                  const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
                    sessionKey,
                    sessionLoadOptions,
                  );
                  const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
                  const mediaLocalRoots = appendLocalMediaParentRoots(
                    getAgentScopedMediaLocalRoots(cfg, agentId),
                    latestStorePath ? [latestStorePath] : undefined,
                  );
                  const buildReplyAssistantContent = async (
                    payloads: typeof finalPayloads,
                  ): Promise<AssistantDisplayContentBlock[] | undefined> =>
                    await buildAssistantDisplayContentFromReplyPayloads({
                      sessionKey,
                      agentId,
                      payloads,
                      managedImageLocalRoots: mediaLocalRoots,
                      includeSensitiveMedia: false,
                      onLocalAudioAccessDenied: (message) => {
                        context.logGateway.warn(
                          `webchat audio embedding denied local path: ${message}`,
                        );
                      },
                      onManagedImagePrepareError: (message) => {
                        context.logGateway.warn(
                          `webchat image embedding skipped attachment: ${message}`,
                        );
                      },
                    });
                  const buildReplyMediaMessage = async (payloads: typeof finalPayloads) =>
                    await buildWebchatAssistantMediaMessage(payloads, {
                      localRoots: mediaLocalRoots,
                      onLocalAudioAccessDenied: (message) => {
                        context.logGateway.warn(
                          `webchat audio embedding denied local path: ${message}`,
                        );
                      },
                    });
                  const combinedAssistantContent =
                    agentRunReplyPayloads.length === 1
                      ? await buildReplyAssistantContent(finalPayloads)
                      : undefined;
                  const combinedMediaMessage =
                    agentRunReplyPayloads.length === 1
                      ? await buildReplyMediaMessage(finalPayloads)
                      : undefined;
                  const sourceReplyContentStates: SourceReplyContentState[] = [];
                  const sourceReplyBroadcastContent: AssistantDisplayContentBlock[] = [];
                  for (const [replyIndex] of agentRunReplyPayloads.entries()) {
                    const finalPayload = finalPayloads[replyIndex];
                    if (!finalPayload) {
                      continue;
                    }
                    const replyAssistantContent =
                      agentRunReplyPayloads.length === 1
                        ? combinedAssistantContent
                        : await buildReplyAssistantContent([finalPayload]);
                    const replyMediaMessage =
                      agentRunReplyPayloads.length === 1
                        ? combinedMediaMessage
                        : await buildReplyMediaMessage([finalPayload]);
                    const replyBroadcastContent = hasAssistantDisplayMediaContent(
                      replyAssistantContent,
                    )
                      ? replyAssistantContent
                      : hasAssistantDisplayMediaContent(replyMediaMessage?.content)
                        ? replyMediaMessage?.content
                        : replyAssistantContent;
                    const persistedContent = replaceAssistantContentTextBlocks(
                      replyAssistantContent,
                      replyMediaMessage ?? null,
                    );
                    const state: SourceReplyContentState = {
                      broadcastContent: replyBroadcastContent ? [...replyBroadcastContent] : [],
                      persistedContent: persistedContent ? [...persistedContent] : [],
                      hasManagedOutgoingContent:
                        hasManagedOutgoingAssistantContent(persistedContent),
                      backedManagedOutgoingContent: false,
                    };
                    sourceReplyContentStates[replyIndex] = state;
                    if (state.broadcastContent.length > 0) {
                      sourceReplyBroadcastContent.push(...state.broadcastContent);
                    }
                  }

                  const displayReply =
                    extractAssistantDisplayTextFromContent(sourceReplyBroadcastContent) ??
                    buildTranscriptReplyText(finalPayloads);
                  if (sourceReplyBroadcastContent.length || displayReply) {
                    const sourceReplyPersistenceRequests: Array<{
                      idempotencyKey: string;
                      metadata: SourceReplyTranscriptMirrorMetadata;
                      state: SourceReplyContentState;
                    }> = [];
                    for (const [
                      replyIndex,
                      sourceReplyPayload,
                    ] of agentRunReplyPayloads.entries()) {
                      const state = sourceReplyContentStates[replyIndex];
                      if (!state || !hasAssistantDisplayMediaContent(state.persistedContent)) {
                        continue;
                      }
                      const mirrorMetadata =
                        getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
                      const mirrorIdempotencyKey = mirrorMetadata?.idempotencyKey;
                      if (
                        typeof mirrorIdempotencyKey !== "string" ||
                        mirrorIdempotencyKey.trim().length === 0
                      ) {
                        continue;
                      }
                      if (!state.hasManagedOutgoingContent) {
                        state.backedManagedOutgoingContent = true;
                      }
                      sourceReplyPersistenceRequests.push({
                        idempotencyKey: mirrorIdempotencyKey,
                        metadata: mirrorMetadata,
                        state,
                      });
                    }
                    const sourceReplyMirrorCandidates: Array<{
                      idempotencyKey: string;
                      metadata: SourceReplyTranscriptMirrorMetadata;
                    }> = [];
                    for (const [
                      replyIndex,
                      sourceReplyPayload,
                    ] of agentRunReplyPayloads.entries()) {
                      if (!sourceReplyContentStates[replyIndex]) {
                        continue;
                      }
                      const mirrorMetadata =
                        getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
                      const mirrorIdempotencyKey = mirrorMetadata?.idempotencyKey;
                      if (
                        typeof mirrorIdempotencyKey !== "string" ||
                        mirrorIdempotencyKey.trim().length === 0 ||
                        !mirrorMetadata
                      ) {
                        continue;
                      }
                      sourceReplyMirrorCandidates.push({
                        idempotencyKey: mirrorIdempotencyKey,
                        metadata: mirrorMetadata,
                      });
                    }

                    const attachSourceReplyManagedImages = async (paramsLocal: {
                      messageId?: string;
                      request: (typeof sourceReplyPersistenceRequests)[number];
                    }) => {
                      if (!paramsLocal.request.state.hasManagedOutgoingContent) {
                        paramsLocal.request.state.backedManagedOutgoingContent = true;
                        return;
                      }
                      if (!paramsLocal.messageId) {
                        return;
                      }
                      await attachManagedOutgoingImagesToMessage({
                        messageId: paramsLocal.messageId,
                        blocks: paramsLocal.request.state.persistedContent,
                      });
                      paramsLocal.request.state.backedManagedOutgoingContent = true;
                    };

                    const sourceReplyScope = assistantTranscriptScope({
                      sessionId,
                      sessionKey,
                      storePath: latestStorePath,
                      agentId,
                    });
                    if (sourceReplyScope && sourceReplyPersistenceRequests.length > 0) {
                      const rewritten = await rewriteSourceReplyTranscriptMirrors({
                        candidates: sourceReplyMirrorCandidates,
                        requests: sourceReplyPersistenceRequests,
                        scope: sourceReplyScope,
                      });
                      if (rewritten.length > 0) {
                        await publishAssistantTranscriptRewrite({
                          scope: sourceReplyScope,
                          rewritten,
                        });
                        for (const target of rewritten) {
                          await attachSourceReplyManagedImages({
                            messageId: target.messageId,
                            request: target.request,
                          });
                        }
                      }
                    }
                    const sourceReplyContent = sourceReplyContentStates
                      .flatMap((state) => {
                        if (
                          state.hasManagedOutgoingContent &&
                          !state.backedManagedOutgoingContent
                        ) {
                          const stripped = stripManagedOutgoingAssistantContentBlocks(
                            state.broadcastContent,
                          );
                          return stripped?.length
                            ? stripped
                            : [{ type: "text", text: "Media reply could not be displayed." }];
                        }
                        return state.broadcastContent;
                      })
                      .filter((block): block is AssistantDisplayContentBlock => Boolean(block));
                    const sourceReplyTextFromContent =
                      extractAssistantDisplayTextFromContent(sourceReplyContent);
                    const sourceReplyText =
                      sourceReplyTextFromContent ??
                      (sourceReplyContent.length === 0 ? displayReply : undefined);
                    const nowLocal = Date.now();
                    const message = {
                      role: "assistant",
                      ...(sourceReplyContent?.length
                        ? { content: sourceReplyContent }
                        : sourceReplyText
                          ? { content: [{ type: "text", text: sourceReplyText }] }
                          : {}),
                      ...(sourceReplyText ? { text: sourceReplyText } : {}),
                      timestamp: nowLocal,
                      stopReason: "stop",
                      usage: { input: 0, output: 0, totalTokens: 0 },
                    };
                    if (hasVisibleAssistantFinalMessage(message)) {
                      emitFirstAssistantServerTiming();
                    }
                    broadcastChatFinal({
                      context,
                      runId: clientRunId,
                      sessionKey,
                      agentId,
                      message,
                    });
                    broadcastedSourceReplyFinal = hasSourceReplyTranscriptMirror;
                  }
                }
              }
              const shouldBroadcastAgentError =
                returnedAgentErrorPayloads.length > 0 && !broadcastedSourceReplyFinal;
              if (shouldBroadcastAgentError) {
                broadcastChatError({
                  context,
                  runId: clientRunId,
                  sessionKey,
                  agentId,
                  errorMessage: returnedAgentErrorMessage,
                });
              }
              if (!context.chatAbortedRuns.has(clientRunId)) {
                const returnedAgentError = shouldBroadcastAgentError
                  ? errorShape(
                      ErrorCodes.UNAVAILABLE,
                      returnedAgentErrorMessage ?? "agent returned an error payload",
                    )
                  : undefined;
                setGatewayDedupeEntry({
                  dedupe: context.dedupe,
                  key: `chat:${clientRunId}`,
                  entry: {
                    ts: Date.now(),
                    ok: !shouldBroadcastAgentError,
                    payload: shouldBroadcastAgentError
                      ? {
                          runId: clientRunId,
                          status: "error" as const,
                          summary: returnedAgentErrorMessage ?? "agent returned an error payload",
                        }
                      : { runId: clientRunId, status: "ok" as const },
                    ...(returnedAgentError ? { error: returnedAgentError } : {}),
                  },
                });
              }
            },
            {
              phase: "agent-turn",
              config: cfg,
              attributes: chatSendTraceAttributes,
            },
          );
          emitServerTiming(
            "post-dispatch-completed",
            {
              postDispatchMs: roundedChatSendTimingMs(performance.now() - postDispatchStartedAtMs),
            },
            dispatchStartedAtMs,
          );
          if (queuedFollowupEnqueued && !context.chatAbortedRuns.has(clientRunId)) {
            // Successful queue admission ends this client run. The later
            // aggregate/followup owns its own run id.
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey,
              agentId,
            });
          }
        })
        .catch(async (err: unknown) => {
          const errorMessage = String(err);
          // Select terminal ownership before any awaited durable-state work. An
          // explicit abort has both the signal and marker; restart interruption
          // only aborts the signal and must still follow dispatch-error handling.
          const abortedAtDispatchReject = activeRunAbort.controller.signal.aborted;
          const abortMarkerAtDispatchReject = context.chatAbortedRuns.get(clientRunId);
          const abortStopReasonAtDispatchReject = activeRunAbort.entry?.abortStopReason ?? "rpc";
          const persistAbortTranscript = async () => {
            if (userTurnRecorder.hasPersisted() || userTurnRecorder.isBlocked()) {
              return;
            }
            await persistGatewayUserTurnTranscript().catch((transcriptErr: unknown) => {
              context.logGateway.warn(
                `webchat user transcript update failed after abort: ${formatForLog(transcriptErr)}`,
              );
            });
          };
          if (queuedFollowupEnqueued) {
            context.logGateway.warn(
              `webchat dispatch failed after followup queue admission: ${formatForLog(err)}`,
            );
            if (!context.chatAbortedRuns.has(clientRunId)) {
              setGatewayDedupeEntry({
                dedupe: context.dedupe,
                key: `chat:${clientRunId}`,
                entry: {
                  ts: Date.now(),
                  ok: true,
                  payload: { runId: clientRunId, status: "ok" as const },
                },
              });
              broadcastChatFinal({
                context,
                runId: clientRunId,
                sessionKey,
                agentId,
              });
            }
            return;
          }
          if (abortedAtDispatchReject && abortMarkerAtDispatchReject !== undefined) {
            if (restartSafeAdmission) {
              await terminalizeRestartSafeAdmission({
                retryable: false,
                status: "killed",
              }).catch((terminalizeError: unknown) => {
                context.logGateway.warn(
                  `failed to terminalize restart-safe chat admission after abort: ${formatForLog(
                    terminalizeError,
                  )}`,
                );
                return false;
              });
            }
            const endedAt = chatAbortMarkerTimestampMs(abortMarkerAtDispatchReject);
            const payload = buildAbortedChatSendPayload({
              runId: clientRunId,
              stopReason: abortStopReasonAtDispatchReject,
              endedAt,
            });
            context.logGateway.warn(
              `chat.send post-dispatch threw after abort for runId=${clientRunId}: ${formatForLog(err)}`,
            );
            setGatewayDedupeEntry({
              dedupe: context.dedupe,
              key: `chat:${clientRunId}`,
              entry: {
                ts: endedAt,
                ok: true,
                payload,
              },
            });
            cleanupAdmittedRun({ force: true });
            clearAgentRunContext(clientRunId, lifecycleGeneration);
            await persistAbortTranscript();
            return;
          }

          // Dispatch rejection owns every remaining path. Retire abortability
          // synchronously before durable terminalization can suspend, so a late
          // chat.abort cannot publish or cache a contradictory terminal state.
          context.chatAbortedRuns.delete(clientRunId);
          activeRunAbort.cleanup({ force: true });

          let restartSafeDispatchFailureTerminalized = false;
          if (restartSafeAdmission) {
            restartSafeDispatchFailureTerminalized = await terminalizeRestartSafeAdmission({
              retryable: true,
              status: "failed",
            }).catch((terminalizeError: unknown) => {
              context.logGateway.warn(
                `failed to release restart-safe chat admission after dispatch error: ${formatForLog(
                  terminalizeError,
                )}`,
              );
              return false;
            });
            if (restartSafeDispatchFailureTerminalized) {
              emitSessionsChanged(context, {
                sessionKey,
                ...(agentId ? { agentId } : {}),
                reason: "chat.dispatch-error",
              });
            }
          }
          persistDispatchErrorUserTurn =
            userTurnRecorder.hasPersisted() || userTurnRecorder.isBlocked()
              ? undefined
              : async () => {
                  await persistGatewayUserTurnTranscript();
                };
          if (
            !restartSafeDispatchFailureTerminalized &&
            abortMarkerAtDispatchReject === undefined
          ) {
            pendingDispatchLifecycleError = {
              endedAt: Date.now(),
              error: errorMessage,
              sessionId: activeRunAbort.entry?.sessionId ?? backingSessionId ?? clientRunId,
              startedAt: activeRunAbort.entry?.startedAtMs ?? now,
            };
          }
          const error = errorShape(ErrorCodes.UNAVAILABLE, errorMessage);
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: false,
              payload: {
                runId: clientRunId,
                status: "error" as const,
                summary: errorMessage,
              },
              error,
            },
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey,
            agentId,
            errorMessage,
          });
        })
        .finally(() => {
          const dispatchError = pendingDispatchLifecycleError;
          // Reserve error projection before cleanup retires the dispatch root. Restart
          // drain may already reject fresh roots, but this accepted request must finish.
          const releaseDispatchErrorRoot = dispatchError
            ? retainGatewayRootWorkAdmissionContinuation()
            : null;
          cleanupAdmittedRun();
          clearAgentRunContext(clientRunId, lifecycleGeneration);
          context.removeChatRun(clientRunId, clientRunId, sessionKey);
          if (!dispatchError) {
            return;
          }
          const persistDispatchLifecycleError = async () => {
            const hasActiveRun = hasTrackedActiveSessionRun({
              context,
              requestedKey: rawSessionKey,
              canonicalKey: sessionKey,
              ...(sessionKey === "global" && agentId ? { agentId } : {}),
              defaultAgentId: resolveDefaultAgentId(cfg),
            });
            if (hasActiveRun) {
              return;
            }
            try {
              await persistGatewaySessionLifecycleEvent({
                sessionKey,
                ...(sessionKey === "global" && agentId ? { agentId } : {}),
                event: {
                  runId: clientRunId,
                  sessionId: dispatchError.sessionId,
                  lifecycleGeneration,
                  ts: dispatchError.endedAt,
                  data: {
                    phase: "error",
                    startedAt: dispatchError.startedAt,
                    endedAt: dispatchError.endedAt,
                    error: dispatchError.error,
                  },
                },
              });
              emitSessionsChanged(context, {
                sessionKey,
                ...(agentId ? { agentId } : {}),
                reason: "chat.dispatch-error",
              });
            } catch (persistErr: unknown) {
              context.logGateway.warn(
                `webchat session lifecycle persist failed after error: ${formatForLog(persistErr)}`,
              );
            }
          };
          void (async () => {
            await persistDispatchLifecycleError();
            await persistDispatchErrorUserTurn?.().catch((transcriptErr: unknown) => {
              context.logGateway.warn(
                `webchat user transcript update failed after error: ${formatForLog(transcriptErr)}`,
              );
            });
          })()
            .catch((continuationErr: unknown) => {
              context.logGateway.warn(
                `webchat session lifecycle continuation failed: ${formatForLog(continuationErr)}`,
              );
            })
            .finally(() => releaseDispatchErrorRoot?.());
        });
    } catch (err) {
      if (restartSafeAdmission) {
        const terminalized = await terminalizeRestartSafeAdmission({
          retryable: true,
          status: "failed",
        }).catch((terminalizeError: unknown) => {
          context.logGateway.warn(
            `failed to release restart-safe chat admission after setup error: ${formatForLog(
              terminalizeError,
            )}`,
          );
          return false;
        });
        if (terminalized) {
          emitSessionsChanged(context, {
            sessionKey,
            ...(agentId ? { agentId } : {}),
            reason: "chat.dispatch-error",
          });
        }
      }
      cleanupAdmittedRun({ force: true });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      context.removeChatRun(clientRunId, clientRunId, sessionKey);
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        },
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
      broadcastChatError({
        context,
        runId: clientRunId,
        sessionKey,
        agentId,
        errorMessage: String(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      agentId?: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: rawSessionKey,
      agentId: p.agentId,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const {
      cfg,
      storePath,
      entry,
      canonicalKey: sessionKey,
    } = loadSessionEntry(rawSessionKey, sessionLoadOptions);
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: rawSessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }
    const agentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      agentId: selectedAgent.agentId,
    });

    let appended: Awaited<ReturnType<typeof appendAssistantTranscriptMessage>>;
    try {
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {
          const latestEntry = loadSessionEntry(rawSessionKey, sessionLoadOptions).entry;
          if (!latestEntry) {
            throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
          }
          if (latestEntry.sessionId !== sessionId) {
            throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
          }
          const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry);
          if (archivedError) {
            throw new Error(archivedError);
          }
        },
      });
      try {
        appended = await admission.run(
          async () =>
            await appendAssistantTranscriptMessage({
              sessionKey,
              message: p.message,
              label: p.label,
              sessionId,
              storePath,
              sessionFile: entry.sessionFile,
              agentId,
              createIfMissing: true,
              cfg,
            }),
        );
      } finally {
        admission.release();
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return;
    }
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const message = projectChatDisplayMessage(appended.message, {
      maxChars: resolveEffectiveChatHistoryMaxChars(cfg),
    });
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey,
      ...(sessionKey === "global" && agentId ? { agentId } : {}),
      seq: 0,
      state: "final" as const,
      message,
    };
    context.broadcast("chat", chatPayload);
    sendGlobalAwareNodeChatPayload({
      context,
      sessionKey,
      agentId,
      event: "chat",
      payload: chatPayload,
    });

    respond(true, { ok: true, messageId: appended.messageId });
  },
};
