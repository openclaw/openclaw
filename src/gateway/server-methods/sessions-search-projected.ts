import type {
  SessionsSearchParams,
  SessionsSearchResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { withAgentRosterFactsBatch } from "../../agents/agent-scope-config.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import type { SessionStoreTarget } from "../../config/sessions/targets.js";
import { runSynchronousWork } from "../../shared/synchronous-work.js";
import { filterSessionEntries } from "../session-list-filters.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { prepareProjectedSessionList } from "../session-utils-list.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

/** Search all selected resident metadata; only matching rows cross the wire. */
export async function searchProjectedSessionTranscripts(params: {
  query: string;
  limit?: number;
  scope: NonNullable<SessionsSearchParams["scope"]>;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  onResult: (result: SessionsSearchResult) => void;
}) {
  const projection = getSessionRowProjection(params.context);
  if (!projection) {
    throw new Error("Session projection is unavailable before Gateway startup completes");
  }
  do {
    await projection.ensureMaterialized();
  } while (projection.needsMaterialization);
  // Caller identity and federation are prepared after the final readiness wait.
  // Keep authorization, FTS selection, row presentation, and reply synchronous.
  const { prepared, presentation, filters } = prepareProjectedSessionList({
    projection,
    opts: params.scope,
    context: params.context,
    client: params.client,
    now: Date.now(),
  });
  const { entries } = withAgentRosterFactsBatch(prepared.cfg, () =>
    runSynchronousWork(filterSessionEntries(filters)),
  );
  type SelectedRow = NonNullable<ReturnType<typeof prepared.getTarget>>;
  const stores = new Map<string, { target: SessionStoreTarget; rows: Map<string, SelectedRow> }>();
  for (const [key] of entries) {
    const row = prepared.getTarget(key);
    if (!row) {
      continue;
    }
    const store = stores.get(row.storeTarget.storePath) ?? {
      target: row.storeTarget,
      rows: new Map<string, SelectedRow>(),
    };
    store.rows.set(row.key, row);
    stores.set(row.storeTarget.storePath, store);
  }
  const limit = params.limit ?? 10;
  // Each physical store gets its entire authorized key set before LIMIT. The
  // existing SQLite set binding has no per-key bind limit; empty sets never run.
  const pages = [...stores.values()].map(({ target, rows }) => {
    const page = searchSessionTranscripts({
      ...target,
      sessionKeys: [...rows.keys()],
      query: params.query,
      limit,
    });
    return {
      indexing: page.indexing,
      truncated: page.truncated,
      archivedTranscriptsExcluded: page.archivedTranscriptsExcluded,
      matches: page.hits.flatMap((hit) => {
        // Sharing belongs to the current logical node, while hits can belong to
        // retained pre-reset windows. Canonical commits invalidate this projection.
        const row = rows.get(hit.sessionKey);
        return row ? [{ hit, row }] : [];
      }),
    };
  });
  const hits = pages
    .flatMap((page) => page.matches)
    .toSorted(
      (left, right) =>
        right.hit.score - left.hit.score ||
        right.hit.timestamp - left.hit.timestamp ||
        left.hit.messageId.localeCompare(right.hit.messageId),
    );
  const matches = hits.slice(0, limit);
  const rows = new Set(matches.map((match) => match.row));
  projection.setArchivePageSize(rows.size);
  const sessions = [...rows].flatMap((target) => {
    const record = projection.describe({ ...target, storePath: target.storeTarget.storePath });
    const row = record && presentation.present(record);
    return row ? [row] : [];
  });
  const archivedTranscriptsExcluded = pages.reduce(
    (count, page) => count + (page.archivedTranscriptsExcluded ?? 0),
    0,
  );
  params.onResult({
    results: matches.map((match) => match.hit),
    sessions,
    ...(pages.some((page) => page.indexing) ? { indexing: true } : {}),
    ...(archivedTranscriptsExcluded ? { archivedTranscriptsExcluded } : {}),
    ...(hits.length > limit || pages.some((page) => page.truncated) ? { truncated: true } : {}),
  });
}
