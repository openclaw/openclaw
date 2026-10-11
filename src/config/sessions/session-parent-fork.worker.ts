import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { sqliteLifecycleTargetSnapshotsEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  normalizeLifecycleTarget,
  readLifecycleTargetSnapshot,
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { resolveParentForkSourceTranscript } from "./session-accessor.sqlite-parent-fork.js";
import {
  forkSessionEntryInTransaction,
  forkSqliteParentTranscriptInTransaction,
} from "./session-accessor.sqlite-parent-session.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import type {
  ParentForkCandidate,
  ParentForkCommit,
  ParentForkEntryParams,
  ParentForkEntryPreparation,
} from "./session-parent-fork.types.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { mergeSessionEntry } from "./types.js";

export function prepareParentForkEntry(
  params: ParentForkEntryParams,
  { open }: Pick<AgentWorkerOperationContext, "open">,
): ParentForkEntryPreparation {
  const database = open();
  const parentTarget = normalizeLifecycleTarget(params.parentTarget);
  const sessionTarget = normalizeLifecycleTarget(params.sessionTarget);
  return runSqliteReadSnapshotSync(database.db, () => {
    const parent = readLifecycleTargetSnapshot(database, parentTarget);
    const child = readLifecycleTargetSnapshot(database, sessionTarget);
    return {
      parent,
      child,
      parentEntry: parent[0]?.entry,
      base: child[0]?.entry ?? params.fallbackEntry,
    };
  });
}

export function readParentForkSource(
  input: { sessionId: string; forkFrom?: "last-completed" },
  { open }: Pick<AgentWorkerOperationContext, "open">,
) {
  const database = open();
  return resolveParentForkSourceTranscript(
    loadTranscriptEventsFromDatabase(database, input.sessionId),
    input.forkFrom,
  );
}

export function commitParentFork(input: ParentForkCommit, context: AgentWorkerOperationContext) {
  return context.writeTransaction(
    "session.parent-fork.commit",
    "Session parent fork",
    (database) => {
      const sessionKey =
        input.kind === "entry"
          ? normalizeLifecycleTarget(input.params.sessionTarget).canonicalKey
          : normalizeStoreSessionKey(input.params.sessionKey);
      const previous = readSessionIdentitySnapshot(database, [sessionKey]);
      const result = commitParentForkInTransaction(database, input, context.options);
      const candidate: ParentForkCandidate = {
        kind: "session-parent-fork",
        result,
        publication: prepareSessionEntryReplacementPublication(
          {
            previous,
            current: readSessionIdentitySnapshot(database, [sessionKey]),
            pendingArchiveRecovery: false,
            membershipInvalidatedKeys: result.status === "forked" ? [sessionKey] : [],
            maintenancePlans: [],
          },
          database,
        ),
      };
      return transferSessionEntryWorkerCandidate(database, context.admit, candidate);
    },
  );
}

function commitParentForkInTransaction(
  database: OpenClawAgentDatabase,
  input: ParentForkCommit,
  options: AgentWorkerOperationContext["options"],
): ParentForkCandidate["result"] {
  return input.kind === "entry"
    ? commitEntry(database, input, { options })
    : forkSqliteParentTranscriptInTransaction(
        database,
        {
          ...options,
          agentId: input.agentId,
          databaseAgentId: options.agentId,
          sessionKey: input.params.sessionKey,
        },
        {
          ...input.params,
          targetSessionKey: input.params.sessionKey,
          source: input.source,
          parentSessionFile: input.parentSessionFile,
        },
      );
}

function commitEntry(
  database: OpenClawAgentDatabase,
  input: Extract<ParentForkCommit, { kind: "entry" }>,
  context: Pick<AgentWorkerOperationContext, "options">,
): Extract<
  ParentForkCandidate["result"],
  { status: "forked" | "skipped" | "missing-entry" | "missing-parent" | "failed" }
> {
  const { params, prepared, patch } = input;
  const parentTarget = normalizeLifecycleTarget(params.parentTarget);
  const sessionTarget = normalizeLifecycleTarget(params.sessionTarget);
  if (
    !sqliteLifecycleTargetSnapshotsEqual(
      prepared.parent,
      readLifecycleTargetSnapshot(database, parentTarget),
    ) ||
    !sqliteLifecycleTargetSnapshotsEqual(
      prepared.child,
      readLifecycleTargetSnapshot(database, sessionTarget),
    )
  ) {
    return { status: "failed" };
  }
  if (!prepared.parentEntry?.sessionId) {
    return { status: "missing-parent" };
  }
  if (!prepared.base) {
    return { status: "missing-entry" };
  }
  if (patch?.skipExisting && prepared.base.sessionId?.trim()) {
    const sessionEntry = patch.skipped
      ? writeSessionEntry(
          database,
          sessionTarget.canonicalKey,
          preserveSqliteSameKeySessionRolloverLineage({
            next: mergeSessionEntry(prepared.base, patch.skipped),
            previous: prepared.base,
            sessionKey: sessionTarget.canonicalKey,
          }),
          { previousEntry: prepared.base },
        )
      : prepared.base;
    return {
      status: "skipped",
      reason: "existing-entry",
      parentEntry: prepared.parentEntry,
      sessionEntry,
    };
  }
  const forkedPatch = patch?.forked;
  const committed = forkSessionEntryInTransaction(
    database,
    {
      ...context.options,
      agentId: input.agentId,
      databaseAgentId: context.options.agentId,
      sessionKey: sessionTarget.canonicalKey,
    },
    { ...params, patch: forkedPatch ? () => forkedPatch : undefined },
    { parentEntry: prepared.parentEntry, base: prepared.base },
    input.cliSessionBindings,
  );
  return "skip" in committed
    ? {
        status: "skipped",
        reason: "decision-skip",
        parentEntry: committed.skip.parentEntry,
        sessionEntry: committed.skip.base,
        decision: committed.skip.decision,
      }
    : committed.result;
}
