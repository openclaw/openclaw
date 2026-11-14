import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { sessionMatchesExpectedTranscriptTurn } from "../../config/sessions/session-transcript-turn-state.js";
import {
  captureSessionTranscriptStorageEnvironment,
  sameSessionTranscriptStorageEnvironment,
  type SessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import type { SessionDeliveryRequesterBinding } from "../../infra/session-delivery-queue.records.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { RequiredCompletionTerminalResult } from "../completion-result.js";
import {
  mediaUrlsFromGeneratedAttachments,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "../internal-events.js";
import { findMediaGenerationOperation } from "../media-generation-activity.js";
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
  resolveGatewayContext?: GatewayContextResolver;
  taskLabel: string;
};

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
    resolveGatewayContext: handle.resolveGatewayContext,
    completionRequesterSessionId: target.sessionId,
    completionRequesterLifecycleRevision: target.lifecycleRevision ?? undefined,
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
