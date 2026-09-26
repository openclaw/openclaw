import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { sessionMatchesExpectedTranscriptTurn } from "../../config/sessions/session-transcript-turn-state.js";
import {
  captureSessionTranscriptStorageEnvironment,
  sameSessionTranscriptStorageEnvironment,
  type SessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionDeliveryRequesterBinding } from "../../infra/session-delivery-queue.records.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { RequiredCompletionTerminalResult } from "../completion-result.js";
import {
  formatGeneratedAttachmentLines,
  mediaUrlsFromGeneratedAttachments,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "../internal-events.js";
import { isMediaGenerationOperationCurrent } from "../media-generation-activity.js";
import { deliverSubagentAnnouncement } from "../subagents/announce/subagent-announce-delivery.js";

const log = createSubsystemLogger("agents/tools/media-generate-background-completion");
// Only blocked results missed the requester; retain references instead of resending.
// Bound the process-local failure summary independently of durable transcript retention.
const MEDIA_GENERATION_RETAINED_RESULT_MAX_CHARS = 4_000;

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
    if (
      !isMediaGenerationOperationCurrent(handle.runId) ||
      !sameSessionTranscriptStorageEnvironment(
        target.env,
        captureSessionTranscriptStorageEnvironment(process.env),
      )
    ) {
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
    // Keyed appends run this inside the transaction, after awaited preparation.
    beforeMessageWrite: ({ message }) => {
      assertCurrent();
      return message;
    },
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

export type MediaGenerationCompletionWakeOutcome =
  | { status: "delivered" }
  | { status: "pending" }
  | { status: "permanent_failure" };

export function retainBlockedMediaReferences(
  terminalResult: RequiredCompletionTerminalResult | undefined,
  attachments: AgentGeneratedAttachment[] | undefined,
): RequiredCompletionTerminalResult | undefined {
  if (terminalResult?.terminalOutcome !== "blocked") {
    return terminalResult;
  }
  const referenceLines = formatGeneratedAttachmentLines(attachments);
  if (referenceLines.length === 0) {
    return terminalResult;
  }
  const terminalSummary = [
    terminalResult.terminalSummary,
    "Retained generated media:",
    ...referenceLines,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  return {
    ...terminalResult,
    terminalSummary: truncateUtf16Safe(terminalSummary, MEDIA_GENERATION_RETAINED_RESULT_MAX_CHARS),
  };
}

function buildMediaGenerationReplyInstruction(params: {
  status: "ok" | "error";
  completionLabel: string;
}) {
  if (params.status === "ok") {
    return [
      `The ${params.completionLabel} is ready for the original chat.`,
      "Follow the current visible-reply contract with a short user-facing caption and every structured generated attachment from this event.",
      "Keep internal task/session details private and do not copy the internal event text verbatim.",
    ].join(" ");
  }
  return [
    `${params.completionLabel[0]?.toUpperCase() ?? "T"}${params.completionLabel.slice(1)} generation task failed for the original chat.`,
    "Follow the current visible-reply contract with a concise user-facing failure message.",
    "Keep internal task/session details private and do not copy the internal event text verbatim.",
  ].join(" ");
}

export async function wakeMediaGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
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
  const isSourceCurrent = () =>
    Boolean(
      target &&
      isMediaGenerationOperationCurrent(handle.runId) &&
      sameSessionTranscriptStorageEnvironment(
        target.env,
        captureSessionTranscriptStorageEnvironment(process.env),
      ),
    );
  if (!target || !isSourceCurrent()) {
    return { status: "permanent_failure" };
  }
  let requesterEntry;
  try {
    requesterEntry = await withSessionEntryReadOnlyInWorker(
      { ...target, hydrateSkillPromptRefs: false },
      () => {
        if (!isSourceCurrent()) {
          throw new Error("Media completion source is no longer current");
        }
      },
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        return sessionMatchesExpectedTranscriptTurn(
          read.value ? { entry: read.value } : undefined,
          {
            expectedSessionId: target.sessionId,
            expectedLifecycleRevision: target.lifecycleRevision,
          },
        )
          ? read.value
          : undefined;
      },
    );
  } catch (error) {
    if (!isSourceCurrent()) {
      return { status: "permanent_failure" };
    }
    log.warn("Media completion requester could not be read", { runId: handle.runId, error });
    return { status: "pending" };
  }
  if (!requesterEntry || !isSourceCurrent()) {
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
      ...(params.statsLine?.trim() ? { statsLine: params.statsLine } : {}),
      replyInstruction: buildMediaGenerationReplyInstruction({
        status: params.status,
        completionLabel: params.completionLabel,
      }),
    },
  ];
  const triggerMessage =
    formatAgentInternalEventsForPrompt(internalEvents) ||
    `A ${params.completionLabel} generation task finished. Process the completion update now.`;
  const delivery = await deliverSubagentAnnouncement({
    isSourceSessionAdmissionAllowed: isSourceCurrent,
    isSourceSessionEffectsAllowed: isSourceCurrent,
    requesterSessionKey: handle.requesterSessionKey,
    requesterAgentId: handle.requesterAgentId,
    targetRequesterSessionKey: target.sessionKey,
    preparedRequester: { binding: requesterBinding, entry: requesterEntry },
    triggerMessage,
    steerMessage: triggerMessage,
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
  if (
    delivery.disposition === "session_queued" ||
    delivery.disposition === "retryable" ||
    delivery.reason === "completion_handoff_pending"
  ) {
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
