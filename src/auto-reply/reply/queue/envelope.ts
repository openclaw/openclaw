import { createHash } from "node:crypto";
import type { HumanMention } from "@openclaw/gateway-protocol";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MediaImageLayout } from "../../../agents/embedded-agent-runner/run/prompt-image-metadata.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../../agents/harness/hook-helpers.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import {
  buildPersistedUserTurnMediaInputsFromFields,
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
} from "../../../sessions/user-turn-transcript.js";
import { extractTextFromChatContent } from "../../../shared/chat-content.js";
import { buildCollectPrompt } from "../../../utils/queue-helpers.js";
import { hasPreparedCurrentTurnImages } from "./delivery-context.js";
import type { FollowupRun, InternalFollowupRun } from "./types.js";
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

export function resolveOriginRoutingMetadata(items: FollowupRun[]): OriginRoutingMetadata {
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

export function renderCollectItem(item: FollowupRun, idx: number): string {
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

export function collectQueuedPromptMedia(
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
    const internalItem: InternalFollowupRun = item;
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

export function buildCollectTranscriptInput(
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

export async function resolveFollowupTranscriptTarget(source: FollowupRun) {
  const sessionKey = normalizeOptionalString(source.run.sessionKey) ?? source.run.sessionId;
  const storePath = resolveSessionStorePathCore(source.run.config.session?.store, {
    agentId: source.run.agentId,
  });
  const sessionEntry = await readSessionEntryReadOnlyInWorker({
    agentId: source.run.agentId,
    storePath,
    sessionKey,
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

export function createCollectUserTurnTranscriptRecorder(items: FollowupRun[]) {
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
      requesterOrigin: source.run.requesterOrigin,
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
      requesterOrigin: source.run.requesterOrigin,
      provenance: source.run.inputProvenance,
    },
    resolveInput: buildInput,
    pendingInputSources: transcriptSources.flatMap((item) => item.userTurnTranscriptRecorder ?? []),
    target: () => resolveFollowupTranscriptTarget(source),
    errorContext: "collected followup user turn transcript",
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
  });
}

export function resolveAggregateOwner(items: readonly FollowupRun[]): FollowupRun | undefined {
  // Keep the latest cancelable source as the aggregate owner even when a
  // later transport-only source has no cancellation identity.
  return (
    items.findLast((item) => item.abortSignal) ??
    items.findLast((item) => item.turnAdoptionLifecycle) ??
    items.at(-1)
  );
}

export function requiresIndividualCollectDrain(item: FollowupRun): boolean {
  return (
    // A definitive native rejection can return an already-committed source.
    // Keep its original recorder/event; only unconsumed sources may regroup.
    item.userTurnTranscriptRecorder?.hasPersisted() === true ||
    item.disableCollectBatching === true ||
    item.run.skillLibraryAuthoring !== undefined ||
    item.currentInboundEventKind === "room_event" ||
    item.currentInboundAudio === true
  );
}

type AggregateCancellation = {
  signal?: AbortSignal;
  admit: () => void;
  dispose: () => void;
};

export function createAggregateCancellation(items: readonly FollowupRun[]): AggregateCancellation {
  const owner = resolveAggregateOwner(items);
  const sourceSignals = new Map<AbortSignal, Set<FollowupRun>>();
  for (const item of items) {
    if (!item.abortSignal || item.controllerInput?.custody.cancellationRetired) {
      continue;
    }
    const owners = sourceSignals.get(item.abortSignal) ?? new Set<FollowupRun>();
    owners.add(item);
    sourceSignals.set(item.abortSignal, owners);
  }
  const signals = new Set(sourceSignals.keys());
  const onlySignal = signals.size === 1 ? signals.values().next().value : undefined;
  if (signals.size === 0 || (onlySignal && owner && sourceSignals.get(onlySignal)?.has(owner))) {
    return { signal: onlySignal, admit: () => undefined, dispose: () => undefined };
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
