import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isRequiredReplyExpectation } from "../../../agents/reply-completion.js";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { racePromiseWithAbortSignal } from "../../../infra/abort-signal.js";
import { logMessageQueuedWithBacklogPolicy } from "../../../logging/diagnostic-runtime.js";
import { channelRouteDedupeKey } from "../../../plugin-sdk/channel-route.js";
import { defaultRuntime } from "../../../runtime.js";
import { settleSessionControllerSourceInjectionOrder } from "../../../sessions/session-controller.mailbox-source.js";
import {
  beginSessionControllerSourceInjection,
  submitSessionControllerInput,
  retireSessionControllerInput,
  findSessionControllerSourceMailbox,
} from "../../../sessions/session-controller.mailbox.js";
import { extractTextFromChatContent } from "../../../shared/chat-content.js";
import { applyQueueDropPolicy, countPendingQueueItems } from "../../../utils/queue-helpers.js";
import {
  createOverflowSummaryRetrySource,
  resolveFollowupAuthorizationKey,
  resolveFollowupDeliveryStorageKey,
} from "./delivery-context.js";
import { dropAbortedFollowups, rememberFollowupDrainCallback } from "./drain.js";
import { completeFollowupRunLifecycle, markFollowupRunEnqueued } from "./lifecycle.js";
import {
  followupSourceRunners,
  getExistingFollowupQueue,
  getFollowupQueue,
  trimSummaryElisionsToCap,
} from "./state.js";
import {
  isFollowupRunAborted,
  resolveFollowupAbortSignal,
  type EnqueueFollowupRunOptions,
  type FollowupRun,
  type QueueDedupeMode,
  type QueueSettings,
} from "./types.js";

const RECENT_MESSAGE_ID_TTL = 5 * 60 * 1000;
const MAX_RECENT_MESSAGE_IDS = 10_000;

function followupMessageRouteIdentityKey(run: FollowupRun): string {
  return JSON.stringify([
    channelRouteDedupeKey({
      channel: run.originatingChannel,
      to: run.originatingTo,
      accountId: run.originatingAccountId,
      threadId: run.originatingThreadId,
    }),
    normalizeChatType(run.originatingChatType) ?? "",
  ]);
}

function isRunAlreadyQueued(run: FollowupRun, items: FollowupRun[]): boolean {
  const messageId = normalizeOptionalString(run.messageId);
  if (messageId) {
    const messageRouteKey = followupMessageRouteIdentityKey(run);
    return items.some(
      (item) =>
        normalizeOptionalString(item.messageId) === messageId &&
        followupMessageRouteIdentityKey(item) === messageRouteKey,
    );
  }
  return false;
}

