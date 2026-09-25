import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  sqliteSessionEntriesEqual,
  assertLifecycleTargetSnapshotUnchanged,
  type SqliteLifecycleTargetSnapshot,
} from "../../config/sessions/session-accessor.sqlite-entry-equality.js";
import {
  applySessionEntryCanonicalReplacements,
  type SessionEntryCanonicalReplacement,
} from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { SessionLabelOwnerIndex } from "../../config/sessions/session-entry-selection.js";
import { parseSessionLabel } from "../../sessions/session-label.js";
import { isSessionStatusModelPatchOrigin } from "../session-model-patch-origin.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import type { SessionPatchCatalogResult } from "./sessions-patch-catalog-preparation.js";
import type { SessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import type {
  MutationOutcome,
  GroupAdmissionResult,
  GroupMutationOperation,
} from "./sessions-patch-types.js";

/** Select the canonical replacement and report no-op status selections without touching activity. */
export function prepareSessionPatchReplacement(params: {
  existingEntry: SessionEntry | undefined;
  projectedEntry: SessionEntry;
  primaryKey: string;
  canonicalKey: string;
  candidateKeys: string[];
  workingStore: Record<string, SessionEntry>;
  labelOwners: SessionLabelOwnerIndex;
  assertCurrent: () => void;
}): {
  replacement?: SessionEntryCanonicalReplacement;
  outcome: Extract<MutationOutcome, { ok: true }>;
} {
  const previousSessionKeys = params.candidateKeys.filter(
    (sessionKey) => sessionKey !== params.primaryKey && params.workingStore[sessionKey],
  );
  if (
    isSessionStatusModelPatchOrigin() &&
    params.existingEntry &&
    previousSessionKeys.length === 0 &&
    sqliteSessionEntriesEqual(params.existingEntry, {
      ...params.projectedEntry,
      updatedAt: params.existingEntry.updatedAt,
    })
  ) {
    params.assertCurrent();
    return {
      outcome: {
        ok: true,
        applied: false,
        accessChanged: false,
        entry: params.existingEntry,
      },
    };
  }
  return {
    replacement: {
      entry: params.projectedEntry,
      previousSessionKeys,
      sessionKey: params.primaryKey,
    },
    outcome: {
      ok: true,
      applied: true,
      accessChanged:
        params.primaryKey !== params.canonicalKey ||
        previousSessionKeys.length > 0 ||
        // Revisionless mutations retain conservative access invalidation.
        !params.existingEntry?.lifecycleRevision?.trim() ||
        hasSessionReadAccessChanged(params.existingEntry, params.projectedEntry),
      entry: params.labelOwners.replaceEntry(
        params.candidateKeys,
        params.primaryKey,
        params.projectedEntry,
      ),
    },
  };
}

/** Keep ordinary projection in one writer admission; detached preparation must revalidate its snapshot. */
export function createSessionPatchGroupWriter(params: {
  store: Omit<
    Parameters<typeof applySessionEntryCanonicalReplacements<GroupAdmissionResult>>[0],
    "update"
  > & { sessionKeys: string[] };
  patch: Pick<SessionsPatchParams, "agentRuntime" | "archived" | "label">;
  project: (
    entries: SqliteLifecycleTargetSnapshot,
    admission: "admitted" | "detached",
    catalog?: SessionPatchCatalogResult,
  ) => Promise<GroupMutationOperation>;
  timing: ReturnType<SessionPatchDiagnostics["scope"]>;
}) {
  const requestedLabel = parseSessionLabel(params.patch.label);
  const store = {
    ...params.store,
    ...(requestedLabel.ok ? { includeLabelOwners: requestedLabel.label } : {}),
  };
  const targetKeys = new Set(store.sessionKeys);
  return async (catalog?: SessionPatchCatalogResult): Promise<GroupAdmissionResult> => {
    params.timing?.mark("snapshot");
    const admitted = await applySessionEntryCanonicalReplacements<GroupAdmissionResult>({
      ...store,
      update: (entries) => {
        const needsExternalPreparation =
          typeof params.patch.agentRuntime === "string" ||
          (typeof params.patch.archived === "boolean" &&
            entries.some(({ sessionKey, entry }) => targetKeys.has(sessionKey) && entry.worktree));
        if (needsExternalPreparation) {
          return { result: { kind: "detached", snapshot: entries } };
        }
        // Ordinary metadata reads, projection and commit share admission;
        // an active run must not slip between two writer acquisitions.
        params.timing?.mark("projection");
        return params.project(entries, "admitted", catalog).then((operation) => {
          params.timing?.mark("commit");
          return operation;
        });
      },
    });
    if (admitted.kind !== "detached") {
      return admitted;
    }
    params.timing?.mark("projection");
    const operation = await params.project(admitted.snapshot, "detached", catalog);
    params.timing?.mark("commit");
    return operation.replacements?.length
      ? await applySessionEntryCanonicalReplacements({
          ...store,
          update: (entries) => {
            // External preparation owns detached rows, not permission to
            // overwrite a changed target, alias, or requested-label owner.
            assertLifecycleTargetSnapshotUnchanged(admitted.snapshot, entries, "session patch");
            return operation;
          },
        })
      : operation.result;
  };
}
