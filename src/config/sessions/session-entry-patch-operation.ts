import { buildRestartRecoveryClaimCleanupPatch } from "./restart-recovery-state.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { projectCompactionAccountingPatch } from "./session-entry-projection.js";
import {
  projectSessionEntryUsageUpdate,
  type SessionEntryUsageUpdate,
} from "./session-entry-usage.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type InternalSessionEntry as SessionEntry,
} from "./types.js";

type ExpectedSession = Pick<SessionEntry, "sessionId"> &
  Partial<Pick<SessionEntry, "lifecycleRevision" | "activeWriterRunId">>;

/** Closed internal operations; arbitrary updater callbacks retain prepare/CAS. */
export type SessionEntryPatchOperation = (
  | { kind: "fields"; patch: Partial<SessionEntry> }
  | { kind: "usage-accounting"; usage: SessionEntryUsageUpdate }
  | {
      kind: "restart-safe-terminal";
      runId: string;
      retryable: boolean;
      patch: Partial<SessionEntry>;
    }
  | {
      kind: "compaction-accounting";
      accounting: Parameters<typeof projectCompactionAccountingPatch>[1];
    }
) & { expected?: ExpectedSession };

export function reduceSessionEntryPatch(
  operation: SessionEntryPatchOperation,
  entry: SessionEntry,
): Partial<SessionEntry> | null {
  const expected = operation.expected;
  if (
    expected &&
    (entry.sessionId !== expected.sessionId ||
      (Object.hasOwn(expected, "lifecycleRevision") &&
        entry.lifecycleRevision !== expected.lifecycleRevision) ||
      (Object.hasOwn(expected, "activeWriterRunId") &&
        entry.activeWriterRunId !== expected.activeWriterRunId))
  ) {
    return null;
  }
  switch (operation.kind) {
    case "fields":
      return operation.patch;
    case "compaction-accounting":
      return projectCompactionAccountingPatch(entry, operation.accounting);
    case "usage-accounting":
      return projectSessionEntryUsageUpdate(entry, operation.usage);
    case "restart-safe-terminal":
      return entry.restartRecoveryDeliveryRunId === operation.runId
        ? {
            ...operation.patch,
            ...(!operation.retryable
              ? buildRestartRecoveryClaimCleanupPatch({
                  entry,
                  recordTerminalSource: true,
                  terminalSourceRunId: entry.restartRecoveryDeliverySourceRunId,
                })
              : {}),
          }
        : null;
  }
  return operation satisfies never;
}

export function mergeSessionEntryPatch(params: {
  existing: SessionEntry | undefined;
  writeBase: SessionEntry;
  patch: Partial<SessionEntry> | null;
  sessionKey: string;
  replaceEntry?: boolean;
  preserveActivity?: boolean;
}): SessionEntry | undefined {
  const { existing, writeBase, patch, sessionKey } = params;
  // A fallback supplies identity, not an existing node's immutable creation policy.
  const creationPatch = !existing && patch ? { ...writeBase, ...patch } : patch;
  if (!creationPatch) {
    return undefined;
  }
  if (params.replaceEntry) {
    // SAFETY: The existing replaceEntry updater contract supplies a complete entry.
    return structuredClone(patch as SessionEntry);
  }
  const merged = params.preserveActivity
    ? mergeSessionEntryPreserveActivity(existing, creationPatch)
    : mergeSessionEntry(existing, creationPatch);
  return preserveSqliteSameKeySessionRolloverLineage({
    next: merged,
    previous: writeBase,
    sessionKey,
  });
}
