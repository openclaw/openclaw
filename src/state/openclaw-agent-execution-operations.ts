import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import type { SessionTranscriptInitializationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { SessionEntryReplacementCommit } from "../config/sessions/session-accessor.sqlite-replacement-types.js";
import type { ResolvedTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import type {
  SessionEntryCohortRequest,
  SessionEntryReadWorkerInput,
} from "../config/sessions/session-entry-read.types.js";
import type {
  SessionTranscriptExecutionReadInputs,
  SessionTranscriptExecutionReadResult,
} from "../config/sessions/session-transcript-execution-read.types.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  deferSqliteWorkerCommitReceipt,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "../infra/sqlite-worker-operation-admission.js";
import { readTrajectoryRuntimeRetentionLease } from "../trajectory/runtime-retention.contract.js";
import type { AgentDatabaseMaintenanceOperations } from "./openclaw-agent-execution-maintenance.js";
import type { loadAgentVoiceSessionOperations } from "./openclaw-agent-execution-voice-operations.js";
import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers, WorkerOperations } from "./worker-operation-registry.js";

type Handlers = WorkerOperationHandlers<AgentWorkerOperationContext>;
type TranscriptInitialization = { sessionKey: string; sessionId: string; cwd?: string };

let transcript:
  | {
      initialize: typeof import("../config/sessions/session-accessor.sqlite-transcript-header.js").ensureTranscriptHeader;
      assertIdentity: typeof import("../config/sessions/session-accessor.sqlite-scope.js").assertSqliteTranscriptWriteIdentity;
      readPublication: typeof import("../config/sessions/session-transcript-authority.js").readStagedSessionTranscriptAuthority;
    }
  | undefined;

export function prepareAgentTranscript() {
  return Promise.all([
    import("../config/sessions/session-accessor.sqlite-transcript-header.js"),
    import("../config/sessions/session-accessor.sqlite-scope.js"),
    import("../config/sessions/session-transcript-authority.js"),
  ]).then(([header, scope, authority]) => {
    transcript = {
      initialize: header.ensureTranscriptHeader,
      assertIdentity: scope.assertSqliteTranscriptWriteIdentity,
      readPublication: authority.readStagedSessionTranscriptAuthority,
    };
  });
}

export async function loadAgentTranscriptOperations() {
  await prepareAgentTranscript();
  return {
    "session.transcript.initialize": (input: TranscriptInitialization, context) => {
      if (!transcript) {
        throw new Error("Session transcript initialization was not prepared");
      }
      const { initialize, readPublication } = transcript;
      const assertIdentity: typeof transcript.assertIdentity = transcript.assertIdentity;
      assertIdentity(input);
      return context.writeTransaction(
        "session.entry.create-with-transcript",
        "Session transcript",
        (current) => {
          const publication: SessionTranscriptInitializationPublication = {
            kind: "session-transcript-initialized",
            sessionKey: input.sessionKey,
          };
          initialize(
            current,
            { agentId: context.options.agentId, path: context.options.path, ...input },
            input.cwd,
            {
              onPlaceholderInserted: ({ sessionId }) => {
                publication.placeholder = { sessionId };
              },
            },
          );
          publication.transcriptPublication = readPublication(current);
          deferSqliteWorkerCommitReceipt(current.db, publication);
          context.admit("commit", publication);
          return publication;
        },
      );
    },
  } satisfies Handlers;
}

export async function loadAgentTranscriptReadOperations() {
  const [
    raw,
    visible,
    memory,
    anchors,
    cold,
    fence,
    identity,
    reader,
    scopes,
    agents,
    errors,
    watermark,
  ] = await Promise.all([
    import("../config/sessions/session-accessor.sqlite-delta.js"),
    import("../config/sessions/session-accessor.sqlite-active-events.js"),
    import("../hooks/bundled/session-memory/capture.worker.js"),
    import("../config/sessions/session-transcript-anchor-read.kernel.js"),
    import("../config/sessions/session-cold-storage-state.js"),
    import("../config/sessions/session-transcript-read-fence.js"),
    import("../infra/sqlite-worker-identity.js"),
    import("./openclaw-agent-db-readonly-open.js"),
    import("../config/sessions/session-accessor.sqlite-scope-helpers.js"),
    import("@openclaw/normalization-core/agent-id"),
    import("../config/sessions/session-history-worker-errors.js"),
    import("../config/sessions/session-accessor.sqlite-transcript-watermark.js"),
  ]);
  const readResult = <T>(read: () => T): SessionTranscriptExecutionReadResult<T> => {
    try {
      return { ok: true, value: read() };
    } catch (error) {
      const encoded = errors.encodeSessionTranscriptWorkerError(error);
      if (!encoded) {
        throw error;
      }
      return { ok: false, error: encoded };
    }
  };
  const open = (
    input: {
      expectedIdentity: SessionTranscriptExecutionReadInputs["cold"]["expectedIdentity"];
      resolved?: ResolvedTranscriptReadScope;
      scope?: SessionTranscriptReadScope;
    },
    context: AgentWorkerOperationContext,
  ) => {
    const database = context.open();
    identity.assertExistingDatabaseIdentity(
      database.path,
      input.expectedIdentity.key,
      input.expectedIdentity.birthtime,
    );
    if (input.scope) {
      identity.assertExistingDatabaseIdentity(
        input.scope.storePath ?? database.path,
        input.expectedIdentity.key,
        input.expectedIdentity.birthtime,
      );
    }
    if (input.resolved) {
      if ((input.resolved.databaseAgentId ?? input.resolved.agentId) !== database.agentId) {
        throw new Error("Prepared transcript read belongs to another agent database");
      }
      identity.assertExistingDatabaseIdentity(
        input.resolved.path ?? database.path,
        input.expectedIdentity.key,
        input.expectedIdentity.birthtime,
      );
      if (input.scope) {
        const scope = input.scope;
        if (
          scope.sessionId !== input.resolved.sessionId ||
          (scope.agentId !== undefined &&
            agents.normalizeAgentId(scope.agentId) !== input.resolved.agentId) ||
          (scope.sessionKey !== undefined &&
            scopes.resolveSqliteSessionKey(scope.sessionKey, input.resolved.agentId) !==
              input.resolved.sessionKey)
        ) {
          throw new Error("Prepared transcript read changed its captured session scope");
        }
      }
    }
    return database;
  };
  const snapshot = <T>(
    input: {
      expectedIdentity: SessionTranscriptExecutionReadInputs["cold"]["expectedIdentity"];
      resolved?: ResolvedTranscriptReadScope;
      scope?: SessionTranscriptReadScope;
    },
    context: AgentWorkerOperationContext,
    read: (database: ReturnType<AgentWorkerOperationContext["open"]>) => T,
  ) => {
    const database = open(input, context);
    return reader.readOpenClawAgentDatabaseSnapshot(database, () => read(database));
  };
  return {
    "session.transcript.watermark.read": (
      input: SessionTranscriptExecutionReadInputs["watermark"],
      context,
    ) =>
      readResult(() => {
        open(input, context);
        return watermark.readSessionTranscriptWatermark(input.scope);
      }),
    "session.transcript.rawDelta.read": (
      input: SessionTranscriptExecutionReadInputs["raw"],
      context,
    ) =>
      readResult(() => {
        const result = snapshot(input, context, (database) =>
          fence.runWithSessionTranscriptReadFence(input.admission, () =>
            raw.readTranscriptRawDeltaInDatabase(database, input.resolved, input.limits),
          ),
        );
        return result.found ? result.value : { kind: "missing" as const };
      }),
    "session.transcript.visibleDelta.read": (
      input: SessionTranscriptExecutionReadInputs["visible"],
      context,
    ) =>
      readResult(() => {
        open(input, context);
        // Projection kernels admit and read the retained writer in their own deferred snapshot.
        return fence.runWithSessionTranscriptReadFence(input.admission, () =>
          visible.readSessionTranscriptVisibleMessageDeltaCore(input.scope, input.limits, {
            readOnly: true,
            resolvedScope: input.resolved,
          }),
        );
      }),
    "session.transcript.memoryCapture.read": (
      input: SessionTranscriptExecutionReadInputs["memory"],
      context,
    ) =>
      readResult(() => {
        open(input, context);
        return fence.runWithSessionTranscriptReadFence(input.admission, () =>
          memory.readSessionMemoryCapture({
            scope: input.scope,
            resolvedScope: input.resolved,
            messageCount: input.messageCount,
          }),
        );
      }),
    "session.transcript.anchors.read": (
      input: SessionTranscriptExecutionReadInputs["anchors"],
      context,
    ) =>
      readResult(() => {
        const result = snapshot(input, context, (database) =>
          anchors.readSessionTranscriptAnchorFactsInDatabase(
            database,
            input.resolved,
            input.selection,
          ),
        );
        return result.found ? result.value : { anchors: [] };
      }),
    "session.transcript.coldMetadata.read": (
      input: SessionTranscriptExecutionReadInputs["cold"],
      context,
    ) =>
      readResult(() => {
        const result = snapshot(input, context, (database) =>
          cold.readSessionColdTranscript(database.db, input.sessionId),
        );
        return result.found ? result.value : undefined;
      }),
  } satisfies Handlers;
}

export async function loadAgentReplacementOperations() {
  const [kernel, { assertSessionSubagentRunsCurrent }, { sealSessionEntryPublicationSource }] =
    await Promise.all([
      import("../config/sessions/session-accessor.sqlite-replacement-state.js"),
      import("../config/sessions/session-accessor.sqlite-descendant-basis.js"),
      import("../config/sessions/session-entry-publication-source.js"),
    ]);
  return {
    "session.entries.replace": (
      input: SessionEntryReplacementCommit & { initializeTranscript?: TranscriptInitialization },
      context,
    ) =>
      context.writeTransaction("session.entry-replacements", "Session replacement", (current) => {
        assertSessionSubagentRunsCurrent(input, context.options.env ?? process.env);
        const result = kernel.commitSessionEntryReplacementsInDatabase(current, input, () => {
          const initialization = input.initializeTranscript;
          if (!initialization) {
            return;
          }
          try {
            if (!transcript) {
              throw new Error("Session transcript initialization was not prepared");
            }
            const { initialize } = transcript;
            const assertIdentity: typeof transcript.assertIdentity = transcript.assertIdentity;
            assertIdentity(initialization);
            initialize(
              current,
              { agentId: context.options.agentId, path: context.options.path, ...initialization },
              initialization.cwd,
            );
          } catch (error) {
            throw Object.assign(new Error(formatErrorMessage(error), { cause: error }), {
              name: "SessionTranscriptInitializationError",
            });
          }
        });
        const publication = kernel.prepareSessionEntryReplacementPublication(result, current, {
          captureFullFacts: true,
        });
        const candidate = { ...result, publication };
        if (publication.source && publication.fullEntries?.size) {
          sealSessionEntryPublicationSource(publication.source);
        }
        kernel.boundSessionEntryReplacementPublication(publication, candidate);
        deferSqliteWorkerCommitReceipt(current.db, publication);
        context.admit("commit", publication);
        assertSessionSubagentRunsCurrent(input, context.options.env ?? process.env);
        return candidate;
      }),
  } satisfies Handlers;
}

export async function loadAgentRestartRecoveryOperations() {
  const kernel = await import("../config/sessions/session-accessor.sqlite-recovery.worker.js");
  return {
    "session.restart.recover": (
      input: Parameters<typeof kernel.recoverRestartTombstoneInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("session.lifecycle.recover-tombstone", "Session recovery", (current) => {
        const result = kernel.recoverRestartTombstoneInDatabase(current, input);
        deferSqliteWorkerCommitReceipt(
          current.db,
          result.publication ?? { kind: "session-restart-recovery-unchanged" },
        );
        admit("commit", result.publication);
        return result;
      }),
  } satisfies Handlers;
}

export async function loadAgentEntryReadOperations() {
  const kernel = await import("../config/sessions/session-entry-read.worker.js");
  const result = await import("../config/sessions/session-entry-read-result.worker.js");
  const cohort = await import("../config/sessions/session-entry-cohort.worker.js");
  return {
    "session.entry.readResult": (input: SessionEntryReadWorkerInput, { open }) =>
      result.readSessionEntryResult(input, open()),
    "session.entry.read": (input: { sessionKey: string } | SessionEntryCohortRequest, { open }) => {
      const database = open();
      return "sessionKeys" in input
        ? cohort.readSessionEntryCohort(database, input, (request) =>
            kernel.readExactSessionEntriesWithLifecycle(request, database),
          )
        : cohort.readSessionEntryDataInDatabase(database, input.sessionKey);
    },
  } satisfies Handlers;
}

export async function loadAgentEntryPatchOperations() {
  const kernel = await import("../config/sessions/session-entry-patch.worker.js");
  return {
    "session.entry.patch.prepare": (
      input: Parameters<typeof kernel.readSessionEntryPatchSnapshot>[1],
      { open },
    ) => kernel.readSessionEntryPatchSnapshot(open(), input),
    "session.entry.patch.commit": kernel.commitSessionEntryPatch,
  } satisfies Handlers;
}

export async function loadAgentCompoundOperations() {
  const turn = await import("../config/sessions/session-turn.worker.js");
  const reset = await import("../config/sessions/session-reset.worker.js");
  const lifecycle = await import("../config/sessions/session-lifecycle-projection.worker.js");
  const predicates = await import("../config/sessions/session-turn-predicate.js");
  await predicates.prepareSessionTurnPredicates();
  return {
    "session.turn.prepare": turn.prepareSessionTurn,
    "session.turn.commit": turn.commitSessionTurn,
    "session.lifecycle.reset": reset.commitSessionReset,
    "session.lifecycle.project": lifecycle.commitSessionLifecycleProjection,
  } satisfies Handlers;
}

export async function loadAgentPurgeOperations() {
  const purge = await import("../config/sessions/session-agent-purge.worker.js");
  return {
    "session.agentPurge.prepare": purge.prepareSessionAgentPurge,
    "session.agentPurge.commit": purge.commitSessionAgentPurge,
  } satisfies Handlers;
}

export async function loadAgentMaintenanceFinalizationOperations() {
  const finalization =
    await import("../config/sessions/session-maintenance-finalization.worker.js");
  const maintenanceStore =
    await import("../config/sessions/session-accessor.sqlite-maintenance-store.js");
  return {
    "session.maintenance.finalize": finalization.finalizeSessionMaintenance,
    "session.maintenance.size": (input: { sessionIds: string[] }, { open }) =>
      maintenanceStore.readSessionTranscriptJsonlBytesInDatabase(open(), input.sessionIds),
  } satisfies Handlers;
}

export async function loadAgentMessageCutOperations() {
  const kernel = await import("../config/sessions/session-message-cut.worker.js");
  return { "session.messageCut.commit": kernel.commitSessionMessageCut } satisfies Handlers;
}

export async function loadAgentNativeBindingOperations() {
  const kernel = await import("../config/sessions/session-native-binding.worker.js");
  return {
    "session.nativeBindings.delete": kernel.deleteSessionWithNativeBindings,
  } satisfies Handlers;
}

export async function prepareAgentNativeBindingOperation(
  input: import("../config/sessions/session-native-binding.types.js").SessionNativeBindingParticipants,
  env?: NodeJS.ProcessEnv,
) {
  const kernel = await import("../config/sessions/session-native-binding.worker.js");
  await kernel.prepareSessionNativeBindingDeletion(input, env);
}

export async function loadAgentTrajectoryOperations() {
  const kernel = await import("../trajectory/runtime-store.sqlite.js");
  const retention = await import("../trajectory/runtime-retention.sqlite.js");
  return {
    "trajectory.events.append": (
      input: Parameters<typeof kernel.appendSqliteTrajectoryRuntimeEventsWithWriter>[0],
      { writeTransaction, admit },
    ) => {
      kernel.appendSqliteTrajectoryRuntimeEventsWithWriter(input, (label, write) =>
        writeTransaction(label, "Trajectory append", (current) => {
          const result = write(current);
          deferSqliteWorkerCommitReceipt(current.db, { kind: "trajectory-runtime-append" });
          admit("commit");
          return result;
        }),
      );
    },
    "trajectory.retention.begin": (_input: undefined, { open }) => {
      return retention.beginTrajectoryRuntimeRetention(
        open().db,
        readTrajectoryRuntimeRetentionLease(takeSqliteWorkerOperationAdmissionAttachment()),
      );
    },
    "trajectory.retention.delete": (
      input: Parameters<typeof retention.selectTrajectoryRuntimeRetentionBatch>[1],
      { open, writeTransaction, admit },
    ) => {
      const database = open();
      const batch = retention.selectTrajectoryRuntimeRetentionBatch(database.db, input);
      if (batch.refresh) {
        return retention.deleteTrajectoryRuntimeRetention(database, batch);
      }
      return writeTransaction(
        "trajectory.runtime.retention.delete",
        "Trajectory retention",
        (current) => {
          const result = retention.deleteTrajectoryRuntimeRetention(current, batch);
          admit("commit");
          return result;
        },
      );
    },
  } satisfies Handlers;
}

export async function loadAgentArchiveOperations() {
  const kernel = await import("../config/sessions/session-accessor.sqlite-archive-store-kernel.js");
  return {
    "session.archives.preparePublication": (
      input: Parameters<typeof kernel.prepareSessionTranscriptArchivePublishPlans>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("session.archive.publish", "Session archive publication", (current) => {
        const result = kernel.prepareSessionTranscriptArchivePublishPlans(current, input);
        admit("commit");
        return result;
      }),
    "session.archives.recordPublication": (
      input: {
        results: Parameters<typeof kernel.recordSessionTranscriptArchivePublishResults>[1];
        nowMs: number;
      },
      { writeTransaction, admit },
    ) =>
      writeTransaction("session.archive.publish", "Session archive publication", (current) => {
        const result = kernel.recordSessionTranscriptArchivePublishResults(
          current,
          input.results,
          input.nowMs,
        );
        admit("commit");
        return result;
      }),
  } satisfies Handlers;
}

export async function loadAgentAcpOperations() {
  const kernel = await import("../acp/runtime/session-meta-entry.worker.js");
  return {
    "session.entry.acp": (
      input: Parameters<typeof kernel.mutateAcpSessionEntryInWorker>[2],
      { open, options, admit },
    ) => kernel.mutateAcpSessionEntryInWorker(open(), options, input, admit),
  } satisfies Handlers;
}

export async function loadAgentProviderReviewOperations() {
  const kernel = await import("../config/sessions/provider-review-store.worker.js");
  return {
    "session.providerReview.compare": (
      input: Parameters<typeof kernel.compareSessionProviderReviewInWorker>[2],
      { open, options, admit },
    ) => kernel.compareSessionProviderReviewInWorker(open(), options, input, admit),
  } satisfies Handlers;
}

export async function loadAgentReactionOperations() {
  const kernel = await import("../config/sessions/session-reaction-store.kernel.js");
  return {
    "session.reaction.set": (
      input: {
        sessionKey: string;
        params: Parameters<typeof kernel.setSessionReactionInDatabase>[2];
      },
      { writeTransaction, admit },
    ) =>
      writeTransaction("session.reaction.set", "Reaction write", (current) => {
        const result = kernel.setSessionReactionInDatabase(current, input.sessionKey, input.params);
        admit("commit");
        return result;
      }),
  } satisfies Handlers;
}

export async function loadAgentPendingInputOperations() {
  const pending = await import("../config/sessions/session-pending-input-operations.kernel.js");
  const kernel = await import("../config/sessions/session-pending-input-withdrawal.worker.js");
  const history = await import("../config/sessions/session-pending-input-history-reconcile.js");
  return {
    "session.pendingInputs.read": (
      input: Parameters<typeof pending.readPendingInput>[1],
      { open },
    ) => pending.readPendingInput(open(), input),
    "session.pendingInputs.mutate": (
      input: Parameters<typeof pending.mutatePendingInput>[0],
      context,
    ) => pending.mutatePendingInput(input, context, deferSqliteWorkerCommitReceipt),
    "session.pendingInputs.interruptHistory": (
      input: Parameters<typeof history.interruptPendingInputHistoryInDatabase>[2],
      { open, options, admit },
    ) => {
      const database = open();
      return history.interruptPendingInputHistoryInDatabase(
        database,
        options,
        input,
        admit,
        (receipt) => deferSqliteWorkerCommitReceipt(database.db, receipt),
      );
    },
    "session.pendingInputs.withdraw": (
      input: Parameters<typeof kernel.discardSessionPendingInputInWorker>[2],
      { open, options, admit },
    ) => kernel.discardSessionPendingInputInWorker(open(), options, input, admit),
  } satisfies Handlers;
}

export async function loadAgentArchivePruningOperations() {
  const kernel = await import("../config/sessions/session-history-archive-pruning.worker.js");
  return {
    "session.archivePruning.pruneRetention": (
      input: Parameters<typeof kernel.pruneSessionArchivesByRetentionInDatabase>[2],
      { open, options, admit },
    ) => kernel.pruneSessionArchivesByRetentionInDatabase(open(), options, input, admit),
    "session.archivePruning.deletePublished": (
      input: Parameters<typeof kernel.deletePublishedSessionArchiveInDatabase>[2],
      { open, options, admit },
    ) => kernel.deletePublishedSessionArchiveInDatabase(open(), options, input, admit),
    "session.archivePruning.removeLegacy": (
      input: { filePath: string },
      { open, options, admit },
    ) => kernel.removeLegacySessionArchiveInDatabase(open(), options, input.filePath, admit),
    "session.archivePruning.reclaimPages": (input: { maxPages?: number }, { open, admit }) =>
      open().walMaintenance.reclaimFreePages({
        maxPages: input.maxPages,
        beforeMutation: () => admit("transaction"),
        onCommit: () => admit("commit"),
      }),
  } satisfies Handlers;
}

export async function loadConversationDeliveryOperations() {
  const kernel = await import("../config/sessions/conversation-delivery-store.kernel.js");
  return {
    "conversation.delivery.begin": (
      input: Parameters<typeof kernel.beginConversationDeliveryInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("conversation-delivery.begin", "Conversation delivery", (database) => {
        const result = kernel.beginConversationDeliveryInDatabase(database, input);
        admit("commit");
        return result;
      }),
    "conversation.delivery.transition": (
      input: Parameters<typeof kernel.transitionConversationDeliveryInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction(
        `conversation-delivery.${input.status}`,
        "Conversation delivery",
        (database) => {
          const result = kernel.transitionConversationDeliveryInDatabase(database, input);
          admit("commit");
          return result;
        },
      ),
  } satisfies Handlers;
}

export async function loadConversationRegistryOperations() {
  const { deferConversationWorkerReceipt } =
    await import("../config/sessions/session-accessor.sqlite-conversation-publication.js");
  const { prepareConversationIdentities, upsertConversationIdentities } =
    await import("../config/sessions/session-accessor.sqlite-conversation.js");
  const { selectConversationRowsFromDatabase, resolveConversationInDatabase } =
    await import("../config/sessions/session-accessor.sqlite-conversation-read.js");
  const { readConversationDeliveryInDatabase } =
    await import("../config/sessions/conversation-delivery-store.kernel.js");
  return {
    "conversation.register": (
      input: {
        identities: Parameters<typeof prepareConversationIdentities>[0];
        discoveredAt: number;
        query?: Parameters<typeof selectConversationRowsFromDatabase>[1];
      },
      { writeTransaction, admit },
    ) => {
      const prepared = prepareConversationIdentities(input.identities);
      return writeTransaction("conversation.register", "Conversation registration", (database) => {
        const publication = upsertConversationIdentities(database, prepared, input.discoveredAt);
        if (publication && typeof publication.source.identity === "string") {
          deferConversationWorkerReceipt(database.db, publication);
        }
        const rows = input.query
          ? selectConversationRowsFromDatabase(database, input.query)
          : undefined;
        admit("commit");
        return rows;
      });
    },
    "conversation.authority": (
      input: { conversationRef: string } | { operationId: string },
      { writeTransaction, admit },
    ) =>
      writeTransaction("conversation.authority", "Conversation authority", (database) => {
        const operation =
          "operationId" in input ? readConversationDeliveryInDatabase(database, input) : undefined;
        const conversationRef =
          "conversationRef" in input ? input.conversationRef : operation?.conversationRef;
        const facts = {
          operation: operation ? { conversationRef: operation.conversationRef } : undefined,
          conversation: conversationRef
            ? resolveConversationInDatabase(database, conversationRef)
            : undefined,
        };
        admit("commit", { kind: "conversation-authority", facts });
        return facts;
      }),
  } satisfies Handlers;
}

export async function loadUsageCacheOperations() {
  const kernel = await import("../infra/session-cost-usage-cache.kernel.js");
  return {
    "usageCache.writeRollup": (
      input: Parameters<typeof kernel.writeSessionCostUsageRollupInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("session-cost-usage.rollup.write", "Usage cache", ({ db }) => {
        const result = kernel.writeSessionCostUsageRollupInDatabase(db, input);
        admit("commit");
        return result;
      }),
    "usageCache.prune": (
      input: Parameters<typeof kernel.pruneSessionCostUsageRollupsInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("session-cost-usage.rollup.prune", "Usage cache", ({ db }) => {
        kernel.pruneSessionCostUsageRollupsInDatabase(db, input);
        admit("commit");
      }),
    "usageCache.acquireLock": (
      input: Parameters<typeof kernel.acquireSessionCostUsageRefreshLockInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("session-cost-usage.refresh-lock.acquire", "Usage cache", ({ db }) => {
        const result = kernel.acquireSessionCostUsageRefreshLockInDatabase(db, input);
        admit("commit");
        return result;
      }),
    "usageCache.releaseLock": (input: string, { writeTransaction, admit }) =>
      writeTransaction("session-cost-usage.refresh-lock.delete", "Usage cache", ({ db }) => {
        kernel.deleteSessionCostUsageRefreshLockInDatabase(db, input);
        admit("commit");
      }),
  } satisfies Handlers;
}

export type RegisteredAgentWorkerOperations = WorkerOperations<
  Awaited<ReturnType<typeof loadUsageCacheOperations>> &
    Awaited<ReturnType<typeof loadAgentVoiceSessionOperations>> &
    Awaited<ReturnType<typeof loadAgentTranscriptOperations>> &
    Awaited<ReturnType<typeof loadAgentTranscriptReadOperations>> &
    Awaited<ReturnType<typeof loadAgentReplacementOperations>> &
    Awaited<ReturnType<typeof loadAgentEntryReadOperations>> &
    Awaited<ReturnType<typeof loadAgentEntryPatchOperations>> &
    Awaited<ReturnType<typeof loadAgentCompoundOperations>> &
    Awaited<ReturnType<typeof loadAgentPurgeOperations>> &
    Awaited<ReturnType<typeof loadAgentMaintenanceFinalizationOperations>> &
    Awaited<ReturnType<typeof loadAgentNativeBindingOperations>> &
    Awaited<ReturnType<typeof loadAgentMessageCutOperations>> &
    Awaited<ReturnType<typeof loadAgentRestartRecoveryOperations>> &
    Awaited<ReturnType<typeof loadAgentTrajectoryOperations>> &
    Awaited<ReturnType<typeof loadAgentArchiveOperations>> &
    Awaited<ReturnType<typeof loadAgentAcpOperations>> &
    Awaited<ReturnType<typeof loadAgentProviderReviewOperations>> &
    Awaited<ReturnType<typeof loadAgentReactionOperations>> &
    Awaited<ReturnType<typeof loadAgentPendingInputOperations>> &
    Awaited<ReturnType<typeof loadAgentArchivePruningOperations>> &
    Awaited<ReturnType<typeof loadConversationDeliveryOperations>> &
    Awaited<ReturnType<typeof loadConversationRegistryOperations>>
> &
  AgentDatabaseMaintenanceOperations;
