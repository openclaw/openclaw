import type { MediaImageLayout } from "../../../agents/embedded-agent-runner/run/prompt-image-metadata.js";
import { hasPreparedCurrentTurnImages } from "./delivery-context.js";
import type { FollowupRun } from "./types.js";

type InternalFollowupRun = FollowupRun & {
  /** Keep admission state out of the public plugin-facing FollowupRun contract. */
  currentTurnImagesPrepared?: true;
  /** Admission-owned layout; fact indexes are relative to this run's media array. */
  mediaImageLayout?: MediaImageLayout;
};

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
    images.push(...(item.images ?? []));
    imageOrder.push(...(item.imageOrder ?? []));
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
    media.push(...(item.media ?? []));
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
