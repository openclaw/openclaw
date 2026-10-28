import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { findTranscriptEvent } from "../../config/sessions/session-accessor.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { sessionMatchesExpectedTranscriptTurn } from "../../config/sessions/session-transcript-turn-state.js";
import {
  captureSessionTranscriptStorageEnvironment,
  sameSessionTranscriptStorageEnvironment,
  type SessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
  removeManagedOutgoingMediaBlocks,
} from "../../gateway/managed-image-attachments.js";
import type { SessionDeliveryRequesterBinding } from "../../infra/session-delivery-queue.records.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { RequiredCompletionTerminalResult } from "../completion-result.js";
import {
  mediaUrlsFromGeneratedAttachments,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "../internal-events.js";
import { isMediaGenerationOperationCurrent } from "../media-generation-activity.js";
import { deliverSubagentAnnouncement } from "../subagents/announce/subagent-announce-delivery.js";

const log = createSubsystemLogger("agents/tools/media-generate-background-completion");

export type MediaGenerationTaskHandle = {
  taskId: string;
  runId: string;
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  detach: boolean;
  requesterTranscript?: SessionTranscriptTargetBinding & { lifecycleRevision: string | null };
  taskLabel: string;
};

function isMediaGenerationSourceCurrent(handle: MediaGenerationTaskHandle): boolean {
  const target = handle.requesterTranscript;
  return Boolean(
    target &&
    isMediaGenerationOperationCurrent(handle.runId) &&
    sameSessionTranscriptStorageEnvironment(
      target.env,
      captureSessionTranscriptStorageEnvironment(process.env),
    ),
  );
}

/** Delivery and sandbox writes must belong to the same admitted conversation. */
export async function readCurrentMediaGenerationRequester(handle: MediaGenerationTaskHandle) {
  const target = handle.requesterTranscript;
  if (!target || !isMediaGenerationSourceCurrent(handle)) {
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
  if (!handle || !target || params.terminalResult?.terminalOutcome !== "blocked") {
    return;
  }
  const assertCurrent = () => {
    if (!isMediaGenerationSourceCurrent(handle)) {
      throw new Error("Media generation owner is no longer current");
    }
  };
  assertCurrent();
  const fallbackText =
    "Generated media is ready, but completion delivery was not confirmed. The saved media is retained here.";
  const idempotencyKey = `media-completion-retained:${handle.runId}`;
  const existing = await findTranscriptEvent(target, {
    kind: "idempotency",
    key: idempotencyKey,
    assistant: true,
  });
  if (existing) {
    assertCurrent();
    const event = existing.event;
    const message = isRecord(event) && isRecord(event.message) ? event.message : undefined;
    const displayContent = readAssistantDisplayContent(message);
    const hasImage = displayContent.some((block) => block.type === "image");
    if (hasImage) {
      const messageId = isRecord(event) && typeof event.id === "string" ? event.id.trim() : "";
      if (
        !messageId ||
        !(await attachManagedOutgoingMediaToMessage({ messageId, blocks: displayContent }))
      ) {
        throw new Error("Could not reconcile retained generated image ownership");
      }
      assertCurrent();
    }
    return;
  }
  assertCurrent();
  const mediaUrls = Array.from(
    new Set([
      ...(params.mediaUrls ?? []),
      ...mediaUrlsFromGeneratedAttachments(params.attachments),
    ]),
  );
  const imageItems = (params.attachments ?? []).flatMap((attachment) => {
    const isImage =
      attachment.type === "image" ||
      (attachment.type === undefined && attachment.mimeType?.toLowerCase().startsWith("image/"));
    if (!isImage) {
      return [];
    }
    const url = attachment.path ?? attachment.url ?? attachment.mediaUrl ?? attachment.filePath;
    return url
      ? [
          {
            url,
            trustedLocal: false,
            ...(attachment.name ? { filename: attachment.name } : {}),
            ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          },
        ]
      : [];
  });
  let displayMedia: Record<string, unknown>[] = [];
  if (imageItems.length > 0) {
    try {
      displayMedia = await createManagedOutgoingMediaBlocks({
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        items: imageItems,
        continueOnPrepareError: true,
        onPrepareError: (error) => {
          log.warn("A generated image could not be prepared for retained completion", {
            runId: handle.runId,
            error,
          });
        },
        assertCurrent,
      });
    } catch (error) {
      assertCurrent();
      log.warn("Blocked media completion could not prepare retained images", {
        runId: handle.runId,
        error,
      });
    }
  }

  let transcriptCommitted = false;
  try {
    assertCurrent();
    const result = await appendAssistantMessageToSessionTranscript({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      expectedSessionId: target.sessionId,
      expectedLifecycleRevision: target.lifecycleRevision,
      idempotencyKey,
      assertCurrent,
      text: fallbackText,
      ...(displayMedia.length > 0
        ? { displayContent: [{ type: "text", text: fallbackText }, ...displayMedia] }
        : {}),
      mediaUrls,
    });
    if (!result.ok) {
      throw new Error(`Could not retain generated media in the original session: ${result.reason}`);
    }
    transcriptCommitted = true;
    if (
      displayMedia.some((block) => block.type === "image") &&
      !(await attachManagedOutgoingMediaToMessage({
        messageId: result.messageId,
        blocks: displayMedia,
      }))
    ) {
      throw new Error("Could not persist retained generated image ownership");
    }
    assertCurrent();
  } finally {
    if (!transcriptCommitted && displayMedia.length > 0) {
      await removeManagedOutgoingMediaBlocks({ blocks: displayMedia, messageId: null });
    }
  }
}

export type MediaGenerationCompletionWakeOutcome =
  | { status: "delivered" }
  | { status: "queued" }
  | { status: "pending" }
  | { status: "permanent_failure" };

export async function wakeMediaGenerationTaskCompletion(params: {
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
}): Promise<MediaGenerationCompletionWakeOutcome> {
  const handle = params.handle;
  if (!handle) {
    return { status: "delivered" };
  }
  const target = handle.requesterTranscript;
  const isSourceCurrent = () => isMediaGenerationSourceCurrent(handle);
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
  const mediaUrls = Array.from(
    new Set([
      ...(params.mediaUrls ?? []),
      ...mediaUrlsFromGeneratedAttachments(params.attachments),
    ]),
  );
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
      result: params.result,
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
      ...(mediaUrls.length ? { mediaUrls } : {}),
      replyInstruction: [
        ...(params.status === "ok"
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
    triggerMessage,
    internalEvents,
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
