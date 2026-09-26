import { prepareCommittedSessionEntryRemovals } from "./session-accessor.sqlite-identity.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";

export function prepareReclamationPublication(
  plan: SqliteSessionReclamationPlan,
  databaseIdentity: string | symbol,
  result?: SqliteSessionReclamationResult,
): (() => void) | undefined {
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
    case "maintenance-plan":
      return result.value.archivedSessionKeys;
    case "maintenance-finalize":
      return result.value.committedEntries.map(({ sessionKey }) => sessionKey);
    case "maintenance-preservation-required":
    case "maintenance-statistics":
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
