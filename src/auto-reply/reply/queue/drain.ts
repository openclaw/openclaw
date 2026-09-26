import { createHash } from "node:crypto";
import type { HumanMention } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MediaImageLayout } from "../../../agents/embedded-agent-runner/run/prompt-image-metadata.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../../agents/harness/hook-helpers.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../../../agents/prepared-model-runtime-generation-scope.js";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
// Drains queued follow-up runs while preserving route and session identity.
import {
  channelRouteCompactKey,
  channelRouteDedupeKey,
} from "../../../plugin-sdk/channel-route.js";
import {
  getGatewayRestartDrainSignal,
  isGatewayRestartDrainError,
  runWithGatewayDetachedWorkContinuation,
  waitForGatewayRestartFenceSettlement,
} from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  buildPersistedUserTurnMediaInputsFromFields,
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
} from "../../../sessions/user-turn-transcript.js";
import { extractTextFromChatContent } from "../../../shared/chat-content.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import {
  buildCollectPrompt,
  beginQueueDrain,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  removeQueuedItemsByRef,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../../../utils/queue-helpers.js";
import { isRoutableChannel } from "../route-reply.js";
import { resolveCollectedRun } from "./collected-run.js";
import {
  collectRuntimeMetadata,
  createOverflowSummaryRetrySource,
  hasExclusiveTurnAdmission,
  hasPreparedCurrentTurnImages,
  resolveFollowupDeliveryContextKey,
  resolveFollowupReplyAnchor,
} from "./delivery-context.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  retireFollowupRunCancellation,
} from "./lifecycle.js";
import {
  clearFollowupQueue,
  FOLLOWUP_QUEUES,
  followupQueueSources,
  trimSummaryElisionsToCap,
} from "./state.js";
import { consumeQueueSummaryDelivery } from "./summary-consumption.js";
import { isFollowupRunAborted, isFollowupRunDeferredError, type FollowupRun } from "./types.js";

type InternalFollowupRun = FollowupRun & {
  /** Keep admission state out of the public plugin-facing FollowupRun contract. */
  currentTurnImagesPrepared?: true;
  /** Admission-owned layout; fact indexes are relative to this run's media array. */
  mediaImageLayout?: MediaImageLayout;
};

// Persists the most recent runFollowup callback per queue key so that
// enqueueFollowupRun can restart a drain that finished and deleted the queue.
const FOLLOWUP_DRAIN_CALLBACKS_KEY = Symbol.for("openclaw.followupDrainCallbacks");

const FOLLOWUP_RUN_CALLBACKS = resolveGlobalMap<string, (run: FollowupRun) => Promise<void>>(
  FOLLOWUP_DRAIN_CALLBACKS_KEY,
);
let followedRestartDrainSignal: AbortSignal | undefined;

function bindFollowupRestartDrainSignal(): void {
  const signal = getGatewayRestartDrainSignal();
  if (signal === followedRestartDrainSignal) {
    return;
  }
  followedRestartDrainSignal = signal;
  signal.addEventListener(
    "abort",
    () => {
      // Durable input recovery owns restart replay. Retire process-local queue
      // authority synchronously so it cannot keep the old Gateway alive.
      for (const key of FOLLOWUP_RUN_CALLBACKS.keys()) {
        clearFollowupQueue(key);
      }
      FOLLOWUP_RUN_CALLBACKS.clear();
    },
    { once: true },
  );
}

function assertSingleAdmissionOwner(items: readonly FollowupRun[]): void {
  const owners = new Set(
    items.flatMap((item) =>
      hasExclusiveTurnAdmission(item.turnAdoptionLifecycle) ? [item.turnAdoptionLifecycle] : [],
    ),
  );
  if (owners.size > 1) {
    throw new Error("followup queue cannot aggregate distinct admission lifecycles");
  }
}

export function rememberFollowupDrainCallback(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  bindFollowupRestartDrainSignal();
  FOLLOWUP_RUN_CALLBACKS.set(key, runFollowup);
}

export function clearFollowupDrainCallback(key: string): void {
  FOLLOWUP_RUN_CALLBACKS.delete(key);
}

/** Restart the drain for `key` if it is currently idle, using the stored callback. */
export function kickFollowupDrainIfIdle(key: string): void {
  const cb = FOLLOWUP_RUN_CALLBACKS.get(key);
  if (!cb) {
    return;
  }
  scheduleFollowupDrain(key, cb);
}

type FollowupQueueState = NonNullable<ReturnType<typeof FOLLOWUP_QUEUES.get>>;

