import path from "node:path";
import { performance } from "node:perf_hooks";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { StageSandboxMediaResult } from "../../auto-reply/reply/stage-sandbox-media.js";
import type { MsgContext, TemplateContext } from "../../auto-reply/templating.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPersistedMediaFacts, type MediaFact } from "../../media/media-facts.js";
import { parseInboundMediaUri } from "../../media/media-reference.js";
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
  UnsupportedAttachmentError,
} from "../chat-attachments.js";
import { readChatInputRecoveryAdmission } from "../chat-input-recovery-source.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveGatewayModelSupportsImages } from "../session-utils.js";
import { prepareSkillLibrarySessionCreation } from "../skill-library-session.js";
import { resolveExplicitOriginBindingTargets } from "./chat-origin-routing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { roundedChatSendTimingMs } from "./chat-server-timing.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// Managed inbound PDFs can be read host-side from the media-store root, even
// for locked-down agents, so sandbox staging may safely fall back to that path.
function isManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  const mime = ref.mimeType.trim().toLowerCase();
  if (
    mime !== "application/pdf" &&
    !mime.endsWith("+pdf") &&
    path.extname(ref.path.split(/[?#]/u)[0] ?? "").toLowerCase() !== ".pdf"
  ) {
    return false;
  }
  try {
    return parseInboundMediaUri(ref.mediaRef) !== null;
  } catch {
    return false;
  }
}

/** Parse and pre-stage attachments before the caller's synchronous pre-ACK checks. */
export async function prepareChatSendAttachments(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  admission: AdmittedChatSend;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
  client?: GatewayRequestHandlerOptions["client"];
}) {
  const { request, session, admission, respond, context, client } = params;
  const { inboundMessage, normalizedAttachments, explicitOrigin } = request;
  const { cfg, sessionKey, agentId, resolvedSessionModel, clientRunId } = session;
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
    const recoveredInput = readChatInputRecoveryAdmission(clientRunId);
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
          const stagingEntry =
            admission.initialSessionEntry ?? admission.admittedSessionEntry ?? session.entry;
          const selectedSkills = stagingEntry
            ? (stagingEntry.skillLibrarySelections ??
              stagingEntry.skillsSnapshot?.librarySelections)
            : request.systemInputProvenance
              ? undefined
              : (
                  await prepareSkillLibrarySessionCreation(
                    client,
                    context.getRuntimeConfig ?? cfg,
                    resolveOperatorSessionCreation(client),
                  )
                ).skillLibrarySelections;
          const requestedWorkspaceDir = resolveIngressWorkspaceOverrideForSessionRun({
            spawnedBy: stagingEntry?.spawnedBy,
            workspaceDir: stagingEntry?.spawnedWorkspaceDir,
            cwd: stagingEntry?.spawnedCwd,
          });
          const existingSkillsSnapshot = stagingEntry?.skillsSnapshot;
          const abortSignal = activeRunAbort.controller.signal;
          // Stage media before ACK so permanent client errors stay 4xx and retryable
          // staging failures stay 5xx. Managed PDFs retain their host-readable fallback.
          const prestageMediaPathOffloads = async (): Promise<MediaFact[]> => {
            const mediaPathRefs = offloadedRefs.filter(
              (ref) => !parsedSupportsImages || !ref.mimeType.startsWith("image/"),
            );
            if (mediaPathRefs.length === 0) {
              return [];
            }
            try {
              const [
                { ensureSandboxWorkspaceForSession },
                { SANDBOX_MEDIA_MAX_BYTES, stageSandboxMedia },
              ] = await Promise.all([
                import("../../agents/sandbox/context.js"),
                import("../../auto-reply/reply/stage-sandbox-media.js"),
              ]);
              abortSignal.throwIfAborted();
              assertInputCurrent();
              const refsByManagedPath = (refs: OffloadedRef[]): MediaFact[] =>
                refs.map((ref) => ({
                  path: ref.path,
                  contentType: ref.mimeType,
                  fileName: ref.label,
                  workspaceDir: path.dirname(ref.path),
                }));
              // Host-readable managed PDFs above the staging cap do not need a sandbox copy.
              const refsToStage = mediaPathRefs.filter(
                (ref) =>
                  !(ref.sizeBytes > SANDBOX_MEDIA_MAX_BYTES && isManagedInboundPdfOffloadRef(ref)),
              );
              if (refsToStage.length === 0) {
                return refsByManagedPath(mediaPathRefs);
              }

              const configuredWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
              const workspaceDir = requestedWorkspaceDir ?? configuredWorkspaceDir;
              if (
                getAgentWorkspaceAccess(workspaceDir, "prepareTurnAttachments")
                  ?.prepareTurnAttachments
              ) {
                return refsByManagedPath(mediaPathRefs);
              }
              const skillsSnapshot = selectedSkills?.length
                ? (
                    await (
                      await import("../../skills/runtime/session-snapshot.js")
                    ).resolveReusableWorkspaceSkillSnapshot({
                      workspaceDir: configuredWorkspaceDir,
                      config: cfg,
                      agentId,
                      existingSnapshot: existingSkillsSnapshot,
                      librarySelections: selectedSkills,
                      assertCurrent: assertInputCurrent,
                    })
                  ).snapshot
                : undefined;
              abortSignal.throwIfAborted();
              assertInputCurrent();
              const sandbox = await ensureSandboxWorkspaceForSession({
                config: cfg,
                agentId,
                sessionKey,
                workspaceDir,
                skillsSnapshot,
              });
              assertInputCurrent();
              if (!sandbox) {
                return refsByManagedPath(mediaPathRefs);
              }

              const stagingCtx: MsgContext = {
                media: refsToStage.map((ref) => ({ path: ref.path, contentType: ref.mimeType })),
              };
              let stageResult: StageSandboxMediaResult;
              try {
                stageResult = await stageSandboxMedia({
                  ctx: stagingCtx,
                  sessionCtx: stagingCtx as TemplateContext,
                  cfg,
                  agentId,
                  sessionKey,
                  workspaceDir,
                  skillsSnapshot,
                  abortSignal,
                });
              } catch (stageErr) {
                // Cancellation is terminal; only ordinary managed-PDF failures can use
                // the host-readable fallback. Other files must fail before ACK.
                if (
                  (abortSignal.aborted && Object.is(stageErr, abortSignal.reason)) ||
                  refsToStage.some((ref) => !isManagedInboundPdfOffloadRef(ref))
                ) {
                  throw stageErr;
                }
                return refsByManagedPath(mediaPathRefs);
              }

              // stageSandboxMedia preserves an absolute source path when no copy lands;
              // the staged map is the authoritative success signal.
              const stagedSources = stageResult.staged;
              const missing = refsToStage.filter((_ref, index) => !stagedSources.has(index));
              const unstageable = missing.filter((ref) => !isManagedInboundPdfOffloadRef(ref));
              if (unstageable.length > 0) {
                throw new Error(
                  `attachment staging incomplete: ${stagedSources.size}/${refsToStage.length} paths staged into sandbox workspace (missing: ${unstageable.map((ref) => ref.path).join(", ")})`,
                );
              }
              const stagedMedia = stagingCtx.media ?? [];
              // Preserve request order while mixing sandbox-relative paths with managed
              // host paths used by pass-through or fallback PDFs.
              const resolvedByRef = new Map(
                refsToStage.map((ref, index) => [ref, stagedMedia[index]] as const),
              );
              return mediaPathRefs.map((ref) => {
                const resolved = resolvedByRef.get(ref);
                return {
                  path: resolved?.path ?? ref.path,
                  url: ref.mediaRef,
                  contentType: resolved?.contentType ?? ref.mimeType,
                  fileName: ref.label,
                  workspaceDir: sandbox.workspaceDir,
                };
              });
            } catch (err) {
              if (
                (abortSignal.aborted && Object.is(err, abortSignal.reason)) ||
                err instanceof SessionMutationAuthorizationChangedError ||
                err instanceof MediaOffloadError ||
                err instanceof UnsupportedAttachmentError
              ) {
                throw err;
              }
              throw new MediaOffloadError(
                `[Gateway Error] Failed to stage attachments into agent workspace: ${formatErrorMessage(err)}`,
                { cause: err },
              );
            }
          };
          mediaPathOffloads = await prestageMediaPathOffloads();
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
      // Pass-through media still needs awaited cleanup when preparation was cancelled.
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
    logAttachmentFailure(context.logGateway, "chat.send attachment parse/stage failed", err);
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
