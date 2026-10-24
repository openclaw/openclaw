import type { MediaUnderstandingAttachmentsConfig } from "../config/types.tools.js";
import { resolveAttachmentKind } from "./attachments.normalize.js";
import type {
  MediaAttachment,
  MediaAttachmentDisposition,
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
} from "./types.js";

const DEFAULT_MAX_ATTACHMENTS = 1;

function orderAttachments(
  attachments: MediaAttachment[],
  prefer?: MediaUnderstandingAttachmentsConfig["prefer"],
): MediaAttachment[] {
  // Ordering is stable and non-mutating so downstream decisions can still cite
  // original attachment indexes.
  if (prefer === "last") {
    return attachments.toReversed();
  }
  if (prefer === "path" || prefer === "url") {
    const preferred: MediaAttachment[] = [];
    const remaining: MediaAttachment[] = [];
    for (const item of attachments) {
      (item[prefer] ? preferred : remaining).push(item);
    }
    return [...preferred, ...remaining];
  }
  return attachments;
}

/** Selects attachments for a media-understanding capability under configured ordering limits. */
export function selectAttachments(params: {
  capability: MediaUnderstandingCapability;
  attachments: MediaAttachment[];
  policy?: MediaUnderstandingAttachmentsConfig;
  previousDecisions?: readonly MediaUnderstandingDecision[];
}): { selected: MediaAttachment[]; droppedAttachmentIndexes: number[] } {
  const { capability, attachments, policy } = params;
  const decidedAudioIndexes = new Set(
    capability === "audio"
      ? (params.previousDecisions ?? []).flatMap((decision) =>
          decision.capability === "audio"
            ? decision.attachments
                .map((attachment) => attachment.attachmentIndex)
                .concat(Object.keys(decision.attachmentDispositions ?? {}).map(Number))
            : [],
        )
      : [],
  );
  const matches = attachments.filter((item) => {
    // Reuse the preflight selection budget, including dropped/failed indexes,
    // without treating those attachments as successfully transcribed.
    if (
      capability === "audio" &&
      (item.alreadyTranscribed || decidedAudioIndexes.has(item.index))
    ) {
      return false;
    }
    return resolveAttachmentKind(item) === capability;
  });
  if (matches.length === 0) {
    return { selected: [], droppedAttachmentIndexes: [] };
  }

  const ordered = orderAttachments(matches, policy?.prefer);
  const mode = policy?.mode ?? "first";
  const maxAttachments = policy?.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
  const limit = mode === "all" ? Math.max(1, maxAttachments) : 1;
  return {
    selected: ordered.slice(0, limit),
    droppedAttachmentIndexes: ordered.slice(limit).map((attachment) => attachment.index),
  };
}

export function createAttachmentDispositions(
  indexes: readonly number[],
  disposition: MediaAttachmentDisposition,
): Record<number, MediaAttachmentDisposition> {
  return Object.fromEntries(indexes.map((index) => [index, disposition]));
}