/** Capture one exact active drain generation for post-recovery retirement. */
export function prepareStaleFollowupDrainRetirement(key: string): (() => void) | undefined {
  const queue = FOLLOWUP_QUEUES.get(key);
  if (!queue?.draining) {
    return undefined;
  }
  const drainOwner = queue.drainOwner;
  if (!drainOwner) {
    return undefined;
  }
  const activeSources = new Set(queue.inFlight);
  if (activeSources.size === 0) {
    return undefined;
  }
  // Recovery awaits owner cleanup before redeeming this closure. Revalidation
  // prevents an old recovery from fencing a queue that advanced to fresh work.
  return () => {
    if (
      FOLLOWUP_QUEUES.get(key) !== queue ||
      !queue.draining ||
      queue.drainOwner !== drainOwner ||
      activeSources.size !== queue.inFlight.size ||
      ![...activeSources].every((source) => queue.inFlight.has(source))
    ) {
      return;
    }

    // Active identities may already be side-effecting, so remove rather than replay them.
    removeQueuedItemsByRef(queue.items, [...activeSources]);
    const activeSummarySources = [...activeSources].filter((source) =>
      queue.activeSummarySources.has(source),
    );
    consumeQueueSummaryDelivery(
      queue,
      { droppedCount: activeSummarySources.length, sources: activeSummarySources },
      false,
    );
    const replacement = {
      ...queue,
      abortController: new AbortController(),
      items: [...queue.items],
      draining: false,
      drainOwner: undefined,
      inFlight: new Set<FollowupRun>(),
      summaryLines: [...queue.summaryLines],
      summarySources: [...queue.summarySources],
      activeSummarySources: new WeakSet<FollowupRun>(),
      summaryElisions: queue.summaryElisions.map((entry) => ({
        ...entry,
        sources: [...entry.sources],
        summaryLines: [...entry.summaryLines],
        // A late summary delivery must not resolve an old source into pending state.
        sourceRefs: new WeakMap<FollowupRun, FollowupRun>(),
      })),
    };
    for (const source of followupQueueSources(replacement)) {
      source.queueAbortSignal = replacement.abortController.signal;
    }
    const hasPendingWork = replacement.items.length > 0 || replacement.droppedCount > 0;
    if (hasPendingWork) {
      FOLLOWUP_QUEUES.set(key, replacement);
    } else {
      FOLLOWUP_QUEUES.delete(key);
      clearFollowupDrainCallback(key);
    }
    queue.items.length = 0;
    queue.droppedCount = 0;
    queue.summaryLines = [];
    queue.summarySources = [];
    queue.summaryElisions = [];
    queue.evictedSummaryCount = 0;
    queue.abortController.abort();
    for (const source of activeSources) {
      completeFollowupRunLifecycle(source);
    }
    if (hasPendingWork) {
      kickFollowupDrainIfIdle(key);
    }
  };
}

type OriginRoutingMetadata = Pick<
  FollowupRun,
  | "originatingChannel"
  | "originatingTo"
  | "originatingAccountId"
  | "originatingThreadId"
  | "originatingChatId"
  | "originatingReplyToId"
  | "originatingReplyToMode"
  | "originatingChatType"
>;

function resolveOriginRoutingMetadata(items: FollowupRun[]): OriginRoutingMetadata {
  const source =
    items.find((item) => item.originatingChannel && item.originatingTo) ??
    items.find(
      (item) =>
        item.originatingChannel ||
        item.originatingTo ||
        item.originatingAccountId ||
        item.originatingThreadId != null ||
        item.originatingChatId ||
        item.originatingReplyToId ||
        item.originatingReplyToMode ||
        item.originatingChatType,
    );
  if (!source) {
    return {};
  }
  return {
    originatingChannel: source.originatingChannel,
    originatingTo: source.originatingTo,
    originatingAccountId: source.originatingAccountId,
    originatingThreadId: source.originatingThreadId,
    originatingChatId: source.originatingChatId,
    originatingReplyToId: source.originatingReplyToId,
    originatingReplyToMode: source.originatingReplyToMode,
    originatingChatType: source.originatingChatType,
  };
}

function splitCollectItemsByDeliveryContext(items: FollowupRun[]): FollowupRun[][] {
  if (items.length <= 1) {
    return items.length === 0 ? [] : [items];
  }

  const groups: FollowupRun[][] = [];
  let currentKey: string | undefined;

  for (const item of items) {
    const itemKey = resolveFollowupDeliveryContextKey(item);
    const currentGroup = groups.at(-1);
    if (currentGroup && itemKey === currentKey) {
      currentGroup.push(item);
    } else {
      groups.push([item]);
    }
    currentKey = itemKey;
  }
  return groups;
}

function renderCollectItem(item: FollowupRun, idx: number): string {
  return renderCollectItemPrompt(
    item,
    idx,
    resolveCollectedSourceText(
      item.userTurnTranscriptRecorder?.getPendingInputMessage?.(),
      item.prompt,
    ),
  );
}

function resolveCollectedSourceText(
  message: PersistedUserTurnMessage | undefined,
  fallback: string,
): string {
  return message
    ? (extractTextFromChatContent(message.content, {
        normalizeText: (text) => text,
        joinWith: "\n",
      }) ?? "")
    : fallback;
}

function buildCollectItemPrefix(item: FollowupRun, idx: number): string {
  const senderLabel =
    item.run.senderName ?? item.run.senderUsername ?? item.run.senderId ?? item.run.senderE164;
  const senderSuffix = senderLabel ? ` (from ${senderLabel})` : "";
  return `---\nQueued #${idx + 1}${senderSuffix}\n`;
}

function renderCollectItemPrompt(item: FollowupRun, idx: number, prompt: string): string {
  return `${buildCollectItemPrefix(item, idx)}${prompt}`.trim();
}

function collectQueuedPromptMedia(
  items: FollowupRun[],
): Pick<FollowupRun, "images" | "imageOrder" | "media"> &
  Pick<InternalFollowupRun, "currentTurnImagesPrepared" | "mediaImageLayout"> {
  const images: NonNullable<FollowupRun["images"]> = [];
  const imageOrder: NonNullable<FollowupRun["imageOrder"]> = [];
  const media: NonNullable<FollowupRun["media"]> = [];
  const mediaImageSlots: MediaImageLayout["slots"] = [];
  const suppressedFactIndexes: number[] = [];
  const currentTurnImagesPrepared = items.every(hasPreparedCurrentTurnImages);
  for (const item of items) {
    const mediaOffset = media.length;
    const internalItem = item as InternalFollowupRun;
    if (item.images) {
      images.push(...item.images);
    }
    if (item.imageOrder) {
      imageOrder.push(...item.imageOrder);
    }
    if (currentTurnImagesPrepared) {
      const itemSlots: MediaImageLayout["slots"] =
        internalItem.mediaImageLayout?.slots ?? item.imageOrder?.map((kind) => ({ kind })) ?? [];
      mediaImageSlots.push(
        ...itemSlots.map((slot) =>
          slot.factIndex === undefined
            ? { kind: slot.kind }
            : { kind: slot.kind, factIndex: slot.factIndex + mediaOffset },
        ),
      );
      suppressedFactIndexes.push(
        ...(internalItem.mediaImageLayout?.suppressedFactIndexes ?? []).map(
          (factIndex) => factIndex + mediaOffset,
        ),
      );
    }
    if (item.media) {
      media.push(...item.media);
    }
  }
  const mediaImageLayout =
    mediaImageSlots.length > 0 || suppressedFactIndexes.length > 0
      ? { slots: mediaImageSlots, suppressedFactIndexes }
      : undefined;
  return {
    ...(currentTurnImagesPrepared ? { currentTurnImagesPrepared: true as const } : {}),
    ...(currentTurnImagesPrepared || images.length > 0 ? { images } : {}),
    ...(currentTurnImagesPrepared || imageOrder.length > 0 ? { imageOrder } : {}),
    ...(mediaImageLayout ? { mediaImageLayout } : {}),
    ...(media.length > 0 ? { media } : {}),
  };
}

