import type { TurnAdoptionLifecycle } from "../../get-reply-options.types.js";
import { completeFollowupRunLifecycle, retireFollowupRunCancellation } from "./lifecycle.js";
import type { FollowupRun } from "./types.js";

type FollowupRunLike = Pick<FollowupRun, "turnAdoptionLifecycle">;

function resolveQueuedCronCreatorAuthorityUnavailable(
  items: readonly FollowupRunLike[],
): "queued-local-operator" | undefined {
  return items.some(
    (item) =>
      item.turnAdoptionLifecycle?.cronCreatorAuthorityUnavailable === "queued-local-operator",
  )
    ? "queued-local-operator"
    : undefined;
}

/** Builds the synthetic aggregate owner lifecycle for overflow summary drains. */
export function buildOverflowSummaryTurnAdoptionLifecycle(params: {
  sources: readonly FollowupRun[];
  onAdmitted?: () => void | Promise<void>;
  isAdmitted: () => boolean;
  markAdmitted: () => void;
}): TurnAdoptionLifecycle {
  const { sources, onAdmitted, isAdmitted, markAdmitted } = params;
  return {
    // Synthetic aggregate owner — not a durable exclusive ingress identity.
    admission: "cancel-only" as const,
    ...(resolveQueuedCronCreatorAuthorityUnavailable(sources)
      ? { cronCreatorAuthorityUnavailable: "queued-local-operator" as const }
      : {}),
    onAdopted: onAdmitted
      ? async () => {
          await onAdmitted();
          markAdmitted();
        }
      : async () => {},
    onCancellationRetired: () => {
      // The aggregate run is non-abortable once execution freezes; the
      // synthetic owner has no queued entry of its own, so retire the
      // real sources it stands for.
      for (const source of sources) {
        retireFollowupRunCancellation(source);
      }
    },
    onSettled: () => {
      // When onAdmitted exists, sources are only completed after admission
      // succeeds. Without onAdmitted, sources need no admission gate and
      // are completed unconditionally on settlement.
      if (onAdmitted && !isAdmitted()) {
        return;
      }
      for (const source of sources) {
        completeFollowupRunLifecycle(source);
      }
    },
  };
}

/** Builds the synthetic aggregate owner lifecycle for collect group drains. */
export function buildCollectGroupTurnAdoptionLifecycle(params: {
  items: readonly FollowupRun[];
  onAdopted: () => Promise<void>;
  onComplete: () => void;
  isAdmitted: () => boolean;
}): TurnAdoptionLifecycle {
  const { items, onAdopted, onComplete, isAdmitted } = params;
  return {
    // Synthetic aggregate owner — sources keep their own admission.
    admission: "cancel-only" as const,
    ...(resolveQueuedCronCreatorAuthorityUnavailable(items)
      ? { cronCreatorAuthorityUnavailable: "queued-local-operator" as const }
      : {}),
    onAdopted,
    onCancellationRetired: () => {
      for (const item of items) {
        retireFollowupRunCancellation(item);
      }
    },
    onSettled: () => {
      if (isAdmitted()) {
        onComplete();
      }
    },
  };
}
