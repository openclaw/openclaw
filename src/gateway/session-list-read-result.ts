import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import type { GatewayClient } from "./server-methods/types.js";
import { readPreparedGatewayModelMetadata } from "./server-model-catalog-view.js";
import { getSessionListBaseMiss, retainSessionListBaseMiss } from "./session-list-diagnostics.js";
import type { SessionEntrySelection, SessionListFilterParams } from "./session-list-filters.js";
import type { SessionRowGeneration } from "./session-row-identity.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import {
  prepareProjectedSessionPresentation,
  shareSidebarSessionRows,
} from "./session-row-presentation.js";
import type { MaterializedRow } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { getSessionDefaults } from "./session-utils-model.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";

type SessionListRead = {
  projection: WeakRef<SessionRowProjection>;
  client?: GatewayClient | null;
  agentId: string;
  key: string;
  storePath: string;
  storeAgentId: string;
  generation: MaterializedRow["generation"];
  sessionId: string;
  lifecycleRevision?: string;
};

// Result rows carry identity, without retaining the owner's materialized metadata graph.
const reads = new WeakMap<object, SessionListRead>();

export function bindSessionListRowRead(
  row: object,
  read: {
    projection: SessionRowProjection;
    record: MaterializedRow;
    client?: GatewayClient | null;
  },
): void {
  reads.set(row, {
    projection: new WeakRef(read.projection),
    client: read.client,
    agentId: read.record.agentId,
    key: read.record.key,
    storePath: read.record.storeTarget.storePath,
    storeAgentId: read.record.storeTarget.agentId,
    generation: read.record.generation,
    sessionId: read.record.entry.sessionId,
    lifecycleRevision: read.record.entry.lifecycleRevision,
  });
}

/** Explicit tool enrichment reads the selected physical owner, never a wire-provided path. */
export async function readSessionListRowTitleFields(row: object, requireOwner: boolean) {
  const selected = reads.get(row);
  if (!selected) {
    if (requireOwner) {
      throw new Error("Session enrichment requires its Gateway or embedded read owner");
    }
    return undefined;
  }
  const visible = await withCurrentSessionListRows([row], ([allowed]) => allowed, true);
  if (!visible) {
    return null;
  }
  const { readSessionTitleFieldsFromTranscriptAsync } =
    await import("./session-transcript-title-reader.js");
  return await readSessionTitleFieldsFromTranscriptAsync({
    agentId: selected.storeAgentId,
    sessionKey: selected.key,
    sessionId: selected.sessionId,
    storePath: selected.storePath,
    sessionEntry: { sessionId: selected.sessionId },
  });
}

/** Finalize buffered enrichment inside one current owner read, without a later await. */
export async function withCurrentSessionListRows<T>(
  rows: readonly object[],
  consume: (visible: readonly boolean[]) => T,
  requireOwner: boolean,
): Promise<T> {
  if (rows.length === 0) {
    return consume([]);
  }
  const captured = rows.map((row) => reads.get(row));
  if (!requireOwner && captured.every((read) => !read)) {
    // A remote client consumes independently authorized RPC responses, not a local owner view.
    return consume(rows.map(() => true));
  }
  const selected = captured.map((read) => {
    if (!read) {
      throw new Error("Session enrichment requires its Gateway or embedded read owner");
    }
    return read;
  });
  const projection = selected[0]!.projection.deref();
  if (!projection || selected.some((read) => read.projection.deref() !== projection)) {
    throw new Error("Gateway changed while preparing session inventory; retry the request");
  }
  return withReadySessionRows(
    projection,
    () => selected.map(({ agentId, key }) => ({ agentId, key })),
    (read) => {
      const presentations = new Map<
        GatewayClient | null | undefined,
        ReturnType<typeof prepareProjectedSessionPresentation>
      >();
      const visible = selected.map((selectedRead) => {
        const { agentId, key, client } = selectedRead;
        const query = { agentId, key };
        const record = read.describe(query);
        if (
          !record ||
          record.agentId !== agentId ||
          record.key !== key ||
          record.storeTarget.storePath !== selectedRead.storePath ||
          record.storeTarget.agentId !== selectedRead.storeAgentId ||
          record.generation !== selectedRead.generation ||
          record.entry.sessionId !== selectedRead.sessionId ||
          record.entry.lifecycleRevision !== selectedRead.lifecycleRevision
        ) {
          return false;
        }
        if (client === undefined) {
          return true;
        }
        let presentation = presentations.get(client);
        if (!presentation) {
          presentation = prepareProjectedSessionPresentation(read, client);
          presentations.set(client, presentation);
        }
        return (
          !presentation.authorizeDescription(query) &&
          presentation.sharing.canReadTarget(presentation.target(query)!)
        );
      });
      return consume(visible);
    },
  );
}

