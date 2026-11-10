import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import {
  prepareCompactionFromSource,
  compactWithoutSummary,
  estimateTokens,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  createSerializedConversationSource,
  serializeConversationSourceWithinBudget,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import {
  prepareCompactionSafeguardSource,
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
import { beginEngineStoreReadSnapshot } from "../../infra/database-engine/adapters.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { prepareTranscriptContextSnapshot } from "./session-accessor.sqlite-model-context.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { fitBackgroundResultDependencies } from "./session-background-result-dependencies.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { createSessionCompactionEntrySource } from "./session-compaction-entry-source.js";
import type {
  SessionCompactionSourceRequest,
  SessionCompactionSourceReply,
  SessionCompactionSourceCommand,
} from "./session-compaction-source.types.js";

export async function runSessionCompactionSource(
  request: SessionCompactionSourceRequest,
  channel: WorkerTaskChannel,
  control: WorkerTaskControl,
): Promise<{ kind: "compaction-source" }> {
  return control.runNativeSection(async () => {
    const opened = openOpenClawAgentDatabaseReadOnly(toDatabaseOptions(request.resolvedScope));
    if (!opened.found) {
      throw new Error("Compaction transcript is unavailable");
    }
    const { database } = opened;
    const snapshot = beginEngineStoreReadSnapshot(database.db);
    try {
      if (request.expectedIdentity) {
        assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
      }
      assertSessionTranscriptHot(database.db, request.target.sessionId);
      const transcript = prepareTranscriptContextSnapshot(database, request.resolvedScope);
      const { source, context } = createSessionCompactionEntrySource(transcript);
      const requestBudget = request.requestBudget;
      const pendingKey = requestBudget?.pendingTokens
        ? requestBudget.pendingUserIdempotencyKey
        : undefined;
      let pendingEntryId: string | undefined;
      if (request.pendingUserEntryId || pendingKey) {
        for (let index = source.length - 1; index >= 0; index--) {
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
        ? resolveCompactionRetentionBudget(requestBudget, context.messages())
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
      let messageCount = 0;
      let hasRealConversation = false;
      let estimatedTokens = 0;
      // The planner already consumes the canonical context; record hook facts in that pass.
      const measuredContext = {
        ...context,
        *messages() {
          messageCount = 0;
          hasRealConversation = false;
          estimatedTokens = 0;
          const classify = createRealConversationClassifier();
          for (const message of context.messages()) {
            control.throwIfCancelled();
            messageCount++;
            estimatedTokens += estimateTokens(message);
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
      if (
        request.manual &&
        !request.requestState &&
        !requestBudget &&
        !pendingEntryId &&
        planned.ok &&
        !planned.value
      ) {
        planned = prepareCompactionFromSource(source, measuredContext, {
          ...request.settings,
          keepRecentTokens: 0,
        });
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
        const response = await channel.request({
          kind: "skipped",
          reason,
        } satisfies SessionCompactionSourceReply);
        response.consumed();
        return { kind: "compaction-source" };
      }
      const preparation = planned.value;
      const cut = transcript.entries.findIndex(
        (entry) => entry.id === preparation.firstKeptEntryId,
      );
      // The cut is semantic, not a byte cap: retained placements still own earlier payloads.
      const candidates = transcript.entries.map((event, seq) => ({
        seq,
        event,
        serialized_bytes: 0,
      }));
      const retained = fitBackgroundResultDependencies(
        candidates.slice(cut),
        candidates,
        0,
      ).rows.map(({ seq }) => transcript.readEntry(transcript.entries[seq]!));
      const safeguard = prepareCompactionSafeguardSource({
        history: preparation.messagesToSummarize,
        turnPrefix: preparation.turnPrefixMessages,
        // A prior summary can anchor tool-only work even when it precedes the new cut.
        currentContext: () => context.messages(),
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
        ...metadata
      } = preparation;
      const {
        history: _history,
        turnPrefix: _turnPrefix,
        reconciliation,
        ...safeguardFacts
      } = safeguard;
      const sources = {
        history: messagesToSummarize,
        turnPrefix: turnPrefixMessages,
        reconciliation,
      };
      const serializers = new Map<
        SafeguardMessageSource,
        ReturnType<typeof createSerializedConversationSource>
      >();
      const serializer = (name: keyof typeof sources) => {
        const messages: SafeguardMessageSource = sources[name];
        let prepared = serializers.get(messages);
        if (!prepared) {
          prepared = createSerializedConversationSource({
            length: messages.length,
            get(index) {
              control.throwIfCancelled();
              const message = messages.get(index);
              return message ? convertToLlm(sanitizeCompactionMessages([message]))[0] : undefined;
            },
          });
          serializers.set(messages, prepared);
        }
        return prepared;
      };
      let reply: SessionCompactionSourceReply = {
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
            ...(fallback.ok
              ? { fallback: fallback.value }
              : { fallbackError: fallback.error.message }),
          },
        },
      };
      for (;;) {
        control.throwIfCancelled();
        const response = await channel.request(reply);
        // The paired host constructs this closed command union.
        const command = response.input as SessionCompactionSourceCommand;
        response.consumed();
        control.throwIfCancelled();
        if (command.kind === "close") {
          break;
        }
        reply = {
          kind: "serialized",
          conversation: serializeConversationSourceWithinBudget(
            serializer(command.source),
            command.maxChars,
          ),
        };
      }
      return { kind: "compaction-source" };
    } finally {
      try {
        snapshot.close();
      } finally {
        database.close();
      }
    }
  });
}
