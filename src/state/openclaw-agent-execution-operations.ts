import { loadAgentAuthProfileOperations } from "../agents/auth-profiles/store-agent.worker.js";
import type {
  SessionEntryReplacementCandidate,
  SessionEntryReplacementCommit,
} from "../config/sessions/session-accessor.sqlite-replacement-types.js";
import type {
  SessionEntryCohortRequest,
  SessionEntryReadWorkerInput,
} from "../config/sessions/session-entry-read.types.js";
import type { SessionEntryWritePostimages } from "../config/sessions/session-entry-write-postimage.js";
import {
  deferSqliteWorkerCommitReceipt,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "../infra/sqlite-worker-operation-admission.js";
import { readTrajectoryRuntimeRetentionLease } from "../trajectory/runtime-retention.contract.js";
import type { createAgentDatabaseMaintenanceOwner } from "./openclaw-agent-execution-maintenance.js";
import {
  initializeReplacementTranscript,
  loadAgentTranscriptOperations,
  loadAgentTranscriptReadOperations,
  type TranscriptInitialization,
} from "./openclaw-agent-execution-transcript.worker.js";
import { loadUsageCacheOperations } from "./openclaw-agent-execution-usage.worker.js";
import { loadAgentVoiceSessionOperations } from "./openclaw-agent-execution-voice-operations.js";
import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";
import type {
  WorkerOperationHandlers,
  WorkerOperationsFromLoaders,
} from "./worker-operation-registry.js";

type Handlers = WorkerOperationHandlers<AgentWorkerOperationContext>;

async function loadAgentReplacementOperations() {
  const [kernel, { sealSessionEntryPublicationSource }, nativeBindings, transfers, predicates] =
    await Promise.all([
      import("../config/sessions/session-accessor.sqlite-replacement-state.js"),
      import("../config/sessions/session-entry-publication-source.js"),
      import("../config/sessions/session-native-binding.worker.js"),
      import("../config/sessions/session-entry-patch.worker.js"),
      import("../config/sessions/session-source-predicate.worker.js"),
    ]);
  return {
    "session.entries.replace": (
      input: SessionEntryReplacementCommit & { initializeTranscript?: TranscriptInitialization },
      context,
    ) => {
      const replace = (current: ReturnType<AgentWorkerOperationContext["open"]>) => {
        const postimages: SessionEntryWritePostimages = new Map();
        const result = kernel.commitSessionEntryReplacementsInDatabase(
          current,
          input,
          () => {
            if (input.sources?.length) {
              const sourceValidation = predicates.readSessionSourceValidation(
                current,
                input.sources,
              );
              context.admit("transaction", {
                kind: "session-entry-replacements-validated",
                sourceValidation,
              });
              if (sourceValidation.refusedSource) {
                throw new Error("Session source refusal was not rejected");
              }
            }
            initializeReplacementTranscript(current, context.options, input.initializeTranscript);
          },
          undefined,
          undefined,
          postimages,
        );
        const publication = kernel.prepareSessionEntryReplacementPublication(result, current, {
          captureFullFacts: true,
          postimages,
        });
        const candidate = { ...result, publication };
        if (publication.source && publication.fullEntries?.size) {
          sealSessionEntryPublicationSource(publication.source);
        }
        kernel.boundSessionEntryReplacementPublication(publication, candidate);
        return candidate;
      };
      if (input.nativeBindings) {
        return nativeBindings.runSessionNativeBindingTransaction(
          input.nativeBindings,
          context,
          "session.entry-replacements",
          "Session replacement",
          (current, wrapReceipt) => {
            const result = replace(current);
            const candidate: SessionEntryReplacementCandidate = {
              kind: "session-entry-replacements",
              result,
              publication: result.publication,
            };
            return transfers.transferSessionEntryWorkerCandidate(
              current,
              context.admit,
              candidate,
              wrapReceipt,
            );
          },
        );
      }
      return context.writeTransaction(
        "session.entry-replacements",
        "Session replacement",
        (current) => {
          const candidate = replace(current);
          const publication = candidate.publication;
          deferSqliteWorkerCommitReceipt(current.db, publication);
          context.admit("commit", publication);
          return candidate;
        },
      );
    },
  } satisfies Handlers;
}

async function loadAgentRestartRecoveryOperations() {
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

async function loadAgentEntryReadOperations() {
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

async function loadAgentEntryPatchOperations() {
  const kernel = await import("../config/sessions/session-entry-patch.worker.js");
  return {
    "session.entry.patch.prepare": (
      input: Parameters<typeof kernel.readSessionEntryPatchSnapshot>[1],
      { open },
    ) =>
      kernel
        .readSessionEntryPatchSnapshot(open(), input)
        .map(({ sessionKey, entry }) => ({ sessionKey, entry })),
    "session.entry.patch.commit": kernel.commitSessionEntryPatch,
  } satisfies Handlers;
}

async function loadAgentCompoundOperations() {
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

async function loadAgentEntryDeletionOperations() {
  const deletion = await import("../config/sessions/session-entry-deletion.worker.js");
  return {
    "session.lifecycle.deletePlan": deletion.planSessionDeletionInAgentWorker,
    "session.lifecycle.delete": deletion.deleteSessionEntryInAgentWorker,
  } satisfies Handlers;
}

async function loadAgentPurgeOperations() {
  const purge = await import("../config/sessions/session-agent-purge.worker.js");
  return {
    "session.agentPurge.prepare": purge.prepareSessionAgentPurge,
    "session.agentPurge.commit": purge.commitSessionAgentPurge,
  } satisfies Handlers;
}

async function loadAgentMaintenanceFinalizationOperations() {
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

async function loadAgentMessageCutOperations() {
  const kernel = await import("../config/sessions/session-message-cut.worker.js");
  return { "session.messageCut.commit": kernel.commitSessionMessageCut } satisfies Handlers;
}

async function loadAgentNativeBindingOperations() {
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

async function loadAgentTrajectoryOperations() {
  const kernel = await import("../trajectory/runtime-store.sqlite.js");
  const retention = await import("../trajectory/runtime-retention.sqlite.js");
  return {
    "trajectory.events.append": (
      input: Parameters<typeof kernel.appendSqliteTrajectoryRuntimeEventsWithWriter>[0],
      { open, writeTransaction, admit },
    ) => {
      return kernel.appendSqliteTrajectoryRuntimeEventsWithWriter(
        input,
        open(),
        (label, write, receipt) =>
          writeTransaction(
            label,
            "Trajectory append",
            (current) => {
              if (receipt) {
                deferSqliteWorkerCommitReceipt(current.db, receipt);
                admit("commit");
                return write(current);
              }
              const result = write(current);
              deferSqliteWorkerCommitReceipt(current.db, result.receipt);
              admit("commit");
              return result;
            },
            undefined,
            receipt !== undefined,
          ),
      ).receipt.windowFacts;
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

async function loadAgentArchiveOperations() {
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

async function loadAgentAcpOperations() {
  const kernel = await import("../acp/runtime/session-meta-entry.worker.js");
  return {
    "session.entry.acp": (
      input: Parameters<typeof kernel.mutateAcpSessionEntryInWorker>[2],
      { open, options, admit },
    ) => kernel.mutateAcpSessionEntryInWorker(open(), options, input, admit),
  } satisfies Handlers;
}

async function loadAgentProviderReviewOperations() {
  const kernel = await import("../config/sessions/provider-review-store.worker.js");
  return {
    "session.providerReview.compare": (
      input: Parameters<typeof kernel.compareSessionProviderReviewInWorker>[2],
      { open, options, admit },
    ) => kernel.compareSessionProviderReviewInWorker(open(), options, input, admit),
  } satisfies Handlers;
}

async function loadAgentReactionOperations() {
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

async function loadAgentPendingInputOperations() {
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

async function loadAgentArchivePruningOperations() {
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

async function loadConversationDeliveryOperations() {
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

async function loadConversationRegistryOperations() {
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
          deferSqliteWorkerCommitReceipt(database.db, publication);
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

async function loadSessionRowBackfillOperations() {
  const [{ backfillSessionRowTranscriptFieldsInDatabase }, { withSqliteDatabaseWriteScope }] =
    await Promise.all([
      import("../gateway/session-row-transcript-backfill.worker.js"),
      import("../infra/sqlite-database-admission.js"),
    ]);
  return {
    "session.rowTranscript.backfill": (
      input: Parameters<typeof backfillSessionRowTranscriptFieldsInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("session.rowTranscript.backfill", "Session row backfill", (database) => {
        // Derived cache bytes do not invalidate transcript snapshots or session metadata.
        const fields = withSqliteDatabaseWriteScope(database.db, [], () =>
          backfillSessionRowTranscriptFieldsInDatabase(database, input),
        );
        admit("commit");
        return fields;
      }),
  } satisfies Handlers;
}

export function createAgentWorkerOperationLoaders(
  maintenance: ReturnType<typeof createAgentDatabaseMaintenanceOwner>["operations"],
) {
  const loadMaintenanceOperations = async () => maintenance;
  return {
    "authProfiles.read": loadAgentAuthProfileOperations,
    "session.entry.read": loadAgentEntryReadOperations,
    "session.entry.readResult": loadAgentEntryReadOperations,
    "voice.session.read": loadAgentVoiceSessionOperations,
    "voice.session.mutate": loadAgentVoiceSessionOperations,
    "session.entry.patch.prepare": loadAgentEntryPatchOperations,
    "session.entry.patch.commit": loadAgentEntryPatchOperations,
    "session.turn.prepare": loadAgentCompoundOperations,
    "session.turn.commit": loadAgentCompoundOperations,
    "session.lifecycle.reset": loadAgentCompoundOperations,
    "session.lifecycle.project": loadAgentCompoundOperations,
    "session.lifecycle.deletePlan": loadAgentEntryDeletionOperations,
    "session.lifecycle.delete": loadAgentEntryDeletionOperations,
    "session.agentPurge.prepare": loadAgentPurgeOperations,
    "session.agentPurge.commit": loadAgentPurgeOperations,
    "session.maintenance.finalize": loadAgentMaintenanceFinalizationOperations,
    "session.maintenance.size": loadAgentMaintenanceFinalizationOperations,
    "session.nativeBindings.delete": loadAgentNativeBindingOperations,
    "session.messageCut.commit": loadAgentMessageCutOperations,
    "trajectory.events.append": loadAgentTrajectoryOperations,
    "trajectory.retention.begin": loadAgentTrajectoryOperations,
    "trajectory.retention.delete": loadAgentTrajectoryOperations,
    "session.archives.preparePublication": loadAgentArchiveOperations,
    "session.archives.recordPublication": loadAgentArchiveOperations,
    "session.transcript.initialize": loadAgentTranscriptOperations,
    "session.transcript.rawDelta.read": loadAgentTranscriptReadOperations,
    "session.transcript.watermark.read": loadAgentTranscriptReadOperations,
    "session.transcript.visibleDelta.read": loadAgentTranscriptReadOperations,
    "session.transcript.memoryCapture.read": loadAgentTranscriptReadOperations,
    "session.transcript.anchors.read": loadAgentTranscriptReadOperations,
    "session.transcript.coldMetadata.read": loadAgentTranscriptReadOperations,
    "session.entries.replace": loadAgentReplacementOperations,
    "session.restart.recover": loadAgentRestartRecoveryOperations,
    "session.entry.acp": loadAgentAcpOperations,
    "session.providerReview.compare": loadAgentProviderReviewOperations,
    "session.reaction.set": loadAgentReactionOperations,
    "conversation.delivery.begin": loadConversationDeliveryOperations,
    "conversation.register": loadConversationRegistryOperations,
    "conversation.authority": loadConversationRegistryOperations,
    "conversation.delivery.transition": loadConversationDeliveryOperations,
    "session.pendingInputs.withdraw": loadAgentPendingInputOperations,
    "session.pendingInputs.read": loadAgentPendingInputOperations,
    "session.pendingInputs.mutate": loadAgentPendingInputOperations,
    "session.pendingInputs.interruptHistory": loadAgentPendingInputOperations,
    "session.archivePruning.deletePublished": loadAgentArchivePruningOperations,
    "session.archivePruning.pruneRetention": loadAgentArchivePruningOperations,
    "session.archivePruning.removeLegacy": loadAgentArchivePruningOperations,
    "session.archivePruning.reclaimPages": loadAgentArchivePruningOperations,
    "session.maintenance.prepare": loadMaintenanceOperations,
    "session.maintenance.metadata": loadMaintenanceOperations,
    "usageCache.writeRollup": loadUsageCacheOperations,
    "usageCache.writeQuarters": loadUsageCacheOperations,
    "usageCache.prune": loadUsageCacheOperations,
    "usageCache.retireLegacy": loadUsageCacheOperations,
    "session.rowTranscript.backfill": loadSessionRowBackfillOperations,
  };
}

export type RegisteredAgentWorkerOperations = WorkerOperationsFromLoaders<
  ReturnType<typeof createAgentWorkerOperationLoaders>
>;
