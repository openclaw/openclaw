import type { GatewaySessionRow } from "../../api/types.ts";
import {
  isSessionDeferredPatch,
  type SessionPatch,
  type SessionPatchOptions,
  type SessionPatchOutcome,
  type SessionPatchRoute,
} from "./patch.ts";
import { projectSessionArchiveFields } from "./session-archive-state.ts";
import { prepareSessionDeferredMutation } from "./session-mutation-operations.ts";
import type { SessionMutationsHost } from "./session-mutations-host.ts";
import {
  type createOptimisticRowField,
  createOptimisticRowPatches,
  type PendingRowTarget,
  resolvePendingConversation,
  resolvePendingRowTarget,
} from "./session-pending-rows.ts";

type MetadataField = "label" | "icon" | "color" | "category";
type MetadataFieldOwner = ReturnType<typeof createOptimisticRowField<MetadataField>>;
type ArchiveOwner = ReturnType<typeof createOptimisticArchivePatches>;
export type SessionPatchPreview = {
  target: PendingRowTarget;
  claims: Array<readonly [Pick<MetadataFieldOwner, "settle"> | ArchiveOwner, symbol | null]>;
};

/** Retiring an unsent intent is part of synchronous queue coalescing. */
export function releaseSessionPatchPreview(preview: SessionPatchPreview) {
  for (const [owner, token] of preview.claims) {
    if (token) {
      owner.settle(preview.target, token, false, true);
    }
  }
}

export function createOptimisticArchivePatches(host: SessionMutationsHost) {
  const fields = [
    "archived",
    "archivedAt",
    "archivedBy",
    "archiveReason",
    "pinned",
    "pinnedAt",
  ] as const;
  return createOptimisticRowPatches(host, {
    read: (row): Pick<GatewaySessionRow, (typeof fields)[number]> =>
      Object.fromEntries(fields.map((field) => [field, row?.[field]])),
    write: (row, next) =>
      fields.every((field) => row[field] === next[field]) ? row : host.copyRow(row, next),
    observe: (previous, row, names) => ({
      ...previous,
      ...Object.fromEntries(
        fields.filter((field) => names.includes(field)).map((field) => [field, row[field]]),
      ),
    }),
  });
}

export function deferSessionPatch(
  host: SessionMutationsHost,
  metadataFields: Record<MetadataField, MetadataFieldOwner>,
  archive: ArchiveOwner,
  patch: SessionPatchRoute,
  key: string,
  patchParams: SessionPatch,
  options: SessionPatchOptions,
): SessionPatchOutcome | null {
  const snapshot = host.snapshot();
  if (
    !isSessionDeferredPatch(patchParams) ||
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
  const preview: SessionPatchPreview = { target, claims: [] };
  const archived = patchParams.archived;
  const archiveClaim = () => {
    if (typeof archived === "boolean") {
      const token = archive.prepare(() => projectSessionArchiveFields(archived))(target);
      if (token) {
        preview.claims.push([archive, token]);
      }
      return token;
    }
    return null;
  };
  const archiveToken = archiveClaim();
  // Install newer tokens before coalescing releases their predecessors.
  for (const field of ["label", "icon", "color", "category"] as const) {
    if (patchParams[field] !== undefined) {
      const owner = metadataFields[field];
      preview.claims.push([
        owner,
        owner.prepare(() => patchParams[field]?.trim() || undefined)(target),
      ]);
    }
  }
  const prepared = prepareSessionDeferredMutation(
    (runtime) => runtime.runSessionDeferredPatch(host, patch, preview, patchParams, options),
    host.connection,
    () => {
      releaseSessionPatchPreview(preview);
      options.onDeferredSettled?.();
    },
  );
  const lifecycle = typeof patchParams.archived === "boolean";
  const lifecycleKey = `sessions.lifecycle:${target.agentId}:${target.key}`;
  if (
    !host.defer({
      key: lifecycle
        ? lifecycleKey
        : `sessions.patch:${target.agentId}:${target.key}:${Object.keys(patchParams).toSorted().join(",")}`,
      group: lifecycleKey,
      preservePosition: lifecycle,
      run: prepared.run,
      discard: prepared.discard,
    })
  ) {
    prepared.discard();
    return null;
  }
  // A superseded delete exposes its retained row during admission.
  if (!archiveToken) {
    archiveClaim();
  }
  return { queued: true };
}
