import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { InternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createPendingPromiseTracker } from "../shared/pending-promises.js";
import { resolveSessionEventAgentScope } from "./session-request-agent.js";
import {
  type SessionRowPreparationOptions,
  type SessionRowReadView,
  withReadySessionRows,
} from "./session-row-prepared-read.js";
import type { Lookup } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const publicationOwners = new WeakMap<
  SessionRowProjection,
  ReturnType<typeof createPublicationOwner>
>();

function createPublicationOwner(projection: SessionRowProjection) {
  const pending = new Set<Promise<unknown>>();
  const track = createPendingPromiseTracker(pending);
  const rows: Pick<SessionRowProjection, "withPreparedExactRows"> = {
    withPreparedExactRows(queries, consume, options) {
      return track(projection.withPreparedExactRows(queries, consume, options));
    },
  };
  return {
    rows: {
      ...rows,
      track,
      withReadyRows<T>(
        queries: (config: SessionRowReadView["state"]["cfg"]) => readonly Lookup[],
        consume: (read: SessionRowReadView) => T,
        options?: SessionRowPreparationOptions,
      ) {
        return track(withReadySessionRows(rows, queries, consume, options));
      },
    },
    async drain() {
      while (pending.size > 0) {
        await Promise.allSettled(pending);
      }
    },
  };
}

/** Track accepted publications while the projection owns preparation and its per-turn budget. */
export function sessionEventPublicationRows(projection: SessionRowProjection) {
  let owner = publicationOwners.get(projection);
  if (!owner) {
    owner = createPublicationOwner(projection);
    publicationOwners.set(projection, owner);
  }
  return owner.rows;
}

export async function drainSessionEventPublications(projection: SessionRowProjection) {
  await publicationOwners.get(projection)?.drain();
}

export async function withPreparedEventRow(
  projection: SessionRowProjection | undefined,
  query: { key: string; agentId: string; storePath?: string } | undefined,
  publish: (
    read?: SessionRowReadView,
    ancestors?: ReturnType<SessionRowProjection["ancestorRows"]>,
  ) => void,
) {
  if (!projection || !query) {
    publish();
    return;
  }
  await sessionEventPublicationRows(projection).withReadyRows(
    () => [query],
    (read) => {
      const record = read.describe(query);
      const ancestors = record ? projection.ancestorRows(record, read) : undefined;
      const rows = record ? [record, ...(ancestors ?? [])] : [];
      const children = new Set<string>();
      for (const row of rows) {
        for (const group of row.materialized.row.swarm?.groups ?? []) {
          for (const child of group.children ?? []) {
            children.add(child.sessionKey);
          }
        }
      }
      // Resolve child metadata before the transport catches serialization errors.
      // Pending worker facts must reach the preparation owner's existing retry.
      for (const key of children) {
        read.selectEntries({ key });
      }
      publish(read, ancestors);
    },
    { includeAncestors: true },
  );
}

export async function withPreparedSessionEventRow(
  projection: SessionRowProjection | undefined,
  sessionKey: string,
  eventAgentId: string | undefined,
  publish: (read?: SessionRowReadView) => void,
) {
  if (!projection) {
    publish();
    return;
  }
  const routingAgentId = resolveSessionEventAgentScope(
    getRuntimeConfig(),
    sessionKey,
    eventAgentId,
  )?.[1];
  if (routingAgentId) {
    await withPreparedEventRow(projection, { key: sessionKey, agentId: routingAgentId }, publish);
    return;
  }
  do {
    await projection.ensureMaterialized();
  } while (projection.needsMaterialization);
  publish();
}

export function readTranscriptUpdateLifecycleOwner(
  update: InternalSessionTranscriptUpdate,
  projection: SessionRowProjection | undefined,
): { sessionId: string; lifecycleRevision?: string } | undefined {
  const marker = parseSqliteSessionFileMarker(update.sessionFile);
  const sessionKey =
    normalizeOptionalString(update.target?.sessionKey) ??
    normalizeOptionalString(update.sessionKey) ??
    (marker ? projection?.findBySessionId(marker)[0]?.key : undefined);
  if (!sessionKey) {
    return undefined;
  }
  const agentId =
    normalizeOptionalString(update.target?.agentId) ??
    normalizeOptionalString(update.agentId) ??
    marker?.agentId;
  const sessionId =
    normalizeOptionalString(update.target?.sessionId) ??
    normalizeOptionalString(update.sessionId) ??
    marker?.sessionId;
  const storePath = normalizeOptionalString(update.target?.storePath) ?? marker?.storePath;
  const ownerAgentId =
    agentId ?? resolveSessionEventAgentScope(getRuntimeConfig(), sessionKey)?.[1];
  const entry = ownerAgentId
    ? projection?.capture({ agentId: ownerAgentId, key: sessionKey, storePath })?.entry
    : undefined;
  if (!entry || (sessionId && entry.sessionId !== sessionId)) {
    return undefined;
  }
  const lifecycleRevision = normalizeOptionalString(entry.lifecycleRevision);
  return { sessionId: entry.sessionId, ...(lifecycleRevision ? { lifecycleRevision } : {}) };
}
