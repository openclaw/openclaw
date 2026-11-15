import { getRuntimeConfig } from "../../config/config.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { sessionMatchesExpectedTranscriptTurn } from "../../config/sessions/session-transcript-turn-state.js";
import {
  captureSessionTranscriptStorageEnvironment,
  sameSessionTranscriptStorageEnvironment,
  type SessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { readLocalFileSafely } from "../../infra/fs-safe.js";
import { stageQueuePayloadMedia } from "../../infra/outbound/delivery-queue-media-spool.js";
import { cancelDeliveryQueueMediaRetention } from "../../infra/outbound/delivery-queue-media-staging.js";
import {
  enqueueClaimedSessionDelivery,
  loadPendingSessionDelivery,
  setSessionDeliveryMediaReview,
  sessionDeliveryRequesterMatchesConfiguredStore,
} from "../../infra/session-delivery-queue-storage.js";
import type {
  QueuedSessionDelivery,
  SessionDeliveryCandidateMedia,
  SessionDeliveryRequesterBinding,
} from "../../infra/session-delivery-queue.records.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { RequiredCompletionTerminalResult } from "../completion-result.js";
import {
  mediaUrlsFromGeneratedAttachments,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "../internal-events.js";
import {
  findMediaGenerationOperation,
  registerMediaGenerationOutputRetainer,
  type MediaGenerationOperation,
} from "../media-generation-activity.js";
import { deliverSubagentAnnouncement } from "../subagents/announce/subagent-announce-delivery.js";
import { resolveGeneratedMediaSessionDeliveryRoute } from "../subagents/announce/subagent-announce-origin.js";
import { MAX_IMAGE_INPUT_BYTES } from "../tool-images.js";

const log = createSubsystemLogger("agents/tools/media-generate-background-completion");

export type MediaGenerationTaskHandle = {
  taskId: string;
  runId: string;
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  detach: boolean;
  deliveryMode?: "review";
  /** Original physical queue owner retained when accepted generation outlives its requester. */
  deliveryQueueContext?: OpenClawStateWorkerContext;
  /** Data-only reference to the original owner's decision; never live execution authority. */
  acceptedOperation: Pick<MediaGenerationOperation, "superseded">;
  requesterTranscript?: SessionTranscriptTargetBinding & { lifecycleRevision: string | null };
  /** Settles when the requester work active at tool-call time, i.e. the originating turn, ends. */
  requesterSettlement?: Promise<void>;
  resolveGatewayContext?: GatewayContextResolver;
  taskLabel: string;
};

export function hasMediaGenerationCustodyObligation(handle: MediaGenerationTaskHandle): boolean {
  return handle.deliveryMode === "review" || handle.acceptedOperation.superseded === true;
}

function isMediaGenerationSourceCurrent(handle: MediaGenerationTaskHandle): boolean {
  const target = handle.requesterTranscript;
  const operation = findMediaGenerationOperation(handle.runId);
  return Boolean(
    target &&
    operation &&
    operation.endedAt === undefined &&
    sameSessionTranscriptStorageEnvironment(
      target.env,
      captureSessionTranscriptStorageEnvironment(process.env),
    ),
  );
}

/** Delivery and sandbox writes must belong to the same admitted conversation. */
export async function readCurrentMediaGenerationRequester(handle: MediaGenerationTaskHandle) {
  const target = handle.requesterTranscript;
  if (
    !target ||
    !isMediaGenerationSourceCurrent(handle) ||
    !sessionDeliveryRequesterMatchesConfiguredStore(target, target.env ?? process.env)
  ) {
    return undefined;
  }
  const entry = await withSessionEntryReadOnlyInWorker(
    { ...target, hydrateSkillPromptRefs: false },
    () => {
      if (!isMediaGenerationSourceCurrent(handle)) {
        throw new Error("Media completion source is no longer current");
      }
    },
    async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      return sessionMatchesExpectedTranscriptTurn(read.value ? { entry: read.value } : undefined, {
        expectedSessionId: target.sessionId,
        expectedLifecycleRevision: target.lifecycleRevision,
      })
        ? read.value
        : undefined;
    },
  );
  return isMediaGenerationSourceCurrent(handle) ? entry : undefined;
}

/** Preserve an undelivered result in its original conversation without resending it. */
export async function retainBlockedMediaCompletion(params: {
  handle: MediaGenerationTaskHandle | null;
  terminalResult: RequiredCompletionTerminalResult | undefined;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
}): Promise<void> {
  const handle = params.handle;
  const target = handle?.requesterTranscript;
  if (
    !handle ||
    !target ||
    params.terminalResult?.terminalOutcome !== "blocked" ||
    hasMediaGenerationCustodyObligation(handle)
  ) {
    return;
  }
  const assertCurrent = () => {
    if (!isMediaGenerationSourceCurrent(handle)) {
      throw new Error("Media generation owner is no longer current");
    }
  };
  assertCurrent();
  const result = await appendAssistantMessageToSessionTranscript({
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    expectedSessionId: target.sessionId,
    expectedLifecycleRevision: target.lifecycleRevision,
    idempotencyKey: `media-completion-retained:${handle.runId}`,
    assertCurrent,
    text: "Generated media is ready, but completion delivery was not confirmed. The saved media is retained here.",
    mediaUrls: Array.from(
      new Set([
        ...(params.mediaUrls ?? []),
        ...mediaUrlsFromGeneratedAttachments(params.attachments),
      ]),
    ),
  });
  if (!result.ok) {
    throw new Error(`Could not retain generated media in the original session: ${result.reason}`);
  }
}

export function mediaGenerationCompletionDeliveryKey(toolName: string, taskId: string): string {
  return `${toolName}:${taskId}:ok:agent-loop`;
}

/** Prepare durable bytes before the queue arbitrates supersession against send admission. */
export async function supersedeMediaGenerationCandidate(
  entry: QueuedSessionDelivery,
  taskId: string,
  context: OpenClawStateWorkerContext,
) {
  const deliveryContext = {
    stateDir: context.environment.OPENCLAW_STATE_DIR,
    workerContext: context,
  };
  let media: SessionDeliveryCandidateMedia | undefined;
  let stageId: string | undefined;
  if (entry.kind === "agentTurn" && !entry.reviewedTaskId) {
    const originalUrls = entry.expectedMediaUrls ?? [];
    const staged = await stageQueuePayloadMedia(
      {
        payloads: [{ mediaUrls: originalUrls }],
        maxBytes: resolveGeneratedMediaMaxBytes(getRuntimeConfig(), "image"),
        artifactFormat: "media-candidate-v1",
      },
      deliveryContext,
    );
    if (staged.status !== "staged") {
      throw new Error("Superseded generated media could not acquire durable custody");
    }
    const urls = staged.payloads.flatMap((payload) => payload.mediaUrls ?? []);
    media = {
      expectedMediaUrls: urls,
      expectedMediaAttachments: Object.fromEntries(
        urls.map((url, index) => [
          url,
          entry.expectedMediaAttachments?.[originalUrls[index] ?? ""] ?? {},
        ]),
      ),
    };
    stageId = staged.mediaStageId;
  }
  const status = await setSessionDeliveryMediaReview(entry, taskId, "superseded", context, media);
  await cancelDeliveryQueueMediaRetention(stageId, undefined, deliveryContext).catch(
    (error: unknown) => {
      log.warn("Supersession media-stage cleanup remains pending", { taskId, error });
    },
  );
  return status;
}

export type MediaGenerationCompletionWakeOutcome =
  | { status: "delivered" }
  | { status: "queued" }
  | { status: "pending" }
  | { status: "permanent_failure" };

type MediaGenerationCompletionParams = {
  handle: MediaGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  eventSource: AgentInternalEvent["source"];
  announceType: string;
  toolName: string;
  completionLabel: string;
};

type MediaGenerationCandidateRetention = {
  mediaUrls: string[];
  candidateId?: string;
  outcome?: MediaGenerationCompletionWakeOutcome;
};

async function retainMediaGenerationCandidate(
  params: MediaGenerationCompletionParams,
): Promise<MediaGenerationCandidateRetention> {
  const handle = params.handle;
  const queueContext = handle?.deliveryQueueContext;
  if (!handle || !queueContext || !handle.requesterTranscript) {
    return { mediaUrls: [], outcome: { status: "permanent_failure" } };
  }
  let mediaUrls = Array.from(
    new Set([
      ...(params.mediaUrls ?? []),
      ...mediaUrlsFromGeneratedAttachments(params.attachments),
    ]),
  );
  let candidateId: string | undefined;
  const target = handle.requesterTranscript;
  const route = resolveGeneratedMediaSessionDeliveryRoute({
    sessionKey: target.sessionKey,
    requesterSessionOrigin: handle.requesterOrigin,
    completionDirectOrigin: handle.requesterOrigin,
  });
  const existing = await loadPendingSessionDelivery(
    sha256Hex(mediaGenerationCompletionDeliveryKey(params.toolName, handle.taskId)),
    queueContext,
  );
  if (existing) {
    candidateId = existing.id;
    if (existing.kind !== "systemEvent") {
      mediaUrls = existing.expectedMediaUrls ?? [];
    }
  } else {
    const deliveryContext = {
      stateDir: queueContext.environment.OPENCLAW_STATE_DIR,
      workerContext: queueContext,
    };
    const staged = await stageQueuePayloadMedia(
      {
        payloads: [{ mediaUrls }],
        maxBytes: resolveGeneratedMediaMaxBytes(getRuntimeConfig(), "image"),
        artifactFormat: "media-candidate-v1",
      },
      deliveryContext,
    );
    if (staged.status !== "staged") {
      throw new Error("Generated review candidate could not acquire durable media custody");
    }
    mediaUrls = staged.payloads.flatMap((payload) => payload.mediaUrls ?? []);
    const queued = await enqueueClaimedSessionDelivery(
      {
        kind: "mediaCandidate",
        sessionKey: target.sessionKey,
        messageId: mediaGenerationCompletionDeliveryKey(params.toolName, handle.taskId),
        idempotencyKey: mediaGenerationCompletionDeliveryKey(params.toolName, handle.taskId),
        requesterBinding: {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
          sessionId: target.sessionId,
          lifecycleRevision: target.lifecycleRevision,
        },
        ...route,
        inputProvenance: {
          kind: "inter_session",
          sourceTool: params.toolName,
          sourceSessionKey: `${params.toolName}:${handle.taskId}`,
          sourceChannel: "internal",
        },
        sourceReplyDeliveryMode: "automatic",
        expectedMediaUrls: mediaUrls,
        expectedMediaAttachments: Object.fromEntries(
          mediaUrls.map((url, index) => [url, params.attachments?.[index] ?? {}]),
        ),
        taskId: handle.taskId,
        inspectionContext: params.result,
        disposition: handle.acceptedOperation.superseded ? "superseded" : "review_pending",
      },
      0,
      queueContext,
    );
    if (queued.status !== "pending") {
      return {
        mediaUrls,
        outcome: { status: queued.status === "completed" ? "delivered" : "permanent_failure" },
      };
    }
    candidateId = queued.id;
    await cancelDeliveryQueueMediaRetention(staged.mediaStageId, undefined, deliveryContext).catch(
      (error: unknown) => {
        log.warn("Candidate media-stage cleanup remains pending", { taskId: handle.taskId, error });
      },
    );
  }
  if (handle.acceptedOperation.superseded) {
    const candidate = await loadPendingSessionDelivery(candidateId, queueContext);
    if (candidate) {
      await supersedeMediaGenerationCandidate(candidate, handle.taskId, queueContext);
    }
  }
  return { mediaUrls, candidateId };
}

export async function wakeMediaGenerationTaskCompletion(
  params: MediaGenerationCompletionParams,
): Promise<MediaGenerationCompletionWakeOutcome> {
  const handle = params.handle;
  const supersededAtStart = handle?.acceptedOperation.superseded === true;
  let retained: Promise<MediaGenerationCandidateRetention> | undefined;
  const retain = () => (retained ??= retainMediaGenerationCandidate(params));
  const unregister =
    handle &&
    params.status === "ok" &&
    ((params.mediaUrls?.length ?? 0) > 0 || (params.attachments?.length ?? 0) > 0) &&
    handle.requesterTranscript &&
    handle.deliveryQueueContext
      ? registerMediaGenerationOutputRetainer(handle.runId, handle.acceptedOperation, async () => {
          await retain();
        })
      : () => {};
  const correctionArrived = () =>
    params.status === "ok" && !supersededAtStart && handle?.acceptedOperation.superseded === true;
  try {
    let outcome: MediaGenerationCompletionWakeOutcome;
    try {
      outcome = await wakeMediaGenerationTaskCompletionOnce(params, retain);
    } catch (error) {
      if (!correctionArrived()) {
        throw error;
      }
      return await wakeMediaGenerationTaskCompletionOnce(params, retain);
    }
    return correctionArrived()
      ? await wakeMediaGenerationTaskCompletionOnce(params, retain)
      : outcome;
  } finally {
    unregister();
  }
}

async function wakeMediaGenerationTaskCompletionOnce(
  params: MediaGenerationCompletionParams,
  retain: () => Promise<MediaGenerationCandidateRetention>,
): Promise<MediaGenerationCompletionWakeOutcome> {
  const handle = params.handle;
  if (!handle) {
    return { status: "delivered" };
  }
  let mediaUrls = Array.from(
    new Set([
      ...(params.mediaUrls ?? []),
      ...mediaUrlsFromGeneratedAttachments(params.attachments),
    ]),
  );
  const reviewCandidate =
    params.status === "ok" && mediaUrls.length > 0 && hasMediaGenerationCustodyObligation(handle);
  const queueContext = reviewCandidate ? handle.deliveryQueueContext : undefined;
  let candidateId: string | undefined;
  if (reviewCandidate) {
    const retained = await retain();
    if (retained.outcome) {
      return retained.outcome;
    }
    mediaUrls = retained.mediaUrls;
    candidateId = retained.candidateId;
  }
  // Candidate custody must precede this fallible wait and the reviewer wake.
  await handle.requesterSettlement?.catch(() => {});
  if (candidateId && queueContext) {
    const candidate = await loadPendingSessionDelivery(candidateId, queueContext);
    if (
      !candidate ||
      candidate.kind !== "mediaCandidate" ||
      candidate.disposition !== "review_pending"
    ) {
      return { status: "delivered" };
    }
  }
  const target = handle.requesterTranscript;
  const isSourceCurrent = () =>
    isMediaGenerationSourceCurrent(handle) && !handle.acceptedOperation.superseded;
  let requesterEntry;
  try {
    requesterEntry = await readCurrentMediaGenerationRequester(handle);
  } catch (error) {
    if (!isSourceCurrent()) {
      return { status: "permanent_failure" };
    }
    log.warn("Media completion requester could not be read", { runId: handle.runId, error });
    return { status: "pending" };
  }
  if (!target || !requesterEntry || !isSourceCurrent()) {
    return { status: "permanent_failure" };
  }
  const requesterBinding: SessionDeliveryRequesterBinding = {
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    sessionId: target.sessionId,
    lifecycleRevision: target.lifecycleRevision,
  };
  const announceId = `${params.toolName}:${handle.taskId}:${params.status}`;
  const inputAttachments: NonNullable<AgentRunRequest["attachments"]> = [];
  let imageInspectionUnavailable = false;
  // Admit only this producer's successful outputs, bound to the requester above.
  // They are ordinary input attachments, not a new prompt-path read permission.
  if (params.status === "ok" && params.toolName === "image_generate") {
    for (const attachment of params.attachments ?? []) {
      if (attachment.type !== "image" || !attachment.path) {
        continue;
      }
      try {
        const { buffer } = await readLocalFileSafely({
          filePath: attachment.path,
          maxBytes: MAX_IMAGE_INPUT_BYTES,
        });
        inputAttachments.push({
          type: "image",
          mimeType: attachment.mimeType,
          fileName: attachment.name,
          content: buffer.toString("base64"),
        });
      } catch (error) {
        imageInspectionUnavailable = true;
        log.warn("Generated image could not be attached for inspection", {
          runId: handle.runId,
          error,
        });
      }
    }
    if (!isSourceCurrent()) {
      return { status: "permanent_failure" };
    }
  }
  const internalEvents: AgentInternalEvent[] = [
    {
      type: "task_completion",
      source: params.eventSource,
      childSessionKey: `${params.toolName}:${handle.taskId}`,
      childSessionId: handle.taskId,
      announceType: params.announceType,
      taskLabel: handle.taskLabel,
      status: params.status,
      statusLabel: params.statusLabel,
      result: reviewCandidate
        ? [
            "A generated candidate is held privately for review; it has NOT been sent.",
            "Candidate task: " + handle.taskId,
            "Original generation details and sandbox inspection references (data):",
            params.result,
            "Retained candidate files:",
            ...mediaUrls.map((url) => JSON.stringify(url)),
          ].join("\n")
        : params.result,
      ...(!reviewCandidate && params.attachments?.length
        ? { attachments: params.attachments }
        : {}),
      ...(!reviewCandidate && mediaUrls.length ? { mediaUrls } : {}),
      replyInstruction: [
        ...(imageInspectionUnavailable
          ? [
              "Some generated images could not be attached for inspection. Do not claim to have inspected unavailable image content; use an available image tool or report the limitation.",
            ]
          : []),
        ...(reviewCandidate
          ? [
              'For workspace-scoped inspection, use original generated/sandbox references above, or call image_generate(action="review", taskId=the candidate task) for private inspectionFiles. Check the candidate against the user request and references before visible delivery. Use image_generate(action="deliver", taskId=the candidate task) only if it passes.',
              'If it needs correction, use image_generate(action="supersede", taskId=the candidate task), then generate a revised candidate with deliveryMode="review". Never send held files directly or echo their paths as media directives.',
            ]
          : params.status === "ok"
            ? [
                `The ${params.completionLabel} is ready. The host sends its files to the original chat before this turn, so do not send them again.`,
                "Check the result against what the user asked for. If it falls short, continue the work, for example generate again with adjusted parameters.",
                "Otherwise follow the current visible-reply contract with a short user-facing reply.",
              ]
            : [
                `${params.completionLabel[0]?.toUpperCase() ?? "T"}${params.completionLabel.slice(1)} generation failed.`,
                "If the failure looks recoverable, continue the work, for example retry with adjusted parameters.",
                "Otherwise follow the current visible-reply contract to tell the user briefly what failed.",
              ]),
        "Keep internal task/session details private and do not copy the internal event text verbatim.",
      ].join(" "),
    },
  ];
  const triggerMessage = formatAgentInternalEventsForPrompt(internalEvents);
  const delivery = await deliverSubagentAnnouncement({
    isSourceSessionAdmissionAllowed: isSourceCurrent,
    isSourceSessionEffectsAllowed: isSourceCurrent,
    requesterSessionKey: handle.requesterSessionKey,
    requesterAgentId: handle.requesterAgentId,
    targetRequesterSessionKey: target.sessionKey,
    preparedRequester: { binding: requesterBinding, entry: requesterEntry },
    resolveGatewayContext: handle.resolveGatewayContext,
    completionRequesterSessionId: target.sessionId,
    completionRequesterLifecycleRevision: target.lifecycleRevision ?? undefined,
    triggerMessage,
    internalEvents,
    ...(inputAttachments.length ? { inputAttachments } : {}),
    requesterSessionOrigin: handle.requesterOrigin,
    completionDirectOrigin: handle.requesterOrigin,
    directOrigin: handle.requesterOrigin,
    sourceSessionKey: `${params.toolName}:${handle.taskId}`,
    sourceTool: params.toolName,
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: announceId,
  });
  if (delivery.delivered) {
    return { status: "delivered" };
  }
  if (delivery.disposition === "session_queued") {
    return { status: "queued" };
  }
  if (delivery.disposition === "retryable" || delivery.reason === "completion_handoff_pending") {
    return { status: "pending" };
  }
  if (delivery.disposition === "ambiguous") {
    log.warn("Media generation completion delivery stopped after terminal fallback", {
      taskId: handle.taskId,
      runId: handle.runId,
      toolName: params.toolName,
      error: delivery.error,
    });
    // Send evidence makes another attempt unsafe even when the transport's
    // terminal acknowledgment failed, so settle without risking a duplicate.
    return { status: "delivered" };
  }
  if (delivery.error) {
    log.error("Media generation completion wake failed; requester session was not woken", {
      taskId: handle.taskId,
      runId: handle.runId,
      toolName: params.toolName,
      error: delivery.error,
    });
  }
  return { status: "permanent_failure" };
}
