import { formatUiError } from "../format-error.ts";
import { showToast } from "../toast.ts";
import {
  isSessionDisplayMetadataPatch,
  type SessionPatch,
  type SessionPatchOptions,
  type SessionPatchOutcome,
  type SessionPatchRoute,
} from "./patch.ts";
import type { SessionMutationsHost } from "./session-mutations-host.ts";
import {
  type createOptimisticRowField,
  resolvePendingConversation,
  resolvePendingRowTarget,
} from "./session-pending-rows.ts";

type MetadataField = "label" | "icon" | "color" | "category";
type MetadataFieldOwner = ReturnType<typeof createOptimisticRowField<MetadataField>>;

export function deferSessionMetadataPatch(
  host: SessionMutationsHost,
  metadataFields: Record<MetadataField, MetadataFieldOwner>,
  patch: SessionPatchRoute,
  key: string,
  patchParams: SessionPatch,
  options: SessionPatchOptions,
): SessionPatchOutcome | null {
  const snapshot = host.snapshot();
  if (
    !isSessionDisplayMetadataPatch(patchParams) ||
    (snapshot.phase === "connected" &&
      !snapshot.deferredIntentCount &&
      !snapshot.deferredIntentDraining) ||
    options.waitFor ||
    options.canDispatch?.() === false
  ) {
    return null;
  }
  const target = resolvePendingRowTarget(
    host,
    snapshot,
    resolvePendingConversation(snapshot, key, options.agentId),
    options.expectedSessionId,
  );
  if (!target) {
    return null;
  }
  const claims: Array<readonly [MetadataFieldOwner, symbol | null]> = [];
  const settle = () => {
    for (const [owner, token] of claims) {
      if (token) {
        owner.settle(target, token, false, true);
      }
    }
  };
  // Install the newer field tokens before coalescing releases the previous intent.
  for (const field of ["label", "icon", "color", "category"] as const) {
    if (patchParams[field] !== undefined) {
      const owner = metadataFields[field];
      claims.push([owner, owner.prepare(() => patchParams[field]?.trim() || undefined)(target)]);
    }
  }
  const accepted = host.defer({
    key: `sessions.patch:${target.agentId}:${target.key}:${Object.keys(patchParams).toSorted().join(",")}`,
    run: async () => {
      try {
        const result = await patch(target.key, patchParams, {
          ...options,
          agentId: target.agentId,
          expectedSessionId: target.sessionId,
          // The initiating dialog or batch has already completed, so replay owns refresh.
          deferListRefresh: false,
        });
        const error = host.readState().error;
        if (result === null && error) {
          showToast({ message: error });
        }
      } catch (error) {
        showToast({ message: formatUiError(error) });
      } finally {
        settle();
      }
    },
    discard: settle,
  });
  if (!accepted) {
    settle();
    return null;
  }
  return { queued: true };
}