function hasRuntimeOnlyFollowupMetadata(item: FollowupRun): boolean {
  return item.currentInboundEventKind === "room_event" || item.currentInboundAudio === true;
}

function buildCollectTranscriptInput(
  items: FollowupRun[],
  messages?: (PersistedUserTurnMessage | undefined)[],
): { text: string; mentions: HumanMention[] } {
  const title = "[Queued messages while agent was busy]";
  const mentions: HumanMention[] = [];
  let offset = title.length;
  const text = buildCollectPrompt({
    title,
    items,
    renderItem: (item, index) => {
      const message = messages?.[index] ?? item.userTurnTranscriptRecorder?.message;
      // Staging may redact or rewrite a source. Collection must never restore
      // its pre-approval text from the queue's display/runtime projection.
      const sourceText = resolveCollectedSourceText(message, item.transcriptPrompt ?? item.prompt);
      const block = renderCollectItemPrompt(item, index, sourceText);
      const sourceOffset = offset + 2 + buildCollectItemPrefix(item, index).length;
      const sourceEnd = sourceText.trimEnd().length;
      for (const mention of message?.["__openclaw"]?.humanMentions ?? []) {
        if (mention.end <= sourceEnd) {
          mentions.push({
            ...mention,
            start: sourceOffset + mention.start,
            end: sourceOffset + mention.end,
          });
        }
      }
      offset += 2 + block.length;
      return block;
    },
  });
  return { text, mentions };
}

function resolveFollowupTranscriptTarget(source: FollowupRun) {
  const sessionKey = normalizeOptionalString(source.run.sessionKey) ?? source.run.sessionId;
  const storePath = resolveSessionStorePathCore(source.run.config.session?.store, {
    agentId: source.run.agentId,
  });
  const sessionEntry = loadSessionEntryReadOnly({
    storePath,
    sessionKey,
    clone: false,
  });
  return {
    sessionId: sessionEntry?.sessionId ?? source.run.sessionId,
    sessionKey,
    sessionEntry,
    storePath,
    agentId: source.run.agentId,
    cwd: source.run.cwd ?? source.run.workspaceDir,
    config: source.run.config,
  };
}

function createCollectUserTurnTranscriptRecorder(items: FollowupRun[]) {
  const transcriptSources = items.filter((item) => item.userTurnTranscriptRecorder);
  const source = transcriptSources.at(-1);
  if (!source) {
    return undefined;
  }
  const buildInput = async () => {
    const messages = await Promise.all(
      transcriptSources.map(
        async (item) => await item.userTurnTranscriptRecorder?.resolveMessage(),
      ),
    );
    const media = messages.flatMap((message) =>
      buildPersistedUserTurnMediaInputsFromFields(message),
    );
    const timestamp = messages.reduce<number | undefined>((latest, message) => {
      const candidate = message?.timestamp;
      return typeof candidate === "number" && (latest === undefined || candidate > latest)
        ? candidate
        : latest;
    }, undefined);
    const transcriptInput = buildCollectTranscriptInput(transcriptSources, messages);
    const identityHash = createHash("sha256")
      .update(
        JSON.stringify(
          transcriptSources.map((item) => [
            item.messageId ?? "",
            item.enqueuedAt,
            item.transcriptPrompt,
          ]),
        ),
      )
      .digest("hex");
    return {
      ...transcriptInput,
      senderIsOwner: source.run.senderIsOwner,
      provenance: source.run.inputProvenance,
      idempotencyKey: `followup-collect:${source.run.sessionId}:${identityHash}`,
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(media.length === 0 ? {} : { media }),
    };
  };
  const initialTranscriptInput = buildCollectTranscriptInput(transcriptSources);
  return createUserTurnTranscriptRecorder({
    input: {
      ...initialTranscriptInput,
      senderIsOwner: source.run.senderIsOwner,
      provenance: source.run.inputProvenance,
    },
    resolveInput: buildInput,
    pendingInputSources: transcriptSources.flatMap((item) => item.userTurnTranscriptRecorder ?? []),
    target: () => resolveFollowupTranscriptTarget(source),
    errorContext: "collected followup user turn transcript",
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
  });
}

function resolveAggregateOwner(items: readonly FollowupRun[]): FollowupRun | undefined {
  // Keep the latest cancelable source as the aggregate owner even when a
  // later transport-only source has no cancellation identity.
  return (
    items.findLast((item) => item.abortSignal) ??
    items.findLast((item) => item.turnAdoptionLifecycle) ??
    items.at(-1)
  );
}

function requiresIndividualCollectDrain(item: FollowupRun): boolean {
  return (
    // A definitive native rejection can return an already-committed source.
    // Keep its original recorder/event; only unconsumed sources may regroup.
    item.userTurnTranscriptRecorder?.hasPersisted() === true ||
    item.disableCollectBatching === true ||
    item.run.skillWorkshopProposalRevision !== undefined ||
    item.run.skillLibraryAuthoring !== undefined ||
    hasRuntimeOnlyFollowupMetadata(item)
  );
}

