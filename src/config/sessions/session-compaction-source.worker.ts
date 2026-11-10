import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { getMessageFromEntryForCompaction } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import {
  prepareCompactionFromSource,
  compactWithoutSummary,
  type CompactionAgentMessageSource,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  createConversationSerializationIndex,
  serializeConversationSourceWithinBudget,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import {
  prepareCompactionSafeguardSource,
  type SafeguardMessageFacts,
  type SafeguardMessageSource,
} from "../../agents/agent-hooks/compaction-safeguard-source.js";
import { SAFETY_MARGIN, sanitizeCompactionMessages } from "../../agents/compaction-planning.js";
import { createRealConversationClassifier } from "../../agents/compaction-real-conversation.js";
import {
  assertCompactionRequestCanFit,
  resolveCompactionRetentionBudget,
  estimateCompactionHistoryTokens,
  estimateCompactedRequestTokens,
} from "../../agents/sessions/compaction/request-budget.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import {
  prepareTranscriptContextSnapshot,
  prepareTranscriptEntryReader,
  validateSessionTranscriptContextInDatabase,
} from "./session-accessor.sqlite-model-context.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { fitBackgroundResultDependencies } from "./session-background-result-dependencies.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { createSessionCompactionEntrySource } from "./session-compaction-entry-source.js";
import type {
  SessionCompactionPlanRequest,
  SessionCompactionSerializeRequest,
  SessionCompactionSourceEntries,
  SessionCompactionSourceRequest,
  SessionCompactionSourceReply,
} from "./session-compaction-source.types.js";

export async function runSessionCompactionSource(
  request: SessionCompactionSourceRequest,
  control: WorkerTaskControl,
): Promise<{ kind: "compaction-source"; reply: SessionCompactionSourceReply }> {
  return control.runNativeSection(() => {
    // Tasks are synchronous, so they borrow the worker's retained reader connection.
    const read = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteReadSnapshotSync(
          database.db,
          () => {
            if (request.expectedIdentity) {
              assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
            }
            return request.phase === "serialize"
              ? serializeCompactionSource(database, request, control)
              : planCompactionSource(database, request, control);
          },
          { operationLabel: "session compaction source read" },
        ),
      toDatabaseOptions(request.resolvedScope),
    );
    if (!read.found) {
      throw new Error("Compaction transcript is unavailable");
    }
    return { kind: "compaction-source", reply: read.value };
  });
}

/** Render one input from the plan's rows; appended turns are never mixed into it. */
function serializeCompactionSource(
  database: OpenClawAgentReadOnlyDatabase,
  request: SessionCompactionSerializeRequest,
  control: WorkerTaskControl,
): SessionCompactionSourceReply {
  // The existing detached-context check accepts only path-preserving appends.
  validateSessionTranscriptContextInDatabase(
    database,
    request.resolvedScope,
    { version: request.version },
    "prefix",
  );
  const readEntry = prepareTranscriptEntryReader(database, request.resolvedScope);
  const { seqs, facts } = request.entries;
  const index = createConversationSerializationIndex({
    length: seqs.length,
    get(position) {
      control.throwIfCancelled();
      const seq = seqs[position];
      const message =
        seq === undefined ? undefined : getMessageFromEntryForCompaction(readEntry(seq));
      return message ? convertToLlm(sanitizeCompactionMessages([message]))[0] : undefined;
    },
  });
  for (const [position, fact] of facts.entries()) {
    index.appendPrepared(position, fact);
  }
  return {
    kind: "serialized",
    conversation: serializeConversationSourceWithinBudget(index.source, request.maxChars),
  };
}

