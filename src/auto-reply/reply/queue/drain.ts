import { createHash } from "node:crypto";
import { runAgentHarnessBeforeMessageWriteHook } from "../../../agents/harness/hook-helpers.js";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { compareChannelAdmissionParticipants } from "../../../channels/message-access/admission-evidence.js";
import { channelRouteDedupeKey } from "../../../plugin-sdk/channel-route.js";
import {
  getGatewayRestartDrainSignal,
  isGatewayRestartDrainError,
  isGatewayRestartDraining,
  runWithGatewayDetachedWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { deferSessionControllerClaimBeforeExecution } from "../../../sessions/session-controller.mailbox-claim.js";
import {
  detachSessionControllerSources,
  getExistingSessionControllerMailbox,
  releaseSessionControllerClaim,
  trackSessionControllerSourceWork,
  type SessionControllerMailbox,
  type SessionControllerMailboxClaim,
} from "../../../sessions/session-controller.mailbox.js";
import { runWithSessionControllerCleanup } from "../../../sessions/session-controller.owner-context.js";
import type { SessionControllerEntry } from "../../../sessions/session-controller.state.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "../../../state/agent-database-admission-error.js";
import { buildCollectPrompt, previewQueueSummaryPrompt } from "../../../utils/queue-helpers.js";
import {
  collectCurrentInboundContext,
  collectRuntimeMetadata,
  resolveFollowupReplyAnchor,
} from "./delivery-context.js";
import { runOutsideAdmittedGenerationScopes } from "./drain-admission-scope.js";
import {
  buildCollectTranscriptInput,
  collectQueuedPromptMedia,
  createAggregateCancellation,
  createCollectUserTurnTranscriptRecorder,
  renderCollectItem,
  resolveAggregateOwner,
  resolveFollowupTranscriptTarget,
  resolveOriginRoutingMetadata,
} from "./envelope.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  retireFollowupRunCancellation,
  updateFollowupRetryHeartbeats,
} from "./lifecycle.js";
import { followupQueueSources, followupSourceRunners } from "./state.js";
import { isFollowupRunAborted, type FollowupRun } from "./types.js";

type AdmissionSessionRebind = { from: string; to: string };

function consumeQueueSummaryDelivery(
  queue: Pick<
    SessionControllerMailbox,
    "summarySources" | "summaryLines" | "summaryElisions" | "droppedCount"
  >,
  delivery: { droppedCount: number; sources: readonly FollowupRun[] },
  completeLifecycles = true,
): void {
  let consumedCount = delivery.sources.length === 0 ? delivery.droppedCount : 0;
  for (const source of delivery.sources) {
    const sourceIndex = queue.summarySources.indexOf(source);
    const entry =
      sourceIndex < 0
        ? queue.summaryElisions.find(
            (candidate) => candidate.sources.includes(source) || candidate.sourceRefs.has(source),
          )
        : undefined;
    if (sourceIndex >= 0 || entry) {
      const index = entry
        ? entry.sources.indexOf(entry.sourceRefs.get(source) ?? source)
        : sourceIndex;
      if (index >= 0) {
        (entry?.sources ?? queue.summarySources).splice(index, 1);
        (entry?.summaryLines ?? queue.summaryLines).splice(index, 1);
      }
      consumedCount += 1;
      if (entry) {
        for (const [original, compact] of entry.sourceRefs) {
          if (compact === source || original === source) {
            entry.sourceRefs.delete(original);
          }
        }
        entry.count = entry.sources.length;
        if (entry.sources.length === 0) {
          queue.summaryElisions.splice(queue.summaryElisions.indexOf(entry), 1);
        }
      }
    }
    if (completeLifecycles) {
      completeFollowupRunLifecycle(source);
    }
  }
  queue.droppedCount = Math.max(0, queue.droppedCount - consumedCount);
}