type AggregateCancellation = {
  signal?: AbortSignal;
  admit: () => void;
  dispose: () => void;
};

function createAggregateCancellation(items: readonly FollowupRun[]): AggregateCancellation {
  const owner = resolveAggregateOwner(items);
  const sourceSignals = new Map<AbortSignal, Set<FollowupRun>>();
  for (const item of items) {
    if (!item.abortSignal) {
      continue;
    }
    const owners = sourceSignals.get(item.abortSignal) ?? new Set<FollowupRun>();
    owners.add(item);
    sourceSignals.set(item.abortSignal, owners);
  }
  const signals = new Set(sourceSignals.keys());
  if (signals.size === 0) {
    return {
      signal: undefined,
      admit: () => undefined,
      dispose: () => undefined,
    };
  }
  const onlySignal = signals.size === 1 ? signals.values().next().value : undefined;
  const onlySignalOwned =
    onlySignal && owner ? sourceSignals.get(onlySignal)?.has(owner) === true : false;
  if (onlySignal && onlySignalOwned) {
    return {
      signal: onlySignal,
      admit: () => undefined,
      dispose: () => undefined,
    };
  }
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of signals) {
    const abort = () => controller.abort();
    listeners.set(signal, abort);
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  }
  const disposeSignal = (signal: AbortSignal) => {
    const listener = listeners.get(signal);
    if (!listener) {
      return;
    }
    signal.removeEventListener("abort", listener);
    listeners.delete(signal);
  };
  return {
    signal: controller.signal,
    admit: () => {
      // Before admission every source remains independently cancellable. Once
      // atomic, only the latest source owns aggregate client cancellation.
      for (const [signal, sourceOwners] of sourceSignals) {
        if (!owner || !sourceOwners.has(owner)) {
          disposeSignal(signal);
        }
      }
    },
    dispose: () => {
      for (const signal of listeners.keys()) {
        disposeSignal(signal);
      }
    },
  };
}

function resolveQueuedCronCreatorAuthorityUnavailable(
  items: readonly FollowupRun[],
): "queued-local-operator" | undefined {
  return items.some(
    (item) =>
      item.turnAdoptionLifecycle?.cronCreatorAuthorityUnavailable === "queued-local-operator",
  )
    ? "queued-local-operator"
    : undefined;
}

type FollowupQueueSummaryState = Pick<
  FollowupQueueState,
  | "cap"
  | "inFlight"
  | "droppedCount"
  | "summaryLines"
  | "summarySources"
  | "activeSummarySources"
  | "summaryElisions"
  | "evictedSummaryCount"
>;

type QueueSummaryDelivery = {
  prompt: string;
  droppedCount: number;
  sources: FollowupRun[];
};

function resolveQueueSummaryLines(
  queue: Pick<FollowupQueueSummaryState, "summaryLines" | "summarySources">,
  sources: FollowupRun[],
): string[] {
  return sources.map((source) => {
    const sourceIndex = queue.summarySources.indexOf(source);
    return expectDefined(queue.summaryLines[sourceIndex], "summary line for retained source");
  });
}

function releaseQueueSummaryDeliveryForRetry(
  queue: FollowupQueueSummaryState,
  delivery: QueueSummaryDelivery,
): void {
  for (const source of delivery.sources) {
    const sourceIndex = queue.summarySources.indexOf(source);
    if (sourceIndex >= 0) {
      queue.summarySources[sourceIndex] = createOverflowSummaryRetrySource(source);
    }
    if (!source.turnAdoptionLifecycle) {
      completeFollowupRunLifecycle(source);
    }
  }
}

async function runQueueSummaryDelivery(
  queue: FollowupQueueSummaryState,
  delivery: QueueSummaryDelivery,
  run: (params: {
    abortSignal?: AbortSignal;
    onAdmitted?: () => void | Promise<void>;
  }) => Promise<void>,
  protectedSources: FollowupRun[] = delivery.sources,
): Promise<boolean> {
  assertSingleAdmissionOwner(protectedSources);
  const inheritedActiveSources = new Set(
    protectedSources.filter((source) => queue.activeSummarySources.has(source)),
  );
  for (const source of protectedSources) {
    queue.activeSummarySources.add(source);
    queue.inFlight.add(source);
  }
  let admitted = false;
  let deferredBeforeAdmission = false;
  const cancellation = createAggregateCancellation(protectedSources);
  const needsAdmission =
    protectedSources.length > 1 ||
    protectedSources.some((source) => hasExclusiveTurnAdmission(source.turnAdoptionLifecycle));
  const onAdmitted = needsAdmission
    ? async () => {
        if (admitted) {
          return;
        }
        await Promise.all(protectedSources.map((source) => admitFollowupRunLifecycle(source)));
        cancellation.admit();
        admitted = true;
        // A multi-source summary is atomic once it owns the reply lane.
        // Retire sibling ids while the latest source owns aggregate cancel.
        consumeQueueSummaryDelivery(queue, { ...delivery, sources: protectedSources }, false);
        const aggregateOwner = resolveAggregateOwner(protectedSources);
        for (const source of protectedSources) {
          if (source !== aggregateOwner) {
            retireFollowupRunCancellation(source);
          }
        }
      }
    : undefined;
  try {
    try {
      await run({ abortSignal: cancellation.signal, onAdmitted });
    } catch (err) {
      if (!admitted) {
        deferredBeforeAdmission = isFollowupRunDeferredError(err);
        if (!deferredBeforeAdmission) {
          releaseQueueSummaryDeliveryForRetry(queue, delivery);
        }
      } else {
        // Admission consumed the aggregate sources, so a failed attempt is
        // terminal for their queue identities rather than retryable queue work.
        for (const source of protectedSources) {
          completeFollowupRunLifecycle(source);
        }
      }
      throw err;
    }
    if (!admitted) {
      const canceledSources = protectedSources.filter(isFollowupRunAborted);
      if (canceledSources.length > 0) {
        consumeQueueSummaryDelivery(queue, {
          ...delivery,
          sources: canceledSources,
        });
        return false;
      }
    }
    if (!admitted) {
      consumeQueueSummaryDelivery(queue, delivery);
    }
    return true;
  } finally {
    cancellation.dispose();
    // Carry one deferred generation across retries. Later retries release newly
    // protected sources so continued overflow cannot grow retained identities.
    const deferredCarryover =
      deferredBeforeAdmission && inheritedActiveSources.size === 0
        ? new Set(protectedSources)
        : inheritedActiveSources;
    for (const source of protectedSources) {
      queue.inFlight.delete(source);
      if (deferredBeforeAdmission && deferredCarryover.has(source)) {
        continue;
      }
      queue.activeSummarySources.delete(source);
      for (const entry of queue.summaryElisions) {
        const compactSource = entry.sourceRefs.get(source);
        if (compactSource) {
          queue.activeSummarySources.delete(compactSource);
        }
      }
    }
    trimSummaryElisionsToCap(queue);
  }
}

