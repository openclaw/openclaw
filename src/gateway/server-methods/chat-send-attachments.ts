import { performance } from "node:perf_hooks";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { readPersistedMediaFacts, type MediaFact } from "../../media/media-facts.js";
import { retainsUserTurnTranscriptMedia } from "../../sessions/user-turn-transcript-media.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { DEVICE_FOLDER_ATTACHMENTS_UNSUPPORTED } from "../../worker/node-workspace-protocol.js";
import { resolveChatAttachmentMaxBytes } from "../chat-attachment-policy.js";
import {
  discardPreparedInboundMedia,
  MediaOffloadError,
  type OffloadedRef,
  logAttachmentFailure,
  parseMessageWithAttachments,
  stripImageMediaMarkers,
} from "../chat-attachments.js";
import { readQueuedChatInputAdmission } from "../queued-chat-input-admission.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveGatewayModelSupportsImages } from "../session-utils.js";
import { resolveExplicitOriginBindingTargets } from "./chat-origin-routing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { roundedChatSendTimingMs } from "./chat-server-timing.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Validate and durably offload attachments before input custody and ACK. */
export async function prepareChatSendAttachments(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  admission: AdmittedChatSend;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
}) {
  const { request, session, admission, respond, context } = params;
  const { inboundMessage, normalizedAttachments, explicitOrigin } = request;
  const { cfg, agentId, resolvedSessionModel, clientRunId } = session;
  const {
    activeRunAbort,
    chatSendTraceAttributes,
    cleanupAdmittedRun,
    finishAbortedChatSend,
    lifecycleGeneration,
  } = admission;
  const assertInputCurrent = () => {
    activeRunAbort.controller.signal.throwIfAborted();
    admission.assertWorkAdmissionCurrent();
    admission.assertClientUploadAllowed?.();
  };
  let parsedMessage = inboundMessage;
  let parsedImages: Awaited<ReturnType<typeof parseMessageWithAttachments>>["images"] = [];
  let imageOrder: Awaited<ReturnType<typeof parseMessageWithAttachments>>["imageOrder"] = [];
  let offloadedRefs: OffloadedRef[] = [];
  let mediaPathOffloads: MediaFact[] = [];
  let explicitOriginTargetsPlugin = false;
  let prepareAttachmentsMs: number | undefined;

  try {
    const explicitOriginTargets = await resolveExplicitOriginBindingTargets(explicitOrigin);
    assertInputCurrent();
    explicitOriginTargetsPlugin = explicitOriginTargets.plugin;
    const recoveredInput = readQueuedChatInputAdmission(clientRunId);
    if (recoveredInput) {
      // Accepted media retains its managed sources; the normal prompt owner hydrates them.
      mediaPathOffloads = readPersistedMediaFacts(recoveredInput.target.message) ?? [];
    }

    if (normalizedAttachments.length > 0) {
      // Refuse before parsing or persistence; device folders cannot receive staged files.
      if (
        (admission.initialSessionEntry ?? admission.admittedSessionEntry ?? session.entry)
          ?.deviceFolder
      ) {
        throw new Error(DEVICE_FOLDER_ATTACHMENTS_UNSUPPORTED);
      }
      const prepareAttachmentsStartedAtMs = performance.now();
      await measureDiagnosticsTimelineSpan(
        "gateway.chat_send.prepare_attachments",
        async () => {
          const imageSupport: { value: boolean | undefined } = {
            value: explicitOriginTargets.acp || explicitOriginTargetsPlugin ? true : undefined,
          };
          const resolveSupportsImages = async (): Promise<boolean> => {
            imageSupport.value ??= await resolveGatewayModelSupportsImages({
              loadGatewayModelCatalog: context.loadGatewayModelCatalog,
              loadGatewayModelCatalogSnapshot: context.loadGatewayModelCatalogSnapshot,
              agentId,
              provider: resolvedSessionModel.provider,
              model: resolvedSessionModel.model,
            });
            return imageSupport.value;
          };
          const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
            maxBytes: resolveChatAttachmentMaxBytes(cfg),
            log: context.logGateway,
            supportsImages: imageSupport.value ?? resolveSupportsImages,
            acceptNonImage: true,
            signal: activeRunAbort.controller.signal,
            assertCurrent: assertInputCurrent,
          });
          // The parser owns MIME classification. An unresolved capability means no image was seen,
          // so post-processing must not trigger catalog discovery for a non-image attachment.
          const parsedSupportsImages = imageSupport.value !== false;
          parsedMessage = parsedSupportsImages
            ? parsed.message
            : stripImageMediaMarkers(parsed.message, parsed.offloadedRefs);
          parsedImages = parsed.images;
          imageOrder = parsed.imageOrder;
          offloadedRefs = parsed.offloadedRefs;
          // The accepted input keeps durable originals. The turn's media preparation
          // owns the final workspace, cancellation, and visible staging failures.
          mediaPathOffloads = offloadedRefs
            .filter((ref) => !parsedSupportsImages || !ref.mimeType.startsWith("image/"))
            .map((ref) => ({
              path: ref.path,
              url: ref.mediaRef,
              contentType: ref.mimeType,
              fileName: ref.label,
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
      assertInputCurrent();
      // Offloaded media still needs awaited cleanup when preparation was cancelled.
      activeRunAbort.controller.signal.throwIfAborted();
      prepareAttachmentsMs = roundedChatSendTimingMs(
        performance.now() - prepareAttachmentsStartedAtMs,
      );
    }
  } catch (err) {
    const aborted =
      activeRunAbort.controller.signal.aborted &&
      (context.chatRunState.hasAbortMarker(clientRunId) ||
        Object.is(err, activeRunAbort.controller.signal.reason));
    // Retire failed-run cancellation before cleanup yields, but retain work
    // admission until deletion finishes so a late abort cannot replace the error.
    if (!aborted) {
      activeRunAbort.cleanup();
    }
    await discardPreparedInboundMedia(offloadedRefs);
    if (aborted) {
      finishAbortedChatSend();
      return { ok: false as const };
    }
    cleanupAdmittedRun();
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    logAttachmentFailure(context.logGateway, "chat.send attachment offload failed", err);
    respond(
      false,
      undefined,
      err instanceof SessionMutationAuthorizationChangedError
        ? err.error
        : errorShape(
            err instanceof MediaOffloadError ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
            String(err),
          ),
    );
    return { ok: false as const };
  }
  return {
    ok: true as const,
    value: {
      explicitOriginTargetsPlugin,
      imageOrder,
      mediaPathOffloads,
      offloadedRefs,
      parsedImages,
      parsedMessage,
      prepareAttachmentsMs,
    },
  };
}

export type PreparedChatSendAttachments = Extract<
  Awaited<ReturnType<typeof prepareChatSendAttachments>>,
  { ok: true }
>["value"];

/** Preparation owns cleanup until a transcript or pending input takes custody of its media. */
export function bindChatSendPreparedMediaCustody(params: {
  admission: Pick<AdmittedChatSend, "setDiscardAbandonedPreparedMedia">;
  attachments: Pick<PreparedChatSendAttachments, "offloadedRefs">;
}): (recorder: UserTurnTranscriptRecorder) => void {
  let recorder: UserTurnTranscriptRecorder | undefined;
  // Dispatch owns persistence after the ACK disarms this cleanup.
  params.admission.setDiscardAbandonedPreparedMedia(() => {
    if (!recorder || !retainsUserTurnTranscriptMedia(recorder)) {
      void discardPreparedInboundMedia(params.attachments.offloadedRefs);
    }
  });
  return (inputRecorder) => {
    recorder = inputRecorder;
  };
}