export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
  runFollowup?: (run: FollowupRun) => Promise<void>,
  restartIfIdle = true,
  options: EnqueueFollowupRunOptions = {},
): boolean {
  if (isFollowupRunAborted(run)) {
    return false;
  }
  if (options.position === "front") {
    run.protectFromQueueOverflow = true;
  }
  // Peek before getFollowupQueue: rejecting a redelivery after the original
  // queue drained and self-deleted must not recreate an empty registry entry,
  // which nothing would ever delete again.
  const messageId = dedupeMode !== "none" ? normalizeOptionalString(run.messageId) : undefined;
  // Use JSON tuple serialization to avoid delimiter-collision edge cases when
  // channel/to/account values contain "|" characters.
  const recentMessageIdKey = messageId
    ? JSON.stringify(["queue", key, followupMessageRouteIdentityKey(run), messageId])
    : undefined;
  if (recentMessageIdKey) {
    const mailbox = findSessionControllerSourceMailbox(key, run, options.storePath);
    const now = Date.now();
    const record = mailbox?.recentSources.get(recentMessageIdKey);
    if (record) {
      if (record.expires > now) {
        return false;
      }
      mailbox?.recentSources.delete(recentMessageIdKey);
    }
  }
  const input = submitSessionControllerInput(key, run, settings, { storePath: options.storePath });
  if (
    input.phase === "consumed" ||
    input.claim ||
    input.withdrawalHolds ||
    input.retirementRequested ||
    input.abortSignal.aborted
  ) {
    return false;
  }
  try {
    const queue = getFollowupQueue(key, settings, input.mailbox.owner.target);
    if (dedupeMode !== "none" && isRunAlreadyQueued(run, queue.items)) {
      // A redelivery may reuse the accepted source; reject only its duplicate enqueue.
      if (!queue.items.some((item) => item.controllerInput === input)) {
        retireSessionControllerInput(input);
      }
      return false;
    }
    // Automatic Goal work must not consume the last slot needed by real input.
    // Capture candidates now, but retire them only after the incoming source is admitted.
    const supersededGoals = run.goalContinuation
      ? []
      : queue.items.filter((item) => item.goalContinuation && !queue.inFlight.has(item));
    // Preserve later prompts while an older steer decides between same-turn
    // delivery and fallback; overflow resumes when the gate resolves.
    const deferOverflow = options.steerCandidate || queue.entries.some((item) => item.injection);
    // drop:new rejects this source without mutating the existing queue. Do not
    // publish an external queued identity for work that will never be admitted.
    if (
      !deferOverflow &&
      queue.dropPolicy === "new" &&
      queue.cap > 0 &&
      countPendingQueueItems(queue.items, queue.inFlight) - supersededGoals.length >= queue.cap
    ) {
      run.onQueueDisposition?.("queue-cap-new");
      completeFollowupRunLifecycle(run);
      return false;
    }
    // Deferred publication wakes Gateway waiters, which must already see the queued phase.
    // Payload readiness and selector wake remain below, after admission and overflow policy.
    input.phase = "waiting";
    if (!markFollowupRunEnqueued(run)) {
      retireSessionControllerInput(input);
      return false;
    }
    const superseded = supersededGoals.filter(
      (goal) => goal.controllerInput?.payload === "ready" && !queue.inFlight.has(goal),
    );
    for (const goal of superseded) {
      goal.controllerInput!.payload = "unbound";
    }
    for (const goal of superseded) {
      completeFollowupRunLifecycle(goal);
    }
    if (!deferOverflow && !applyFollowupQueueOverflow(queue, run)) {
      return false;
    }
    const front =
      options.position === "front" && (!deferOverflow || options.steerCandidate === true);
    queue.lastEnqueuedAt = performance.now();
    queue.lastRun = run.run;
    run.queueAbortSignal = queue.abortController.signal;
    const queuedInput = run.controllerInput!;
    queuedInput.payload = "ready";
    if (front) {
      queue.priority = queuedInput;
    }
    if (recentMessageIdKey) {
      const now = Date.now();
      const recentInput = run.controllerInput;
      if (!recentInput) {
        throw new Error("Dedupe source was not submitted to its mailbox");
      }
      const mailbox = recentInput.mailbox;
      const inputInstance = recentInput.instance;
      for (const [alias, record] of mailbox.recentSources) {
        if (record.expires <= now) {
          mailbox.recentSources.delete(alias);
        }
      }
      if (mailbox.recentSources.size >= MAX_RECENT_MESSAGE_IDS) {
        mailbox.recentSources.delete(mailbox.recentSources.keys().next().value!);
      }
      mailbox.recentSources.set(recentMessageIdKey, {
        inputInstance,
        expires: now + RECENT_MESSAGE_ID_TTL,
      });
      const lifecycle = run.turnAdoptionLifecycle;
      if (lifecycle) {
        const onAbandoned = lifecycle.onAbandoned;
        lifecycle.onAbandoned = () => {
          if (mailbox.recentSources.get(recentMessageIdKey)?.inputInstance === inputInstance) {
            mailbox.recentSources.delete(recentMessageIdKey);
          }
          return onAbandoned?.();
        };
      }
    }
    if (runFollowup) {
      if (!followupSourceRunners.has(queuedInput)) {
        followupSourceRunners.set(queuedInput, runFollowup);
      }
      rememberFollowupDrainCallback(key, runFollowup, queue);
    }
    const signal = resolveFollowupAbortSignal({
      abortSignal: run.abortSignal,
      operatorAuthority: run.operatorAuthority,
    });
    if (signal && runFollowup) {
      const onAbort = () => {
        // Cancellation must release pending ownership even while normal draining is dormant.
        void dropAbortedFollowups(queue, runFollowup).catch((error: unknown) => {
          defaultRuntime.error?.(`followup queue cancellation failed: ${String(error)}`);
        });
      };
      const disposeSource = queuedInput.custody.disposeSource;
      queuedInput.custody.disposeSource = () => {
        signal.removeEventListener("abort", onAbort);
        disposeSource?.();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    }
    if (restartIfIdle) {
      queue.dispatchEnabled = true;
      queue.wake();
    }
    if (!options.steerCandidate) {
      settleSessionControllerSourceInjectionOrder(input, false);
    }
    return true;
  } catch (error) {
    // A reserved but invisible head must not block later input after validation fails.
    retireSessionControllerInput(input);
    throw error;
  }
}

function applyFollowupQueueOverflow(
  queue: ReturnType<typeof getFollowupQueue>,
  run: FollowupRun,
): boolean {
  const elidedSummaryLines: string[] = [];
  const capacity = { ...queue, items: queue.items };
  const shouldEnqueue = applyQueueDropPolicy({
    queue: capacity,
    inFlight: queue.inFlight,
    summarize: (item) => {
      const approved = item.userTurnTranscriptRecorder?.getPendingInputMessage?.();
      // Capture the approved body before overflow stores its bounded preview.
      return approved
        ? (extractTextFromChatContent(approved.content, {
            normalizeText: (text) => text,
            joinWith: "\n",
          }) ?? "")
        : normalizeOptionalString(item.summaryLine) || item.prompt.trim();
    },
    onSummaryElide: (lines) => elidedSummaryLines.push(...lines),
    onDrop: (dropped) => {
      if (queue.dropPolicy === "summarize") {
        for (const source of dropped) {
          if (source.controllerInput) {
            source.controllerInput.payload = "summary";
          }
        }
        queue.summarySources.push(...dropped);
        return;
      }
      for (const item of dropped) {
        // Remove pending visibility immediately, while the input retains its
        // asynchronous source-cleanup custody until the actual receipt settles.
        if (item.controllerInput) {
          item.controllerInput.payload = "unbound";
        }
        item.onQueueDisposition?.("queue-cap-old");
        completeFollowupRunLifecycle(item);
      }
    },
    isProtected: (item) => item.protectFromQueueOverflow === true,
  });
  queue.droppedCount = capacity.droppedCount;
  queue.summaryLines = capacity.summaryLines;
  if (queue.dropPolicy === "summarize") {
    const overflow = Math.max(0, queue.summarySources.length - queue.summaryLines.length);
    const removed = queue.summarySources.splice(0, overflow);
    for (const [index, item] of removed.entries()) {
      const summaryLine = elidedSummaryLines[index];
      if (summaryLine === undefined) {
        throw new Error("followup queue summary source lost its elided line");
      }
      const contextKey = resolveFollowupDeliveryStorageKey(item);
      let elision = queue.summaryElisions.at(-1);
      const compactSource = createOverflowSummaryRetrySource(item);
      if (compactSource.controllerInput) {
        compactSource.controllerInput.source = compactSource;
      }
      if (elision?.contextKey !== contextKey) {
        elision = {
          contextKey,
          count: 0,
          sources: [],
          summaryLines: [],
          sourceRefs: new Map<FollowupRun, FollowupRun>(),
        };
        queue.summaryElisions.push(elision);
      }
      elision.sources.push(compactSource);
      elision.count = elision.sources.length;
      elision.summaryLines.push(summaryLine);
      elision.sourceRefs.set(item, compactSource);
      if (queue.activeSummarySources.has(item)) {
        queue.activeSummarySources.add(compactSource);
      }
      trimSummaryElisionsToCap(queue);
    }
  }
  if (!shouldEnqueue) {
    run.onQueueDisposition?.(queue.dropPolicy === "new" ? "queue-cap-new" : "queue-cap");
    completeFollowupRunLifecycle(run);
  }
  return shouldEnqueue;
}

export function getFollowupQueueDepth(key: string): number {
  const queue = getExistingFollowupQueue(key);
  return queue ? countPendingQueueItems(queue.items, queue.inFlight) : 0;
}

/** Claims the next pending user request from the same route and principal. */
export function claimNextQueuedFollowupRequestFrom(
  key: string,
  source: FollowupRun,
): FollowupRun | undefined {
  const queue = getExistingFollowupQueue(key);
  const next = queue?.items.find(
    (item) =>
      !queue.inFlight.has(item) &&
      !isFollowupRunAborted(item) &&
      isRequiredReplyExpectation(item.run.terminalReplyExpectation) &&
      item.strandedReplyRetry !== true,
  );
  if (
    !next ||
    followupMessageRouteIdentityKey(next) !== followupMessageRouteIdentityKey(source) ||
    resolveFollowupAuthorizationKey(next) !== resolveFollowupAuthorizationKey(source)
  ) {
    return undefined;
  }
  next.protectFromQueueOverflow = true;
  return next;
}

function reapplyDeferredOverflow(queue: ReturnType<typeof getFollowupQueue>): void {
  if (
    queue.entries.some((item) => item.injection) ||
    countPendingQueueItems(queue.items, queue.inFlight) <= queue.cap
  ) {
    return;
  }
  // These sources already belong to the queue; cap reconciliation must not
  // reacquire their admission or lose later input to a stale source's authority.
  const items = queue.items;
  for (const item of items) {
    if (item.controllerInput && !queue.inFlight.has(item)) {
      item.controllerInput.payload = "unbound";
    }
  }
  for (const item of items) {
    if (queue.inFlight.has(item) || applyFollowupQueueOverflow(queue, item)) {
      if (item.controllerInput) {
        item.controllerInput.payload = "ready";
      }
    }
  }
}

type MailboxSteerReservation = {
  admit: () => Promise<"steer" | "fallback" | "cancelled">;
  accepted: (accepted: boolean) => void;
  /** The runtime proved removal before delivery; a following fallback replays the input. */
  withdraw: () => void;
  /** Native outcome settled without consumption, or no native handoff occurred. */
  fallback: () => void;
  /** Native outcome settled; accepted/uncertain input must never be replayed. */
  consume: (disposition?: "consumed") => void;
};

export function reserveSteerCandidate(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  runFollowup: (run: FollowupRun) => Promise<void>,
): MailboxSteerReservation | undefined {
  if (
    !enqueueFollowupRun(key, run, settings, "message-id", runFollowup, false, {
      steerCandidate: true,
    })
  ) {
    return undefined;
  }
  const input = run.controllerInput!;
  const queue = input.mailbox;
  const injection = beginSessionControllerSourceInjection(input);
  const receipt = input.injection;
  if (!receipt) {
    reapplyDeferredOverflow(queue);
    queue.dispatchEnabled = true;
    queue.wake();
    return undefined;
  }
  const finish = (consume: boolean, disposition?: "consumed") => {
    if (input.injection !== receipt) {
      return;
    }
    // Preserve cap reconciliation before the canonical finish can wake selection.
    // The queue adapts payload/custody only; the controller alone settles the receipt.
    const wasClearing = queue.clearing;
    queue.clearing = true;
    try {
      if (consume || receipt.accepted === true) {
        input.payload = "unbound";
        delete run.protectFromQueueOverflow;
        completeFollowupRunLifecycle(run, receipt.accepted === true ? "consumed" : disposition);
      }
      if (!consume && receipt.accepted !== true) {
        // A settled negative handoff explicitly requests queued execution. Merely
        // remembering the steering callback must leave the mailbox dormant.
        queue.dispatchEnabled = true;
      }
      injection.finish(consume);
      reapplyDeferredOverflow(queue);
    } finally {
      queue.clearing = wasClearing;
      queue.wake();
    }
  };
  logMessageQueuedWithBacklogPolicy(
    {
      sessionId: run.run.sessionId,
      sessionKey: key,
      channel: run.originatingChannel ?? run.run.messageProvider,
      source: "followup-queue-steer",
    },
    false,
  );
  return {
    async admit() {
      // Legacy channel signals are carried by FollowupRun, while early RPC
      // sources already compose cancellation into input.abortSignal. Race only
      // pre-handoff admission; a native outcome must never be raced with abort.
      try {
        const admitted = await racePromiseWithAbortSignal(
          injection.admit(),
          resolveFollowupAbortSignal(run),
        );
        if (!admitted) {
          return "cancelled";
        }
        if (isFollowupRunAborted(run) || input.abortSignal.aborted || input.retirementRequested) {
          finish(true);
          return "cancelled";
        }
        run.operatorAuthority?.assertCurrent();
        return "steer";
      } catch (error) {
        const cancelled = isFollowupRunAborted(run) || input.abortSignal.aborted;
        // Failed original execution authority is cancellation, not a new
        // runnable fallback. No native handoff has occurred in this frame.
        finish(true);
        if (cancelled) {
          return "cancelled";
        }
        throw error;
      }
    },
    accepted: (accepted) => injection.accepted(accepted),
    withdraw: () => injection.withdraw(),
    fallback: () => finish(false),
    consume: (disposition) => finish(true, disposition),
  };
}