export async function dropAbortedFollowups(
  queue: FollowupQueueSummaryState & Pick<FollowupQueueState, "items">,
  runFollowup: (run: FollowupRun) => Promise<void>,
): Promise<number> {
  // Waiting reservations are cancellable; started injections retain custody until their outcome.
  const canDrop = (run: FollowupRun) =>
    run.steerPending?.phase !== "injecting" &&
    isFollowupRunAborted(run) &&
    !queue.inFlight.has(run) &&
    !queue.activeSummarySources.has(run);
  const pending = queue.items.filter(canDrop);
  const summaries = [
    ...queue.summarySources,
    ...queue.summaryElisions.flatMap((entry) => entry.sources),
  ].filter(canDrop);
  // Detach identities and release both dedupe owners before ingress can retry.
  removeQueuedItemsByRef(queue.items, pending);
  consumeQueueSummaryDelivery(queue, { sources: summaries, droppedCount: summaries.length }, false);
  for (const item of [...pending, ...summaries]) {
    try {
      completeFollowupRunLifecycle(item);
    } catch (error) {
      defaultRuntime.error?.(`followup queue cancellation settlement failed: ${String(error)}`);
    }
  }
  await Promise.all(
    pending.map(async (item) => {
      try {
        await runFollowup(item);
      } catch (error) {
        // Aborted work cannot run again; report failed presentation cleanup without restoring it.
        defaultRuntime.error?.(`followup queue cancellation cleanup failed: ${String(error)}`);
      }
    }),
  );
  return pending.length + summaries.length;
}

function resolveCrossChannelKey(item: FollowupRun): { cross?: true; key?: string } {
  const { originatingChannel: channel, originatingTo: to, originatingAccountId: accountId } = item;
  const threadId = item.originatingThreadId;
  const replyToId = resolveFollowupReplyAnchor(item);
  const chatType = normalizeChatType(item.originatingChatType);
  if (
    !channel &&
    !to &&
    !accountId &&
    (threadId == null || threadId === "") &&
    !item.originatingChatId &&
    !replyToId
  ) {
    return chatType ? { key: JSON.stringify(["unresolved", chatType]) } : {};
  }
  if (!isRoutableChannel(channel) || !to) {
    // Internal/local transports (notably webchat) have no external destination.
    // Keep their full route identity so matching turns can collect safely.
    return {
      key: JSON.stringify([
        "local",
        channel ?? "",
        to ?? "",
        accountId ?? "",
        threadId ?? "",
        item.originatingChatId ?? "",
        replyToId ?? "",
        item.originatingReplyToMode ?? "",
        chatType ?? "",
      ]),
    };
  }
  const key = channelRouteCompactKey({ channel, to, accountId, threadId });
  return key
    ? {
        key: JSON.stringify([
          key,
          replyToId ?? "",
          item.originatingReplyToMode ?? "",
          chatType ?? "",
        ]),
      }
    : { cross: true };
}

function resolveOverflowSummarySourceGroup(queue: {
  summarySources: FollowupRun[];
}): FollowupRun[] {
  const source = queue.summarySources[0];
  if (!source) {
    return [];
  }
  const contextKey = resolveFollowupDeliveryContextKey(source);
  const sources: FollowupRun[] = [];
  for (const candidate of queue.summarySources) {
    if (resolveFollowupDeliveryContextKey(candidate) !== contextKey) {
      break;
    }
    sources.push(candidate);
  }
  return sources;
}

async function drainProtectedPriorityFollowup(
  queue: Pick<FollowupQueueState, "inFlight" | "items">,
  runFollowup: (run: FollowupRun) => Promise<void>,
): Promise<boolean> {
  const priority = queue.items.find((item) => item.protectFromQueueOverflow === true);
  if (!priority) {
    return false;
  }
  queue.inFlight.add(priority);
  try {
    await runFollowup(priority);
    removeQueuedItemsByRef(queue.items, [priority]);
  } finally {
    queue.inFlight.delete(priority);
  }
  return true;
}

function resolveOverflowSummaryInboundEventKind(sources: FollowupRun[]): "room_event" | undefined {
  return sources.length > 0 &&
    sources.every((source) => source.currentInboundEventKind === "room_event")
    ? "room_event"
    : undefined;
}

