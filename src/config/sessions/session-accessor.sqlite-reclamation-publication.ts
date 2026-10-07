import {
  collectLifecycleIdentityChanges,
  prepareCommittedSessionEntryRemovals,
  publishCommittedSessionIdentity,
} from "./session-accessor.sqlite-identity.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { SessionNativeBindingDeletion } from "./session-native-binding.types.js";
import type { SessionEntry } from "./types.js";

/** Native ownership follows actual removed rows, including maintenance's optimistic skips. */
export function collectReclamationDeletionEntries(
  plan: SessionNativeBindingDeletion["plan"],
  result?: SqliteSessionReclamationResult,
): readonly { sessionKey: string; entry: SessionEntry }[] {
  if (plan.kind === "entry") {
    return result?.kind === "entry" && !result.value.deleted ? [] : plan.preparedTargetSnapshot;
  }
  const entries =
    plan.kind === "lifecycle-projection-commit"
      ? plan.input.projected.removals.filter(
          ({ sessionKey }) =>
            !plan.input.projected.upsertedEntries.some(
              (upsert) => upsert.sessionKey === sessionKey,
            ),
        )
      : result?.kind === "maintenance-finalize"
        ? result.value.committedEntries
        : plan.entries;
  const removed =
    result?.kind === "lifecycle-projection-commit"
      ? new Set(result.value.removedSessionKeys)
      : undefined;
  return entries.flatMap(({ sessionKey, expectedEntry: entry }) =>
    entry && (!removed || removed.has(sessionKey)) ? [{ sessionKey, entry }] : [],
  );
}

export function prepareReclamationPublication(
  plan: SqliteSessionReclamationPlan,
  databaseIdentity: string | symbol,
  result?: SqliteSessionReclamationResult,
): (() => void) | undefined {
  if (plan.kind === "lifecycle-projection-commit" && result?.kind === plan.kind) {
    const { previous, current } = collectLifecycleIdentityChanges(
      plan.input.projected,
      result.value.removedSessionKeys,
    );
    return () => publishCommittedSessionIdentity(plan.agentId, databaseIdentity, previous, current);
  }
  if (plan.kind === "maintenance-finalize" && result?.kind === "maintenance-finalize") {
    return prepareCommittedSessionEntryRemovals(
      plan.agentId,
      databaseIdentity,
      result.value.committedEntries,
    );
  }
  if (plan.kind === "lifecycle-artifacts") {
    return prepareCommittedSessionEntryRemovals(plan.agentId, databaseIdentity, plan.entries);
  }
  return undefined;
}

export function collectReclamationChangedSessionKeys(
  plan: SqliteSessionReclamationPlan,
  result: SqliteSessionReclamationResult,
): string[] {
  switch (result.kind) {
    case "lifecycle-projection-commit":
      return [
        ...result.value.removedSessionKeys,
        ...(plan.kind === "lifecycle-projection-commit"
          ? plan.input.projected.upsertedEntries.map(({ sessionKey }) => sessionKey)
          : []),
        ...result.value.maintenancePlans.flatMap((maintenance) =>
          maintenance.archivedEntries.map(({ sessionKey }) => sessionKey),
        ),
      ];
    case "deletion-plan":
    case "lifecycle-projection-plan":
    case "lifecycle-projection-count":
      return [];
    case "maintenance-plan":
      return result.value.archivedEntries.map(({ sessionKey }) => sessionKey);
    case "maintenance-finalize":
      return result.value.committedEntries.map(({ sessionKey }) => sessionKey);
    case "maintenance-preservation-required":
    case "maintenance-plan-stale":
    case "maintenance-statistics":
    case "maintenance-age":
      return [];
    default:
      return [
        ...plan.materializedPlans.flatMap(({ snapshot }) =>
          snapshot.sessionKey ? [snapshot.sessionKey] : [],
        ),
        ...(plan.kind === "lifecycle-artifacts"
          ? plan.entries.map(({ sessionKey }) => sessionKey)
          : plan.kind === "entry" || plan.kind === "historical-generation"
            ? [plan.deleteParams.target.canonicalKey, ...plan.deleteParams.target.storeKeys]
            : []),
      ];
  }
}