function planCompactionSource(
  database: OpenClawAgentReadOnlyDatabase,
  request: SessionCompactionPlanRequest,
  control: WorkerTaskControl,
): SessionCompactionSourceReply {
  assertSessionTranscriptHot(database.db, request.target.sessionId);
  const transcript = prepareTranscriptContextSnapshot(database, request.resolvedScope);
  const { source, context, getFacts } = createSessionCompactionEntrySource(
    transcript,
    request.requestBudget,
  );
  const requestBudget = request.requestBudget;
  const pendingKey = requestBudget?.pendingTokens
    ? requestBudget.pendingUserIdempotencyKey
    : undefined;
  let pendingEntryId: string | undefined;
  if (request.pendingUserEntryId || pendingKey) {
    for (let index = source.length - 1; index >= 0; index--) {
      const navigation = source.metadata(index);
      if (navigation?.type !== "message" || navigation.message.role !== "user") {
        continue;
      }
      const entry = source.get(index);
      if (
        entry?.type === "message" &&
        entry.message.role === "user" &&
        (request.pendingUserEntryId
          ? entry.id === request.pendingUserEntryId
          : "idempotencyKey" in entry.message && entry.message.idempotencyKey === pendingKey)
      ) {
        pendingEntryId = entry.id;
        break;
      }
    }
  }
  if (request.pendingUserEntryId && !pendingEntryId) {
    throw new Error("Compaction cannot find the admitted pending user request.");
  }
  assertCompactionRequestCanFit(context.messages(), requestBudget, true);
  const retention = requestBudget
    ? resolveCompactionRetentionBudget(
        requestBudget,
        context.messages(),
        request.settings.maxSummaryChars,
      )
    : undefined;
  const requestTokenLimit =
    requestBudget && retention
      ? requestBudget.fixedTokens + requestBudget.pendingTokens + retention.maxTokens
      : undefined;
  const requestEntryId = request.requestFromEntryId ?? pendingEntryId;
  const constraints = {
    ...(requestEntryId
      ? {
          requestBoundary: {
            entryId: requestEntryId,
            preserve: requestEntryId === pendingEntryId,
          },
        }
      : {}),
    ...(retention
      ? {
          budget: {
            ...retention,
            estimateTokens: (message: import("../../agents/runtime/index.js").AgentMessage) =>
              estimateCompactionHistoryTokens([message], requestBudget),
          },
        }
      : {}),
  };
  let hasRealConversation = false;
  // The planner already consumes the canonical context; record hook facts in that pass.
  const measuredContext = {
    ...context,
    *messages() {
      hasRealConversation = false;
      const classify = createRealConversationClassifier();
      for (const message of context.messages()) {
        control.throwIfCancelled();
        hasRealConversation = classify(message) || hasRealConversation;
        yield message;
      }
    },
  };
  let planned = prepareCompactionFromSource(
    source,
    measuredContext,
    request.settings,
    pendingKey && !pendingEntryId ? undefined : request.requestState,
    constraints,
  );
  if (request.manual && !request.requestState && !pendingEntryId && planned.ok && !planned.value) {
    planned = prepareCompactionFromSource(
      source,
      measuredContext,
      {
        ...request.settings,
        keepRecentTokens: 0,
      },
      undefined,
      constraints,
    );
  }
  if (!planned.ok) {
    throw planned.error;
  }
  if (!planned.value) {
    const reason =
      source.get(source.length - 1)?.type === "compaction"
        ? "Already compacted"
        : "Nothing to compact (session too small)";
    if (request.manual) {
      throw new Error(reason);
    }
    assertCompactionRequestCanFit(context.messages(), requestBudget, false);
    return { kind: "skipped", reason };
  }
  const preparation = planned.value;
  const cut = transcript.entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
  // The cut is semantic, not a byte cap: retained placements still own earlier payloads.
  const candidates = transcript.entries.map((event, seq) => ({
    seq,
    event,
    serialized_bytes: 0,
  }));
  const retained = fitBackgroundResultDependencies(candidates.slice(cut), candidates, 0).rows.map(
    ({ seq }) => transcript.readEntry(transcript.entries[seq]!),
  );
  const seqById = new Map(transcript.entries.map(({ id, seq }) => [id, seq]));
  // Every derived input selects facts through these wrappers, so this names each fact's row.
  const seqByFacts = new Map<SafeguardMessageFacts, number>();
  const messageSource = (messages: CompactionAgentMessageSource): SafeguardMessageSource => ({
    length: messages.length,
    get: (index) => messages.get(index),
    facts(index) {
      const id = messages.entryId(index);
      const facts = getFacts(id)?.safeguard;
      const seq = id === undefined ? undefined : seqById.get(id);
      if (facts && seq !== undefined) {
        seqByFacts.set(facts, seq);
      }
      return facts;
    },
  });
  const history = messageSource(preparation.messagesToSummarize);
  const turnPrefix = messageSource(preparation.turnPrefixMessages);
  const safeguard = prepareCompactionSafeguardSource({
    history,
    turnPrefix,
    // A prior summary can anchor tool-only work even when it precedes the new cut.
    currentContextHasRealConversation: hasRealConversation,
    maxSummaryChars: request.settings.maxSummaryChars,
    isSplitTurn: preparation.isSplitTurn,
    previousSummary: preparation.previousSummary,
    requestSelection: preparation.requestSelection,
    latestUnresolvedUserRequest: preparation.latestUnresolvedUserRequest,
    ...request.safeguard,
  });
  if (requestBudget && requestTokenLimit !== undefined) {
    const replacement = buildSessionContext([
      ...retained,
      {
        type: "compaction",
        id: "compaction-planning",
        parentId: retained.at(-1)?.id ?? null,
        timestamp: new Date(0).toISOString(),
        summary: "",
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
      },
    ]).messages;
    preparation.summaryTokenBudget =
      Math.floor(
        (requestTokenLimit - estimateCompactedRequestTokens(replacement, requestBudget)) /
          SAFETY_MARGIN,
      ) - 1;
  }
  const fallback = compactWithoutSummary(preparation);
  const {
    messagesToSummarize,
    turnPrefixMessages,
    turnPrefixSourceAskIndex: _sourceAskIndex,
    totalEstimatedTokens: estimatedTokens,
    messageCount,
    ...metadata
  } = preparation;
  const {
    history: _history,
    turnPrefix: _turnPrefix,
    reconciliation,
    ...safeguardFacts
  } = safeguard;
  // Rendering later rereads only selected rows, so each input keeps row identities and
  // payload-free facts; the summary request never waits on this snapshot.
  const describe = (messages: SafeguardMessageSource): SessionCompactionSourceEntries => {
    const entries: SessionCompactionSourceEntries = { seqs: [], facts: [] };
    for (let position = 0; position < messages.length; position++) {
      control.throwIfCancelled();
      const facts = messages.facts(position);
      if (!facts?.serialization) {
        continue;
      }
      const seq = seqByFacts.get(facts);
      if (seq === undefined) {
        throw new Error("Compaction source fact has no transcript row");
      }
      entries.seqs.push(seq);
      entries.facts.push(facts.serialization);
    }
    return entries;
  };
  return {
    kind: "prepared",
    plan: {
      header: transcript.header,
      retained,
      version: transcript.version,
      facts: {
        preparation: metadata,
        requestTokenLimit,
        historyCount: messagesToSummarize.length,
        turnPrefixCount: turnPrefixMessages.length,
        reconciliationCount: reconciliation.length,
        messageCount,
        estimatedTokens,
        hasRealConversation,
        safeguard: safeguardFacts,
        ...(fallback.ok ? { fallback: fallback.value } : { fallbackError: fallback.error.message }),
      },
    },
    sources: {
      history: describe(history),
      turnPrefix: describe(turnPrefix),
      reconciliation: describe(reconciliation),
    },
  };
}
