import { isDeepStrictEqual } from "node:util";
import { shouldPreserveSubagentForMaintenance } from "../agents/subagents/registry/subagent-delivery-state.js";
import { getSubagentRunsForChildSession } from "../agents/subagents/registry/subagent-registry-memory.js";
import { hasPendingFollowupQueueWork } from "../auto-reply/reply/queue/state.js";
import { isTerminalSessionStatus } from "../config/sessions/types.js";
import {
  hasAgentRunContextExecutionOwner,
  listAgentRunsForSession,
} from "../infra/agent-run-registry.js";
import { resolveSessionPinnedHarnessId } from "../sessions/agent-harness-session-key.js";
import { isSessionRunActive } from "../sessions/session-controller.queries.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import type { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import * as records from "./session-row-projection-record.js";

// One normal list page stays warm; larger pages retain their window only while reading it.
const DEFAULT_MATERIALIZED_ROWS = 100;

export function isColdSessionRow(row: records.Row) {
  return row.cold === true && !row.materialized;
}

function eligible(row: records.Row) {
  return row.entry?.archivedAt !== undefined || isTerminalSessionStatus(row.entry?.status);
}

/** Selection and sharing metadata outlive bounded, post-use display residency. */
export function createSessionRowProjectionResidency(params: {
  rows: ReadonlyMap<string, records.Row>;
  dirty: Set<string>;
  invalidateTranscript: (id: string) => void;
  put: (row: records.Row) => void;
  release: (id: string) => void;
  invalidateFacts: (row: records.Row) => void;
  config: () => records.Inputs["cfg"];
  context: () => Parameters<typeof records.readSessionRowLineage>[3];
  referenced: NonNullable<Parameters<typeof records.readSessionRowLineage>[4]>;
  contextPrepared: () => boolean;
  placementFacts: Pick<
    ReturnType<typeof createSessionRowPlacementProjection>,
    "getProjectionFacts" | "isPrepared"
  >;
  observers?: records.ProjectionOptions["observers"];
}) {
  const materialized = new Set<string>();
  const readPins = new Set<ReadonlySet<string>>();
  let limit = DEFAULT_MATERIALIZED_ROWS;
  function isProtected(row: records.Row) {
    const entry = row.storedEntry;
    if (!entry || !params.contextPrepared()) {
      return true;
    }
    const placement = params.placementFacts.getProjectionFacts(entry.sessionId);
    if (
      !params.placementFacts.isPrepared(entry.sessionId) ||
      placement?.move ||
      placement?.workspaceRecoveryPending ||
      placement?.workspaceResultReconciling ||
      (placement?.placement &&
        placement.placement.state !== "local" &&
        placement.placement.state !== "reclaimed") ||
      params.observers?.has(row) ||
      entry.initializationPending ||
      entry.pendingFinalDelivery ||
      (entry.pendingDeliveryNotice && entry.pendingDeliveryNotice.state !== "acknowledged") ||
      entry.restartRecoveryDeliveryReceiptState === "terminal-pending" ||
      entry.restartRecoveryBeforeAgentReplyState === "admitted" ||
      entry.restartRecoveryBeforeAgentReplyState === "pending" ||
      entry.restartRecoveryBeforeAgentReplyState === "continue" ||
      (entry.mainRestartRecovery && !entry.mainRestartRecovery.tombstone) ||
      entry.quotaSuspension ||
      Object.keys(entry.pendingExecNotifications ?? {}).length > 0 ||
      isSessionRunActive(entry.sessionId) ||
      listAgentRunsForSession({ sessionKey: row.key, sessionId: entry.sessionId }).some(
        ({ runId }) => hasAgentRunContextExecutionOwner(runId),
      ) ||
      hasPendingFollowupQueueWork([row.key, entry.sessionId], {
        storeScope: row.storeTarget.storePath,
        agentId: row.agentId,
      })
    ) {
      return true;
    }
    // Compact committed runs retain cleanup and delivery; live owners also carry recovery custody.
    for (const run of params.context().subagentRunsByChildSessionKey.get(row.key) ?? []) {
      if (
        run.cleanupCompletedAt === undefined ||
        run.execution.endedAt === undefined ||
        shouldPreserveSubagentForMaintenance(run) ||
        run.delivery?.status === "pending" ||
        run.delivery?.status === "in_progress" ||
        run.delivery?.status === "suspended"
      ) {
        return true;
      }
    }
    for (const run of getSubagentRunsForChildSession(row.key, row.agentId)) {
      if (
        shouldPreserveSubagentForMaintenance(run) ||
        run.terminalOwner ||
        run.execution.restartRecovery ||
        run.collectorLaunchCleanupPending ||
        run.requesterSettleWake
      ) {
        return true;
      }
    }
    return false;
  }
  function demote(row: records.Row): records.Row {
    const id = records.identity(row);
    materialized.delete(id);
    params.release(id);
    const cold = records.dematerialize(row);
    params.put(cold);
    // Eviction releases display custody, not unresolved database-fact preparation.
    if (cold.unresolvedDatabaseFacts === "category") {
      params.dirty.add(id);
    }
    return cold;
  }
  function trim() {
    for (const id of materialized) {
      if (materialized.size <= limit) {
        break;
      }
      const row = params.rows.get(id)!;
      if (
        ![...readPins].some((pins) => pins.has(id)) &&
        (row.entry?.archivedAt !== undefined ||
          (!params.dirty.has(id) &&
            !row.pendingDatabaseFacts &&
            !row.unresolvedDatabaseFacts &&
            !isProtected(row)))
      ) {
        demote(row);
      }
    }
  }
  function markRelated(
    row: records.Row,
    indexes: Parameters<typeof records.markRelated>[1],
    includeChildren = true,
  ) {
    const related = new Set<string>();
    records.markRelated(row, indexes, related, includeChildren, params.config());
    for (const id of related) {
      const current = params.rows.get(id);
      if (current && isColdSessionRow(current)) {
        if (!current.storedEntry) {
          continue;
        }
        const lineage = records.readSessionRowLineage(
          current,
          current.storedEntry,
          params.config(),
          params.context(),
          params.referenced,
        );
        if (
          isDeepStrictEqual(current.parents, lineage.parents) &&
          isDeepStrictEqual(current.entry, lineage.entry)
        ) {
          continue;
        }
        // Cold children retain metadata/indices; both parents must drop stale child links.
        const next = {
          ...current,
          ...lineage,
          pendingDatabaseFacts: undefined,
          retainedDatabaseFacts: undefined,
          databaseFactsRevision: current.databaseFactsRevision + 1,
        };
        params.put(next);
        markRelated(current, indexes, false);
        markRelated(next, indexes, false);
      } else if (current) {
        params.dirty.add(id);
      }
    }
  }
  const stopObserving = params.observers?.onChange(trim);
  return {
    trim,
    acquire(row: records.Row, previous: records.Row) {
      if (!eligible(row)) {
        materialized.delete(records.identity(row));
        row.cold = undefined;
      } else if (row.entry?.archivedAt !== undefined && previous.entry?.archivedAt === undefined) {
        // Archives start as metadata; terminal rows join the same budget after use.
        return demote(row);
      }
      return row;
    },
    markRelated,
    deferAcquisition(row: records.Row) {
      const id = records.identity(row);
      params.put(row);
      params.dirty.add(id);
      return undefined;
    },
    invalidateRows(
      change: Extract<SessionRowChange, { all: true }> & { runtimeOwnershipChanged?: true },
      candidates: Iterable<records.Row>,
    ) {
      const catalogOnly = change.scope === "catalog" && !change.factsInvalidated;
      for (const row of candidates) {
        if (change.factsInvalidated) {
          params.invalidateFacts(row);
        }
        if (change.runtimeOwnershipChanged && resolveSessionPinnedHarnessId(row.entry)) {
          // Completed policy changes expire native ownership; queued work keeps accepted facts.
          records.invalidateDatabaseFacts(
            row,
            row.retainedDatabaseFacts && {
              ...row.retainedDatabaseFacts,
              runtimeOwnership: undefined,
              runtimeOwnershipDependencies: undefined,
            },
          );
        }
        if (catalogOnly && row.entry?.archivedAt === undefined) {
          if (row.materialized && !params.dirty.has(records.identity(row))) {
            row.pendingDatabaseFacts = records.isPreparedSessionRowDatabaseFacts(
              row.retainedDatabaseFacts,
            )
              ? row.retainedDatabaseFacts
              : undefined;
          }
        } else {
          row.pendingDatabaseFacts = undefined;
          row.retainedDatabaseFacts = undefined;
        }
        if (isColdSessionRow(row) || row.entry?.archivedAt !== undefined) {
          const current = row.materialized ? demote(row) : row;
          if (!catalogOnly) {
            records.invalidateDatabaseFacts(current);
          }
          // Catalog policy can expire native ownership while retaining ACP and Board facts.
          if (
            current.preparedAcpMeta === undefined ||
            current.preparedRuntimeOwnership === undefined ||
            current.hasBoard === undefined
          ) {
            params.dirty.add(records.identity(current));
          }
          continue;
        }
        params.dirty.add(records.identity(row));
        if (
          typeof change.scope !== "string" ||
          change.factsInvalidated ||
          ((change.scope === "config" || change.scope === "catalog") && row.entry?.fallbackNotice)
        ) {
          params.invalidateTranscript(records.identity(row));
        }
      }
    },
    // Disjoint prepared pages retain their own rows across worker and placement yields.
    retainRows(this: void) {
      let pins: ReadonlySet<string> = new Set();
      readPins.add(pins);
      return {
        update(ids: readonly string[]) {
          readPins.delete(pins);
          pins = new Set(ids);
          readPins.add(pins);
          limit = Math.max(limit, pins.size);
          trim();
        },
        release() {
          readPins.delete(pins);
          limit = Math.max(
            DEFAULT_MATERIALIZED_ROWS,
            ...Array.from(readPins, (heldPins) => heldPins.size),
          );
          trim();
        },
      };
    },
    forget: (id: string) => materialized.delete(id),
    clear() {
      stopObserving?.();
      materialized.clear();
      readPins.clear();
    },
    describe(row: records.Row | undefined) {
      if (!row || !eligible(row)) {
        return row;
      }
      if (records.ready(row)) {
        const id = records.identity(row);
        materialized.delete(id);
        materialized.add(id);
        trim();
      }
      return row;
    },
  };
}
