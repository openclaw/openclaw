import { expectDefined } from "@openclaw/normalization-core";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runSynchronousWork } from "../shared/synchronous-work.js";
import {
  createPreparedSessionProfileIdentities,
  createSessionIdentityProjection,
} from "./session-identity-projection.js";
import {
  projectSessionOwnerRunningCounts,
  type SessionListFilterParams,
  type SessionEntrySelection,
} from "./session-list-filters.js";
import { selectSessionEntries } from "./session-list-selection.js";
import { createPreparedSessionListEntryFilter } from "./session-list-visibility.js";
import type {
  SessionListWorkerRequest,
  SessionListWorkerResult,
  SessionListWorkerRow,
  SessionListWorkerUpdate,
} from "./session-list-worker.types.js";
import { identity } from "./session-row-projection-record.js";
import { renderPreparedSessionRow, type PreparedSessionRowRender } from "./session-row-render.js";
import { createSessionRowSelection } from "./session-row-selection.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

/** Retained metadata and indexes belong to one worker; only selected identities leave it. */
export function createSessionListWorkerKernel() {
  let cfg: OpenClawConfig | undefined;
  const rows = new Map<string, SessionListWorkerRow>();
  const references = new Map<string, Set<string>>();
  const selections = new Map<
    string,
    ReturnType<typeof createSessionRowSelection<SessionListWorkerRow>>
  >();
  const pages = new Map<string, { at: number; selection: SessionEntrySelection }>();
  const identityProjection = createSessionIdentityProjection();
  let context = {
    ...buildSessionListRowMetadataContext({
      now: 0,
      subagentRuns: buildSubagentRunReadIndexFromRuns({ runs: new Map(), now: 0 }),
      projectedAgentRuns: {
        modelsBySessionId: new Map(),
        sessionKeys: new Map(),
        sessionIds: new Map(),
        ownerlessSessionKeys: new Map(),
        ownerlessSessionIds: new Map(),
      },
      projectedSubagentActivity: new Set<string>(),
      userProfileIdentityById: createPreparedSessionProfileIdentities(new Map()),
    }),
    identityProjection,
  };
  const index = (row: SessionListWorkerRow, remove = false) => {
    const id = identity(row);
    for (const ref of new Set([row.key, row.entry.sessionId])) {
      if (!ref) {
        continue;
      }
      const ids = references.get(ref) ?? new Set<string>();
      if (remove) {
        ids.delete(id);
      } else {
        ids.add(id);
      }
      if (ids.size) {
        references.set(ref, ids);
      } else {
        references.delete(ref);
      }
    }
  };
  return {
    render(inputs: PreparedSessionRowRender[], now: number) {
      const renderContext = { ...context, subagentRuns: context.subagentRuns.atTime(now), now };
      return inputs.map((input) => {
        const row = renderPreparedSessionRow(input, renderContext);
        return { row, encoded: JSON.stringify(row) };
      });
    },
    apply(update: SessionListWorkerUpdate) {
      if (update.reset || update.cfg || update.profiles || update.changes?.length) {
        pages.clear();
      }
      if (update.cfg) {
        cfg = update.cfg;
        selections.clear();
        identityProjection.invalidate();
      }
      if (update.reset) {
        rows.clear();
        references.clear();
        selections.clear();
        for (const row of update.reset) {
          rows.set(identity(row), row);
          index(row);
        }
      }
      for (const change of update.changes ?? []) {
        const previous = rows.get(change.id);
        if (previous) {
          index(previous, true);
        }
        if (change.row) {
          rows.set(change.id, change.row);
          index(change.row);
        } else {
          rows.delete(change.id);
        }
        for (const selection of selections.values()) {
          selection.change({ kind: "row", ...change });
        }
      }
      if (update.profiles) {
        context.userProfileIdentityById = createPreparedSessionProfileIdentities(update.profiles);
        identityProjection.invalidate();
      }
      if (update.subagentRuns) {
        context.subagentRuns = buildSubagentRunReadIndexFromRuns(update.subagentRuns);
        context.subagentRunsByChildSessionKey = context.subagentRuns.runsByChildSessionKey;
      }
      if (update.projectedAgentRuns) {
        context.projectedAgentRuns = update.projectedAgentRuns;
      }
      if (update.projectedSubagentActivity) {
        context.projectedSubagentActivity = update.projectedSubagentActivity;
      }
    },
    select(request: SessionListWorkerRequest): SessionListWorkerResult {
      const config = expectDefined(cfg, "session list worker configuration");
      const { opts, scope } = request;
      context = { ...context, subagentRuns: context.subagentRuns.atTime(request.now) };
      const selectionId = JSON.stringify([request.scopeId, opts.activeOnly === true]);
      const narrowed = request.key !== undefined || request.candidateRowIds !== undefined;
      let selector = narrowed ? undefined : selections.get(selectionId);
      if (!selector) {
        selector = createSessionRowSelection<SessionListWorkerRow>(
          config,
          scope,
          opts.activeOnly === true,
          () => context,
        );
        const candidateIds =
          request.key !== undefined
            ? (references.get(request.key) ?? [])
            : request.candidateRowIds
              ? request.candidateRowIds
              : rows.keys();
        for (const id of candidateIds) {
          const row = rows.get(id)!;
          if (request.key === undefined || row.key === request.key) {
            selector.add(row);
          }
        }
        if (!narrowed) {
          selections.set(selectionId, selector);
        }
      }
      const activeCandidates =
        opts.activeOnly && request.projectActiveRun
          ? Array.from(request.activeRuns.keys()).flatMap((id) => rows.get(id) ?? [])
          : undefined;
      const selected = selector.read(opts.sortBy ?? "updatedAt", activeCandidates);
      const visible = createPreparedSessionListEntryFilter(request.visibility);
      const getTarget = (key: string) => {
        const row = selected.get(key);
        return row && key !== row.key ? { ...row, storeKey: row.key } : row;
      };
      const inactive = { active: false };
      const active = (key: string) => {
        const row = selected.get(key);
        return (row && request.activeRuns.get(identity(row))) ?? inactive;
      };
      const searchRow = (key: string) =>
        expectDefined(
          request.searchRows?.get(identity(expectDefined(selected.get(key), "search row"))),
          "prepared session search model facts",
        );
      const filters: SessionListFilterParams = {
        cfg: config,
        opts,
        now: request.now,
        entries: selected.entries,
        entriesSorted: true,
        configuredAgentIds: selected.configuredAgentIds,
        involvementKeys: selected.involvementKeys,
        getTarget,
        getModelFacts: (key) => searchRow(key).modelFacts,
        getSearchModelIdentity: (key) => searchRow(key).modelIdentity,
        identityNames: request.identityNames,
        userProfileIdentityById: context.userProfileIdentityById,
        getRowContext: () => context,
        involvingActorId: opts.involvingMe ? request.actorId : undefined,
        ownerFirstActorId: opts.ownerFirst ? request.actorId : undefined,
        restrictProfileReferences: request.restrictProfileReferences,
        projectActiveRun: request.projectActiveRun ? active : undefined,
        entryFilter: (key, entry, row) =>
          (visible?.(row.storeKey ?? key, entry) ?? true) &&
          (opts.hasBoard === undefined || row.hasBoard === opts.hasBoard) &&
          (!opts.activeOnly || active(key).active),
      };
      const candidateKeys = () => {
        const keys = new Set<string>();
        const add = (row: SessionListWorkerRow) =>
          keys.add(
            opts.activeOnly && (row.key === "global" || row.key === "unknown")
              ? JSON.stringify([row.key, row.agentId])
              : row.key,
          );
        for (const id of request.activeRuns.keys()) {
          const row = rows.get(id);
          if (row) {
            add(row);
          }
        }
        for (const ref of [
          ...context.subagentRuns.requesterSessionKeys(),
          ...context.projectedSubagentActivity,
        ]) {
          for (const id of references.get(ref) ?? []) {
            add(rows.get(id)!);
          }
        }
        return keys;
      };
      // Preserve the existing bounded list cache in its new owner. Temporal queries and
      // exact reads stay uncached; metadata/profile publications retire every cached page.
      const pageKey =
        !narrowed &&
        !opts.search &&
        !opts.spawnedBy &&
        !opts.activeOnly &&
        !opts.activityPulseBoundaries
          ? JSON.stringify([
              request.scopeId,
              request.visibility,
              request.visibility.kind === "profile" ? [...request.visibility.aliases] : undefined,
              request.restrictProfileReferences,
              request.actorId,
              opts,
            ])
          : undefined;
      let cached = pageKey === undefined ? undefined : pages.get(pageKey);
      if (
        cached &&
        opts.activeMinutes !== undefined &&
        (request.now < cached.at || request.now > (cached.selection.activityExpiresAt ?? Infinity))
      ) {
        cached = undefined;
      }
      const result = withAgentRosterFactsBatch(config, () => {
        const selectedPage =
          cached?.selection ??
          runSynchronousWork(selectSessionEntries({ ...filters, defaultLimit: 100 }));
        if (!cached && pageKey !== undefined) {
          if (pages.size >= 32) {
            pages.delete(pages.keys().next().value!);
          }
          pages.set(pageKey, { at: request.now, selection: selectedPage });
        }
        return projectSessionOwnerRunningCounts(filters, selectedPage, candidateKeys);
      });
      const { entries, ownerSessionProfiles: _profiles, ...selection } = result;
      const archivedRowIds: string[] = [];
      const queries = entries.map(([key]) => {
        const row = expectDefined(selected.get(key), "selected session row");
        if (row.entry.archivedAt !== undefined) {
          archivedRowIds.push(identity(row));
        }
        return { agentId: row.agentId, key: row.key, storePath: row.storeTarget.storePath };
      });
      return {
        selection,
        keys: entries.map(([key]) => key),
        queries,
        archivedRowIds,
        storePath: scope.path,
      };
    },
  };
}
