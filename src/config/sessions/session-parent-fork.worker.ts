import { randomUUID } from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import {
  assertModelSelectionUnlocked,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
} from "../../sessions/model-overrides.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { forkCliSessionBindings } from "./cli-session-binding.js";
import type {
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptParams,
  ForkSessionFromParentTranscriptResult,
  SessionParentForkDecision,
} from "./session-accessor.sqlite-contract.js";
import {
  normalizeLifecycleTarget,
  readSessionIdentitySnapshot,
  resolveLifecyclePrimaryEntry,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  buildForkedChildTranscriptEvents,
  estimateParentForkPromptTokens,
  planParentForkDecision,
  resolveParentForkSourceTranscript,
  type ParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import {
  formatLegacySqliteSessionMarkerForScope,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import type {
  ParentForkCandidate,
  ParentForkCommit,
  ParentForkEntryParams,
  ParentForkEntryPreparation,
} from "./session-parent-fork.types.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";
import { mergeSessionEntry } from "./types.js";

export function prepareParentForkEntry(
  params: ParentForkEntryParams,
  { open }: Pick<AgentWorkerOperationContext, "open">,
): ParentForkEntryPreparation {
  const database = open();
  const parentTarget = normalizeLifecycleTarget(params.parentTarget);
  const sessionTarget = normalizeLifecycleTarget(params.sessionTarget);
  return runSqliteReadSnapshotSync(database.db, () => {
    return {
      parentEntry: resolveLifecyclePrimaryEntry(database, parentTarget)?.entry,
      base: resolveLifecyclePrimaryEntry(database, sessionTarget)?.entry ?? params.fallbackEntry,
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

export function commitParentForkInTransaction(
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
  const { params, patch } = input;
  const parentTarget = normalizeLifecycleTarget(params.parentTarget);
  const sessionTarget = normalizeLifecycleTarget(params.sessionTarget);
  const parentEntry = resolveLifecyclePrimaryEntry(database, parentTarget)?.entry;
  const base = resolveLifecyclePrimaryEntry(database, sessionTarget)?.entry ?? params.fallbackEntry;
  if (!parentEntry?.sessionId) {
    return { status: "missing-parent" };
  }
  if (!base) {
    return { status: "missing-entry" };
  }
  if (patch?.skipExisting && base.sessionId?.trim()) {
    const sessionEntry = patch.skipped
      ? writeSessionEntry(
          database,
          sessionTarget.canonicalKey,
          preserveSqliteSameKeySessionRolloverLineage({
            next: mergeSessionEntry(base, patch.skipped),
            previous: base,
            sessionKey: sessionTarget.canonicalKey,
          }),
          { previousEntry: base },
        )
      : base;
    return {
      status: "skipped",
      reason: "existing-entry",
      parentEntry,
      sessionEntry,
    };
  }
  const forkedPatch = patch?.forked;
  const providers = new Set(input.cliForkProviders?.map(normalizeProviderId));
  const committed = forkSessionEntryInTransaction(
    database,
    {
      ...context.options,
      agentId: input.agentId,
      databaseAgentId: context.options.agentId,
      sessionKey: sessionTarget.canonicalKey,
    },
    params,
    { parentEntry, base },
    forkCliSessionBindings(parentEntry, (provider) => providers.has(normalizeProviderId(provider))),
    forkedPatch,
  );
  if (!("skip" in committed)) {
    return committed.result;
  }
  return {
    status: "skipped",
    reason: "decision-skip",
    parentEntry,
    sessionEntry: base,
    decision: committed.skip.decision,
  };
}

function forkSessionEntryInTransaction(
  writeDatabase: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: ParentForkEntryParams,
  prepared: { parentEntry: SessionEntry; base: SessionEntry },
  cliSessionBindings: SessionEntry["cliSessionBindings"],
  patch?: Partial<SessionEntry>,
):
  | { result: ForkSessionEntryFromParentTargetResult }
  | {
      skip: {
        decision: Extract<SessionParentForkDecision, { status: "skip" }>;
        base: SessionEntry;
        parentEntry: SessionEntry;
      };
    } {
  const parentTarget = normalizeLifecycleTarget(params.parentTarget);
  const sessionTarget = normalizeLifecycleTarget(params.sessionTarget);
  const freshParent = prepared.parentEntry;
  const freshBase = prepared.base;
  assertModelSelectionUnlocked(freshParent, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  const source = resolveParentForkSourceTranscript(
    loadTranscriptEventsFromDatabase(writeDatabase, freshParent.sessionId),
  );
  const decision = planParentForkDecision(freshParent, estimateParentForkPromptTokens(source));
  if (decision.status === "skip") {
    return { skip: { decision, base: freshBase, parentEntry: freshParent } };
  }
  const fork = forkSqliteParentTranscriptInTransaction(writeDatabase, resolved, {
    parentEntry: freshParent,
    parentSessionKey: parentTarget.canonicalKey,
    source,
    targetSessionKey: sessionTarget.canonicalKey,
  });
  if (fork.status !== "created") {
    return {
      result:
        fork.status === "missing-parent" ? { status: "missing-parent" } : { status: "failed" },
    };
  }
  const forkIdentityPatch: Partial<InternalSessionEntry> = {
    ...patch,
    forkSource: {
      sessionKey: parentTarget.canonicalKey,
      sessionId: freshParent.sessionId,
    },
    forkedFromParent: true,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    sessionId: fork.transcript.sessionId,
    totalTokens: undefined,
    totalTokensFresh: false,
    totalTokensVersion: undefined,
    cliSessionBindings,
    cliSessionIds: undefined,
    claudeCliSessionId: undefined,
  };
  const next = writeSessionEntry(
    writeDatabase,
    sessionTarget.canonicalKey,
    mergeSessionEntry(freshBase, forkIdentityPatch),
    { previousEntry: freshBase },
  );
  return {
    result: {
      status: "forked",
      decision,
      fork: fork.transcript,
      parentEntry: freshParent,
      sessionEntry: structuredClone(next),
    },
  };
}

function forkSqliteParentTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    enforceTokenLimit?: boolean;
    maxTokens?: number;
    parentEntry: SessionEntry;
    parentSessionKey: string;
    forkFrom?: "last-completed";
    source?: ParentForkSourceTranscript | null;
    parentSessionFile?: string;
    targetSessionId?: string;
    targetSessionKey: string;
  },
): ForkSessionFromParentTranscriptResult {
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const source =
    params.source === undefined
      ? resolveParentForkSourceTranscript(
          loadTranscriptEventsFromDatabase(database, params.parentEntry.sessionId),
          params.forkFrom,
        )
      : params.source;
  if (!source) {
    return { status: "failed" };
  }
  const limitDecision = resolveParentForkLimitDecision(params, source);
  if (limitDecision) {
    return { status: "too-large", decision: limitDecision };
  }
  const sessionId = params.targetSessionId ?? randomUUID();
  const targetScope = {
    ...resolved,
    sessionId,
    sessionKey: normalizeStoreSessionKey(params.targetSessionKey),
  };
  const parentSessionFile =
    params.parentSessionFile ??
    formatLegacySqliteSessionMarkerForScope({
      ...resolved,
      sessionId: params.parentEntry.sessionId,
      sessionKey: normalizeStoreSessionKey(params.parentSessionKey),
    });
  appendTranscriptEventsInTransaction(
    database,
    targetScope,
    buildForkedChildTranscriptEvents({ parentSessionFile, source, targetSessionId: sessionId }),
  );
  return {
    status: "created",
    transcript: {
      sessionFile: targetScope.sessionKey,
      sessionId,
    },
  };
}

function resolveParentForkLimitDecision(
  params: Pick<
    ForkSessionFromParentTranscriptParams,
    "enforceTokenLimit" | "forkFrom" | "maxTokens" | "parentEntry"
  >,
  source: ParentForkSourceTranscript,
): Extract<SessionParentForkDecision, { status: "skip" }> | undefined {
  if (!params.enforceTokenLimit) {
    return undefined;
  }
  const decision = planParentForkDecision(
    params.parentEntry,
    estimateParentForkPromptTokens(source),
    {
      maxTokens: params.maxTokens,
      preferTranscriptEstimate: params.forkFrom === "last-completed",
    },
  );
  return decision.status === "skip" ? decision : undefined;
}