export function buildSessionsListResult(
  params: Pick<SessionListFilterParams, "cfg" | "opts" | "modelCatalog">,
  list: SessionEntrySelection & { now: number; storePath: string },
  { sessions, rowHistory }: { sessions: GatewaySessionRow[]; rowHistory?: SessionRowGeneration[] },
  policyConfig: OpenClawConfig,
  client?: GatewayClient | null,
): SessionsListResult {
  const { cfg, opts, modelCatalog } = params;
  // The defaults projection uses the same agent identity as getSessionDefaults:
  // the requested agent when scoped, otherwise the legacy compatibility agent.
  // Legacy plain-array catalogs (direct list callers) pass through
  // unchanged; per-agent maps resolve by the same identity.
  const defaultsAgentId = normalizeAgentId(
    opts.agentId || (tryResolveLegacyCompatibilityAgentId(cfg) ?? LEGACY_IMPLICIT_AGENT_ID),
  );
  const preparedDefaultsCatalog =
    modelCatalog instanceof Map ? modelCatalog.get(defaultsAgentId) : undefined;
  const defaultsCatalog =
    modelCatalog instanceof Map ? preparedDefaultsCatalog?.entries : modelCatalog;
  const metadataSnapshot = readPreparedGatewayModelMetadata(cfg, preparedDefaultsCatalog);
  const defaults = getSessionDefaults(cfg, defaultsCatalog, {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    allowPluginNormalization: false,
    providerPolicySource: preparedDefaultsCatalog?.pluginRegistry ?? "active",
    metadataSnapshot,
  });
  const policy =
    client === undefined
      ? undefined
      : prepareOperatorModelPresentation({
          cfg,
          policyConfig,
          client,
          metadataSnapshot,
        })?.forAgent(defaultsAgentId, defaultsCatalog);
  const sharedRows =
    opts.rowMode === "sidebar" || opts.ifRowsRevision !== undefined
      ? shareSidebarSessionRows(sessions, opts.ifRowsRevision, rowHistory)
      : { sessions };
  const result = {
    ts: list.now,
    path: list.storePath,
    count: sessions.length,
    totalCount: list.totalCount,
    limitApplied: list.limitApplied,
    offset: list.offset > 0 ? list.offset : undefined,
    nextOffset: list.nextOffset,
    hasMore: list.hasMore,
    owners: list.ownerFacet,
    ...(list.ownerSessionCounts ? { ownerSessionCounts: list.ownerSessionCounts } : {}),
    involvingProfileId: list.involvingProfileId,
    ...(list.activityExpiresAt !== undefined ? { activityExpiresAt: list.activityExpiresAt } : {}),
    ...(list.activityPulse ? { activityPulse: list.activityPulse } : {}),
    ...(list.people
      ? {
          people: list.people,
          peopleIncomplete: list.peopleIncomplete,
          peopleSessionCount: list.peopleSessionCount,
        }
      : {}),
    defaults: policy ? policy.defaults(defaults) : defaults,
    ...sharedRows,
  };
  retainSessionListBaseMiss(result, getSessionListBaseMiss(sharedRows));
  return result;
}