async function runSyntheticOverflowSummary(params: {
  source: FollowupRun;
  sources: FollowupRun[];
  prompt: string;
  abortSignal?: AbortSignal;
  onAdmitted?: () => void | Promise<void>;
  runFollowup: (run: FollowupRun) => Promise<void>;
}): Promise<void> {
  const promptHash = createHash("sha256").update(params.prompt).digest("hex");
  const routeHash = createHash("sha256")
    .update(
      JSON.stringify([
        channelRouteDedupeKey({
          channel: params.source.originatingChannel,
          to: params.source.originatingTo,
          accountId: params.source.originatingAccountId,
          threadId: params.source.originatingThreadId,
        }),
        resolveFollowupReplyAnchor(params.source) ?? "",
        params.source.originatingReplyToMode ?? "",
        normalizeChatType(params.source.originatingChatType) ?? "",
      ]),
    )
    .digest("hex");
  const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
    input: {
      text: params.prompt,
      idempotencyKey: `followup-overflow:${params.source.run.sessionId}:${routeHash}:${params.source.messageId ?? params.source.enqueuedAt}:${promptHash}`,
      senderIsOwner: params.source.run.senderIsOwner,
      provenance: params.source.run.inputProvenance,
    },
    target: () => resolveFollowupTranscriptTarget(params.source),
    pendingInputSources: params.sources.flatMap(
      (source) => source.userTurnTranscriptRecorder ?? [],
    ),
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    errorContext: "followup overflow summary transcript",
  });
  const currentInboundEventKind = resolveOverflowSummaryInboundEventKind(params.sources);
  const runtimeMetadata = collectRuntimeMetadata(params.sources);
  let admitted = false;
  await params.runFollowup({
    prompt: params.prompt,
    sourceTurnId: runtimeMetadata.sourceTurnId,
    queueAbortSignal: params.source.queueAbortSignal,
    transcriptPrompt: params.prompt,
    messageId: params.source.messageId,
    userTurnTranscriptRecorder,
    run: resolveCollectedRun(params.sources, params.source.run),
    enqueuedAt: Date.now(),
    abortSignal: params.abortSignal,
    explicitSkillSelections: runtimeMetadata.explicitSkillSelections,
    channelAdmissionEvidence: runtimeMetadata.channelAdmissionEvidence,
    operatorAuthority: runtimeMetadata.operatorAuthority,
    personalBootstrapEligible: runtimeMetadata.personalBootstrapEligible,
    toolsAllow: runtimeMetadata.toolsAllow,
    disableTools: runtimeMetadata.disableTools,
    queuedFollowupReplyDisposition: runtimeMetadata.queuedFollowupReplyDisposition,
    replyOperationRunStates: runtimeMetadata.replyOperationRunStates,
    ...(params.onAdmitted
      ? {
          turnAdoptionLifecycle: {
            // Synthetic aggregate owner — not a durable exclusive ingress identity.
            admission: "cancel-only" as const,
            ...(resolveQueuedCronCreatorAuthorityUnavailable(params.sources)
              ? { cronCreatorAuthorityUnavailable: "queued-local-operator" as const }
              : {}),
            onAdopted: async () => {
              await params.onAdmitted?.();
              admitted = true;
            },
            onSettled: () => {
              if (admitted) {
                for (const source of params.sources) {
                  completeFollowupRunLifecycle(source);
                }
              }
            },
          },
        }
      : {}),
    ...resolveOriginRoutingMetadata([params.source]),
    ...(currentInboundEventKind ? { currentInboundEventKind } : {}),
  });
}

async function drainElidedOverflowSummary(params: {
  queue: FollowupQueueSummaryState;
  runFollowup: (run: FollowupRun) => Promise<void>;
}): Promise<boolean> {
  const entry = params.queue.summaryElisions[0];
  if (!entry) {
    return false;
  }
  const retainedSources =
    params.queue.summaryElisions.length === 1
      ? resolveOverflowSummarySourceGroup(params.queue).filter(
          (source) => resolveFollowupDeliveryContextKey(source) === entry.contextKey,
        )
      : [];
  const source = retainedSources.at(-1) ?? entry.sources.at(-1);
  if (!source) {
    return false;
  }
  const elidedCount = entry.sources.length;
  const elidedSources = [...entry.sources];
  const droppedCount = elidedCount + retainedSources.length;
  const retainedSummaryLines = resolveQueueSummaryLines(params.queue, retainedSources);
  const summaryLines = [...entry.summaryLines, ...retainedSummaryLines].slice(-params.queue.cap);
  const prompt = previewQueueSummaryPrompt({
    state: {
      droppedCount,
      summaryLines,
    },
    noun: "message",
  });
  if (!prompt) {
    return false;
  }
  const delivered = await runQueueSummaryDelivery(
    params.queue,
    {
      prompt,
      droppedCount: retainedSources.length,
      sources: retainedSources,
    },
    async ({ abortSignal, onAdmitted }) => {
      await runSyntheticOverflowSummary({
        source,
        sources: [...elidedSources, ...retainedSources],
        prompt,
        abortSignal,
        onAdmitted,
        runFollowup: params.runFollowup,
      });
    },
    [...elidedSources, ...retainedSources],
  );
  if (!delivered) {
    return true;
  }
  const entryIndex = params.queue.summaryElisions.indexOf(entry);
  if (entryIndex < 0) {
    return true;
  }
  const consumedCount = Math.min(elidedCount, entry.sources.length);
  const consumedSources = entry.sources.splice(0, consumedCount);
  entry.summaryLines.splice(0, consumedCount);
  entry.count = entry.sources.length;
  for (const consumedSource of consumedSources) {
    completeFollowupRunLifecycle(consumedSource);
  }
  params.queue.droppedCount = Math.max(0, params.queue.droppedCount - consumedCount);
  if (entry.sources.length === 0) {
    params.queue.summaryElisions.splice(entryIndex, 1);
  }
  return true;
}

