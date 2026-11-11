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
import { adoptPersistedSessionSnapshot } from "../../config/sessions/session-snapshot-merge.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { parseSessionLabel } from "../../sessions/session-label.js";
import { isSessionStatusModelPatchOrigin } from "../session-model-patch-origin.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import type { SessionPatchCatalogResult } from "./sessions-patch-catalog-preparation.js";
import type { SessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import type {
  MutationOutcome,
  GroupAdmissionResult,
  GroupMutationOperation,
  PreparedPatchTarget,
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

const FIELD_PATCH_KEYS = new Set([
  "key",
  "agentId",
  "expectedSessionId",
  "expectedLifecycleRevision",
  "expectedMarkedUnreadAt",
  "unread",
  "fastMode",
]);

function sessionPatchFields(targets: readonly PreparedPatchTarget[]) {
  const patch = targets[0]!.fullPatch;
  if (
    (patch.unread === undefined && patch.fastMode === undefined) ||
    targets.some(
      (target) =>
        !target.initialEntry?.sessionId ||
        isIncognitoSessionKey(target.canonicalKey) ||
        target.initialTarget.storeKeys.some((key) => key !== target.canonicalKey) ||
        Object.keys(target.initialTarget.store).some((key) => key !== target.canonicalKey) ||
        Object.entries(target.fullPatch).some(
          ([key, value]) => value !== undefined && !FIELD_PATCH_KEYS.has(key),
        ),
    )
  ) {
    return undefined;
  }
  const fields: Array<keyof SessionEntry> = ["pinnedAt", "snoozedUntil", "snoozedAt"];
  const guardFields: Array<keyof SessionEntry> = [
    "pluginOwnerId",
    "spawnedBy",
    "parentSessionKey",
    "sidebarRoot",
    "archivedAt",
    ...fields,
  ];
  if (patch.unread !== undefined) {
    fields.push("markedUnreadAt");
    if (!patch.unread) {
      fields.push("lastReadAt", "agentStatus");
    }
    guardFields.push("markedUnreadAt");
  }
  if (patch.fastMode !== undefined) {
    fields.push("fastMode");
  }
  return {
    fields,
    guardFields,
    // A stale conditional acknowledgment returns its read snapshot without committing.
    snapshotFields: targets.some(
      (target) =>
        target.fullPatch.unread === false && target.fullPatch.expectedMarkedUnreadAt !== undefined,
    )
      ? (["sessionDiffBaseline"] as const)
      : undefined,
  };
}

/** Field-only preparation reads committed metadata; replacement preparation retains its writer. */
export function createSessionPatchGroupWriter(params: {
  store: Omit<
    Parameters<typeof applySessionEntryCanonicalReplacements<GroupAdmissionResult>>[0],
    "update"
  > & { sessionKeys: string[] };
  targets: readonly PreparedPatchTarget[];
  project: (
    entries: SqliteLifecycleTargetSnapshot,
    admission: "admitted" | "detached",
    catalog?: SessionPatchCatalogResult,
  ) => Promise<GroupMutationOperation>;
  timing: ReturnType<SessionPatchDiagnostics["scope"]>;
}) {
  const patch = params.targets[0]!.fullPatch;
  const requestedLabel = parseSessionLabel(patch.label);
  const store = {
    ...params.store,
    fieldPatch: sessionPatchFields(params.targets),
    ...(requestedLabel.ok ? { includeLabelOwners: requestedLabel.label } : {}),
  };
  const targetKeys = new Set(store.sessionKeys);
  return async (catalog?: SessionPatchCatalogResult): Promise<GroupAdmissionResult> => {
    params.timing?.mark("snapshot");
    let projected: GroupMutationOperation | undefined;
    const admitted = await applySessionEntryCanonicalReplacements<GroupAdmissionResult>({
      ...store,
      onCommittedEntries: (entries, patchDiffBaselines) => {
        if (!store.fieldPatch) {
          return;
        }
        for (const replacement of projected?.replacements ?? []) {
          const entry = entries.get(replacement.sessionKey);
          if (entry) {
            adoptPersistedSessionSnapshot(replacement.entry, entry);
            const baseline = patchDiffBaselines?.get(replacement.sessionKey);
            if (baseline) {
              replacement.entry.sessionDiffBaseline = baseline;
            }
          }
        }
      },
      update: (entries) => {
        // Archive removal belongs to maintenance; only restore prepares a checkout here.
        const needsExternalPreparation =
          typeof patch.agentRuntime === "string" ||
          typeof patch.model === "string" ||
          typeof patch.nativeRuntimeConsent === "string" ||
          (patch.archived === false &&
            entries.some(({ sessionKey, entry }) => targetKeys.has(sessionKey) && entry.worktree));
        if (needsExternalPreparation) {
          return { result: { kind: "detached", snapshot: entries } };
        }
        // Complete replacements keep admission; field patches validate and merge at commit.
        params.timing?.mark("projection");
        return params.project(entries, "admitted", catalog).then((operation) => {
          projected = operation;
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