// Overflow retries must reuse one transcript identity, while the same provider-local
// message ID on a different channel route remains an independent user turn.
function buildOverflowTranscriptIdempotencyKey(source: FollowupRun, prompt: string): string {
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  const routeHash = createHash("sha256")
    .update(
      JSON.stringify([
        channelRouteDedupeKey({
          channel: source.originatingChannel,
          to: source.originatingTo,
          accountId: source.originatingAccountId,
          threadId: source.originatingThreadId,
        }),
        resolveFollowupReplyAnchor(source) ?? "",
        source.originatingReplyToMode ?? "",
        normalizeChatType(source.originatingChatType) ?? "",
      ]),
    )
    .digest("hex");
  return `followup-overflow:${source.run.sessionId}:${routeHash}:${source.messageId ?? source.enqueuedAt}:${promptHash}`;
}

function resolveCollectedRun(items: readonly FollowupRun[], source: FollowupRun["run"]) {
  const participantComparison = compareChannelAdmissionParticipants(
    items.map((item) => item.channelAdmissionEvidence),
  );
  if (
    participantComparison === "same" ||
    !items.every(
      (item) => compareChannelAdmissionParticipants([item.channelAdmissionEvidence]) === "same",
    )
  ) {
    return source;
  }
  // Mixed or unverifiable people share no downstream sender authority. The
  // opaque admission aggregate records unknown identity at the run boundary.
  return {
    ...source,
    senderId: undefined,
    senderName: undefined,
    senderUsername: undefined,
    senderE164: undefined,
    senderIsOwner: false,
    traceAuthorized: false,
    ownerNumbers: [],
  };
}