async function drainOverflowSummaryGroup(params: {
  queue: FollowupQueueState;
  runFollowup: (run: FollowupRun) => Promise<void>;
}): Promise<boolean> {
  if (
    (await dropAbortedFollowups(params.queue, params.runFollowup)) > 0 &&
    params.queue.droppedCount === 0
  ) {
    return true;
  }
  if (params.queue.evictedSummaryCount > 0) {
    const evictedCount = params.queue.evictedSummaryCount;
    params.queue.evictedSummaryCount = 0;
    params.queue.droppedCount = Math.max(0, params.queue.droppedCount - evictedCount);
    defaultRuntime.error?.(
      `followup queue omitted ${evictedCount} route-isolated overflow summar${evictedCount === 1 ? "y" : "ies"} after reaching the summary context cap`,
    );
    return true;
  }
  if (await drainElidedOverflowSummary(params)) {
    return true;
  }
  const sources = resolveOverflowSummarySourceGroup(params.queue);
  const source = sources.at(-1);
  if (!source) {
    return false;
  }
  const prompt = previewQueueSummaryPrompt({
    state: {
      droppedCount: sources.length,
      summaryLines: resolveQueueSummaryLines(params.queue, sources),
    },
    noun: "message",
  });
  if (!prompt) {
    return false;
  }
  const delivery = { prompt, droppedCount: sources.length, sources };
  await runQueueSummaryDelivery(params.queue, delivery, async ({ abortSignal, onAdmitted }) => {
    await runSyntheticOverflowSummary({
      source,
      sources: delivery.sources,
      prompt: delivery.prompt,
      abortSignal,
      onAdmitted,
      runFollowup: params.runFollowup,
    });
  });
  return true;
}

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const existingQueue = FOLLOWUP_QUEUES.get(key);
  if (existingQueue?.draining) {
    // The active drain keeps its current callback, but deferred retries must
    // use the latest session/runtime context supplied by the finishing run.
    rememberFollowupDrainCallback(key, runFollowup);
    return;
  }
  const queue = beginQueueDrain(FOLLOWUP_QUEUES, key);
  if (!queue) {
    return;
  }
  const drainOwner = {};
  queue.drainOwner = drainOwner;
  const effectiveRunFollowup = FOLLOWUP_RUN_CALLBACKS.get(key) ?? runFollowup;
  const reserveOptions = {
    inFlight: queue.inFlight,
    shouldRestoreOnError: () =>
      FOLLOWUP_QUEUES.get(key) === queue && !queue.abortController.signal.aborted,
    onDiscard: (item: FollowupRun) => completeFollowupRunLifecycle(item),
  };
  // Cache callback only when a drain actually starts. Avoid keeping stale
  // callbacks around from finalize calls where no queue work is pending.
  rememberFollowupDrainCallback(key, effectiveRunFollowup);
  const drainQueuedFollowups = async (): Promise<void> => {
    let retryDeferred = false;
    let waitingForSteer = false;
    try {
      const collectState = { forceIndividualCollect: false };
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await dropAbortedFollowups(queue, effectiveRunFollowup);
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        if (queue.items.some((item) => item.steerPending)) {
          waitingForSteer = true;
          break;
        }
        await waitForQueueDebounce(queue, queue.abortController.signal);
        await dropAbortedFollowups(queue, effectiveRunFollowup);
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        if (queue.items.some((item) => item.steerPending)) {
          waitingForSteer = true;
          break;
        }
        if (await drainProtectedPriorityFollowup(queue, effectiveRunFollowup)) {
          continue;
        }
        if (
          queue.droppedCount > 0 &&
          (await drainOverflowSummaryGroup({
            queue,
            runFollowup: effectiveRunFollowup,
          }))
        ) {
          continue;
        }
        if (queue.mode === "collect") {
          // Recheck remaining routes after each individual drain so a later
          // compatible suffix can collect without mixing destinations.
          const isCrossChannel =
            hasCrossChannelItems(queue.items, resolveCrossChannelKey) ||
            queue.items.some(requiresIndividualCollectDrain);
          if (collectState.forceIndividualCollect && !isCrossChannel && queue.items.length > 1) {
            collectState.forceIndividualCollect = false;
          }

          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel,
            items: queue.items,
            run: effectiveRunFollowup,
            reserveOptions,
          });
          if (collectDrainResult === "empty") {
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }

          const items = queue.items.slice();
          const contextGroups = splitCollectItemsByDeliveryContext(items);
          if (contextGroups.length === 0) {
            break;
          }

          for (const groupItems of contextGroups) {
            // Earlier groups await model work. Recheck membership so overflow
            // eviction cannot leave a stale snapshot eligible for delivery.
            const currentGroupItems = groupItems.filter((item) => queue.items.includes(item));
            const abortedGroupItems = currentGroupItems.filter(isFollowupRunAborted);
            if (abortedGroupItems.length > 0) {
              removeQueuedItemsByRef(queue.items, abortedGroupItems);
              for (const item of abortedGroupItems) {
                completeFollowupRunLifecycle(item);
              }
            }
            const activeGroupItems = currentGroupItems.filter(
              (item) => !isFollowupRunAborted(item),
            );
            if (activeGroupItems.length === 0) {
              continue;
            }
            assertSingleAdmissionOwner(activeGroupItems);
            const groupSource = expectDefined(activeGroupItems.at(-1), "active collect source");
            const run = resolveCollectedRun(activeGroupItems, groupSource.run);

            const routing = resolveOriginRoutingMetadata(activeGroupItems);
            const prompt = buildCollectPrompt({
              title: "[Queued messages while agent was busy]",
              items: activeGroupItems,
              renderItem: renderCollectItem,
            });
            const transcriptPrompt = buildCollectTranscriptInput(activeGroupItems).text;
            const userTurnTranscriptRecorder =
              createCollectUserTurnTranscriptRecorder(activeGroupItems);
            const aggregateOwner = resolveAggregateOwner(activeGroupItems);
            const cancellation = createAggregateCancellation(activeGroupItems);
            let admitted = false;
            const restoreGroupItems = (groupItemsToRestore: FollowupRun[]) => {
              const missingItems = groupItemsToRestore.filter(
                (item) => !queue.items.includes(item),
              );
              queue.items.unshift(...missingItems);
            };
            const needsGroupAdmission =
              activeGroupItems.length > 1 ||
              activeGroupItems.some((item) =>
                hasExclusiveTurnAdmission(item.turnAdoptionLifecycle),
              );
            const consumeAdmittedGroup = () => {
              cancellation.admit();
              admitted = true;
              removeQueuedItemsByRef(queue.items, activeGroupItems);
              for (const item of activeGroupItems) {
                if (item !== aggregateOwner) {
                  retireFollowupRunCancellation(item);
                }
              }
            };
            const admitGroupSources = async () => {
              await Promise.all(activeGroupItems.map((item) => admitFollowupRunLifecycle(item)));
              consumeAdmittedGroup();
            };
            const completeGroup = () => {
              removeQueuedItemsByRef(queue.items, activeGroupItems);
              for (const item of activeGroupItems) {
                completeFollowupRunLifecycle(item);
              }
            };
            const drainGroup = async () => {
              await effectiveRunFollowup({
                prompt,
                transcriptPrompt,
                ...(userTurnTranscriptRecorder ? { userTurnTranscriptRecorder } : {}),
                run,
                messageId: groupSource.messageId ?? resolveFollowupReplyAnchor(groupSource),
                enqueuedAt: Date.now(),
                ...routing,
                ...collectRuntimeMetadata(activeGroupItems, cancellation.signal),
                ...(needsGroupAdmission
                  ? {
                      turnAdoptionLifecycle: {
                        // Synthetic aggregate owner — sources keep their own admission.
                        admission: "cancel-only" as const,
                        ...(resolveQueuedCronCreatorAuthorityUnavailable(activeGroupItems)
                          ? { cronCreatorAuthorityUnavailable: "queued-local-operator" as const }
                          : {}),
                        onAdopted: admitGroupSources,
                        onSettled: () => {
                          if (admitted) {
                            completeGroup();
                          }
                        },
                      },
                    }
                  : {}),
                ...collectQueuedPromptMedia(activeGroupItems),
              });
            };
            try {
              // Mark active group items as in-flight so the drop policy does not
              // select them as overflow victims while the group drain is awaited.
              for (const item of activeGroupItems) {
                queue.inFlight.add(item);
              }
              await drainGroup();
            } catch (err) {
              if (admitted) {
                completeGroup();
              } else if (
                FOLLOWUP_QUEUES.get(key) === queue &&
                !queue.abortController.signal.aborted
              ) {
                restoreGroupItems(activeGroupItems);
              } else {
                for (const item of activeGroupItems) {
                  completeFollowupRunLifecycle(item);
                }
              }
              throw err;
            } finally {
              for (const item of activeGroupItems) {
                queue.inFlight.delete(item);
              }
              cancellation.dispose();
            }
            if (!admitted) {
              const canceledSources = activeGroupItems.filter(isFollowupRunAborted);
              if (canceledSources.length > 0) {
                removeQueuedItemsByRef(queue.items, canceledSources);
                for (const item of canceledSources) {
                  completeFollowupRunLifecycle(item);
                }
                const survivors = activeGroupItems.filter(
                  (item) => !canceledSources.includes(item),
                );
                if (FOLLOWUP_QUEUES.get(key) === queue && !queue.abortController.signal.aborted) {
                  restoreGroupItems(survivors);
                  if (survivors.length > 0) {
                    break;
                  }
                } else {
                  for (const item of survivors) {
                    completeFollowupRunLifecycle(item);
                  }
                }
                continue;
              }
            }
            completeGroup();
          }
          continue;
        }

        if (!(await drainNextQueueItem(queue.items, effectiveRunFollowup, reserveOptions))) {
          break;
        }
      }
    } catch (err) {
      queue.lastEnqueuedAt = Date.now();
      if (isFollowupRunDeferredError(err)) {
        retryDeferred = true;
      } else if (isGatewayRestartDrainError(err)) {
        // A reversible signal fence may reopen. One-way abort synchronously
        // retires the queue above; rollback leaves it here for normal retry.
        await waitForGatewayRestartFenceSettlement();
      } else {
        defaultRuntime.error?.(`followup queue drain failed for ${key}: ${String(err)}`);
      }
    } finally {
      // A recovery or explicit clear can replace this generation while its
      // callback is still settling. Only the current owner may reschedule or
      // mutate the key-scoped callback registry.
      if (FOLLOWUP_QUEUES.get(key) === queue) {
        queue.draining = false;
        delete queue.drainOwner;
        const hasPendingQueueWork = queue.items.length > 0 || queue.droppedCount > 0;
        if (waitingForSteer && hasPendingQueueWork) {
          if (!queue.items.some((item) => item.steerPending)) {
            scheduleFollowupDrain(key, effectiveRunFollowup);
          }
        } else if (retryDeferred && hasPendingQueueWork) {
          scheduleFollowupDrain(key, effectiveRunFollowup);
        } else if (!hasPendingQueueWork) {
          FOLLOWUP_QUEUES.delete(key);
          clearFollowupDrainCallback(key);
        } else {
          scheduleFollowupDrain(key, effectiveRunFollowup);
        }
      }
    }
  };
  // Queue drains outlive their enqueue request across debounce and retries.
  // Give the detached chain its own root so inherited request admission cannot go stale.
  // Queued turns re-admit on the generation current at drain time: the detached
  // drain runs outside any ambient prepared-generation scope, so a parked turn
  // never inherits the predecessor run's replaced generation. The drain also owns
  // a fresh async work scope: drained turns run tracked agent work that must keep
  // working after the triggering request's scope has closed.
  void runWithGatewayDetachedWorkContinuation(
    () => runOutsidePreparedModelRuntimePluginGenerationScope(drainQueuedFollowups),
    "session:followup-drain",
  ).catch((err: unknown) => {
    if (FOLLOWUP_QUEUES.get(key) === queue && queue.drainOwner === drainOwner) {
      queue.draining = false;
      delete queue.drainOwner;
    }
    defaultRuntime.error?.(`followup queue drain admission failed for ${key}: ${String(err)}`);
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