/** Executes an already-selected claim. This adapter never chooses a successor. */
async function executeClaim(
  claim: SessionControllerMailboxClaim,
  execute: (run: FollowupRun) => Promise<void>,
  admissionSessionRebind?: AdmissionSessionRebind,
): Promise<void> {
  const queue = claim.mailbox;
  const generation = queue.abortController;
  const sources = [...claim.sources];
  const source = sources.at(-1);
  if (!source) {
    releaseSessionControllerClaim(claim);
    return;
  }
  const cancellation = createAggregateCancellation(sources);
  const aggregateOwner = resolveAggregateOwner(sources);
  const adopt = async () => {
    // Accepted collection consumes every source even when an ingress ack fails.
    detachSessionControllerSources(sources);
    const admissions = sources.map((item) => admitFollowupRunLifecycle(item));
    try {
      await Promise.all(admissions);
    } catch (error) {
      // Retry eligibility depends on every source's final adoption outcome.
      await Promise.allSettled(admissions);
      throw error;
    }
    cancellation.admit();
    for (const item of sources) {
      if (item !== aggregateOwner) {
        retireFollowupRunCancellation(item);
      }
    }
  };
  for (const item of sources) {
    if (claim.summary) {
      queue.activeSummarySources.add(item);
    }
  }
  // A summary prompt shows only the newest cap lines; source context pairs with those lines.
  const summarizedSources = queue.cap > 0 ? sources.slice(-queue.cap) : sources;
  const summaryLines = summarizedSources.map((item) => {
    const index = queue.summarySources.indexOf(item);
    if (index >= 0) {
      return queue.summaryLines[index] ?? "";
    }
    for (const elision of queue.summaryElisions) {
      const elisionIndex = elision.sources.indexOf(item);
      if (elisionIndex >= 0) {
        return elision.summaryLines[elisionIndex] ?? "";
      }
    }
    return item.summaryLine ?? item.prompt;
  });
  const prompt = claim.summary
    ? (previewQueueSummaryPrompt({ droppedCount: sources.length, summaryLines }) ?? "")
    : buildCollectPrompt({
        title: "[Queued messages while agent was busy]",
        items: sources,
        renderItem: renderCollectItem,
      });
  const settleSources = async (outcome?: "consumed") => {
    for (const item of sources) {
      completeFollowupRunLifecycle(item, outcome);
    }
    await Promise.all(sources.flatMap((item) => item.controllerInput?.custody.settling ?? []));
  };
  let run = source;
  if (claim.summary || sources.length > 1) {
    const recorder = claim.summary
      ? createUserTurnTranscriptRecorder({
          input: {
            text: prompt,
            idempotencyKey: buildOverflowTranscriptIdempotencyKey(source, prompt),
            senderIsOwner: source.run.senderIsOwner,
            requesterOrigin: source.run.requesterOrigin,
            provenance: source.run.inputProvenance,
          },
          pendingInputSources: sources.flatMap((item) => item.userTurnTranscriptRecorder ?? []),
          target: () => resolveFollowupTranscriptTarget(source),
          beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
          errorContext: "mailbox overflow transcript",
        })
      : createCollectUserTurnTranscriptRecorder(sources);
    run = {
      ...source,
      ...resolveOriginRoutingMetadata(sources),
      ...collectRuntimeMetadata(sources, cancellation.signal),
      ...collectQueuedPromptMedia(sources),
      ...(claim.summary
        ? { currentInboundContext: collectCurrentInboundContext(summarizedSources) }
        : {}),
      prompt,
      transcriptPrompt: claim.summary ? prompt : buildCollectTranscriptInput(sources).text,
      userTurnTranscriptRecorder: recorder,
      run: resolveCollectedRun(sources, source.run),
      controllerInput: source.controllerInput,
      controllerClaim: claim,
      turnAdoptionLifecycle: {
        admission: "cancel-only",
        cronCreatorAuthorityUnavailable: sources.find(
          (item) => item.turnAdoptionLifecycle?.cronCreatorAuthorityUnavailable,
        )?.turnAdoptionLifecycle?.cronCreatorAuthorityUnavailable,
        onAdopted: adopt,
        onAbandoned: () => settleSources(),
        onSettled: () => settleSources("consumed"),
      },
    };
  }
  let adoptionRefused = false;
  let waitForFreshKick = false;
  try {
    if (admissionSessionRebind && run.run.sessionId === admissionSessionRebind.from) {
      run = { ...run, admissionSessionId: admissionSessionRebind.to };
    }
    const runFollowup =
      (source.controllerInput && followupSourceRunners.get(source.controllerInput)) ?? execute;
    await runFollowup(run);
  } catch (error) {
    updateFollowupRetryHeartbeats(error, sources);
    adoptionRefused = sources.some((item) => {
      const custody = item.controllerInput?.custody;
      return (
        custody && !custody.adopted && custody.failure !== undefined && custody.failure === error
      );
    });
    if (adoptionRefused) {
      // Adoption is the last reversible producer boundary before model/tool work.
      // Match the custody owner's exact rejection so later execution errors cannot replay.
      deferSessionControllerClaimBeforeExecution(claim);
    }
    waitForFreshKick =
      claim.retryBeforeExecution === true &&
      error instanceof AgentDatabaseExecutionAdmissionClosedError;
    defaultRuntime.error?.("mailbox execution failed for " + queue.key + ": " + String(error));
  } finally {
    // Only the execution producer can return an explicit pre-execution refusal.
    // Generic throws/returns and the operation's broader preparation marker never
    // grant or revoke replayability; the producer-local receipt is authoritative.
    const preparationRefused = claim.retryBeforeExecution === true;
    const retrySources = claim.retryBeforeExecution
      ? sources.filter((item) => {
          try {
            item.operatorAuthority?.assertCurrent();
          } catch {
            return false;
          }
          return (
            !isFollowupRunAborted(item) &&
            !item.controllerInput?.retirementRequested &&
            (!adoptionRefused || !item.controllerInput?.custody.adopted) &&
            !item.controllerInput?.custody.completed
          );
        })
      : [];
    if (!retrySources.length) {
      claim.retryBeforeExecution = false;
    }
    const consumed = sources.filter((item) => !retrySources.includes(item));
    detachSessionControllerSources(consumed);
    if (claim.summary) {
      consumeQueueSummaryDelivery(
        queue,
        { sources: consumed, droppedCount: consumed.length },
        false,
      );
    }
    for (const item of retrySources) {
      item.controllerInput!.payload = claim.summary ? "summary" : "ready";
    }
    if (retrySources.length) {
      queue.lastEnqueuedAt = performance.now();
    }
    for (const item of sources) {
      queue.activeSummarySources.delete(item);
      for (const elision of queue.summaryElisions) {
        const compact = elision.sourceRefs.get(item);
        if (compact) {
          queue.activeSummarySources.delete(compact);
        }
      }
      if (retrySources.includes(item)) {
        continue;
      }
      try {
        completeFollowupRunLifecycle(item, preparationRefused ? undefined : "consumed");
      } catch (error) {
        defaultRuntime.error?.("mailbox custody settlement failed: " + String(error));
      }
    }
    cancellation.dispose();
    if (!waitForFreshKick && queue.abortController === generation) {
      queue.dispatchEnabled = true;
    }
    releaseSessionControllerClaim(claim);
  }
}
export function rememberFollowupDrainCallback(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
  captured?: SessionControllerMailbox,
  admissionSessionRebind?: AdmissionSessionRebind,
): void {
  const mailbox = captured ?? getExistingSessionControllerMailbox(key);
  if (!mailbox) {
    return;
  }
  mailbox.dispatch = async (claim) => {
    if (isGatewayRestartDraining() && deferSessionControllerClaimBeforeExecution(claim)) {
      mailbox.dispatchEnabled = false;
      releaseSessionControllerClaim(claim);
      return;
    }
    let entered = false;
    try {
      // The turn owns a fresh async work scope: tracked agent work must keep running
      // after the request that triggered the drain has closed its own scope.
      await runWithGatewayDetachedWorkContinuation(
        () =>
          runOutsideAdmittedGenerationScopes(() => {
            entered = true;
            // Consume this request; a kick during execution re-enables dispatch.
            mailbox.dispatchEnabled = false;
            // The retiring turn may wake this mailbox from its own async context.
            return runWithSessionControllerCleanup(() =>
              executeClaim(claim, runFollowup, admissionSessionRebind),
            );
          }),
        "session:mailbox-turn",
      );
    } catch (error) {
      if (
        !entered &&
        isGatewayRestartDrainError(error) &&
        !getGatewayRestartDrainSignal().aborted &&
        deferSessionControllerClaimBeforeExecution(claim)
      ) {
        // Rollback alone must not create a background backlog. The next ordinary
        // kick re-enables dispatch of the retained, unexecuted input.
        mailbox.dispatchEnabled = false;
        releaseSessionControllerClaim(claim);
        return;
      }
      defaultRuntime.error?.("mailbox root admission failed: " + String(error));
      for (const source of claim.sources) {
        completeFollowupRunLifecycle(source);
      }
      detachSessionControllerSources(claim.sources);
      if (claim.summary) {
        consumeQueueSummaryDelivery(
          mailbox,
          { sources: claim.sources, droppedCount: claim.sources.length },
          false,
        );
      }
      releaseSessionControllerClaim(claim);
    }
  };
}

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
  owner?: SessionControllerEntry,
  admissionSessionRebind?: AdmissionSessionRebind,
): void {
  const mailbox = owner ? owner.mailbox : getExistingSessionControllerMailbox(key);
  if (!mailbox) {
    return;
  }
  rememberFollowupDrainCallback(key, runFollowup, mailbox, admissionSessionRebind);
  mailbox.dispatchEnabled = true;
  mailbox.wake();
}

export async function dropAbortedFollowups(
  queue: SessionControllerMailbox,
  runFollowup: (run: FollowupRun) => Promise<void>,
): Promise<number> {
  const sources = [...new Set(followupQueueSources(queue))].filter(
    (source) =>
      isFollowupRunAborted(source) &&
      source.controllerInput?.phase !== "injecting" &&
      !queue.inFlight.has(source),
  );
  detachSessionControllerSources(sources);
  consumeQueueSummaryDelivery(queue, { sources, droppedCount: 0 }, false);
  for (const source of sources) {
    const execute =
      (source.controllerInput && followupSourceRunners.get(source.controllerInput)) ?? runFollowup;
    const presentation = Promise.resolve().then(() => execute(source));
    if (source.controllerInput) {
      trackSessionControllerSourceWork(source.controllerInput, presentation);
    }
    completeFollowupRunLifecycle(source);
    try {
      await presentation;
    } catch (error) {
      defaultRuntime.error?.("mailbox cancellation presentation failed: " + String(error));
    }
  }
  queue.wake();
  return sources.length;
}
