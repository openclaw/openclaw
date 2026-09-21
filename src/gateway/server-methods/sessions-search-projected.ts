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
  const select = () => {
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
    const stores = new Map<
      string,
      { target: SessionStoreTarget; rows: Map<string, SelectedRow> }
    >();
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
    return { stores, presentation };
  };
  const limit = params.limit ?? 10;
  for (let attempt = 0; attempt < 2; attempt++) {
    do {
      await projection.ensureMaterialized();
    } while (projection.needsMaterialization);
    const selected = select();
    // Filter every physical store before LIMIT. Never dispatch an empty key set.
    const pages = await Promise.all(
      [...selected.stores].map(async ([path, { target, rows }]) => ({
        path,
        page: await searchSessionTranscripts(
          {
            ...target,
            sessionKeys: [...rows.keys()],
            query: params.query,
            limit,
          },
          { agentId: target.agentId, path: target.storePath },
        ),
      })),
    );
    if (getSessionRowProjection(params.context) !== projection) {
      throw new Error("Session search owner changed while reading; retry the request");
    }
    if (projection.needsMaterialization) {
      continue;
    }
    // Reacquire viewer identity, roles, sharing, and presentation after the await.
    // A changed scope invalidates the entire page, including counts and truncation.
    const current = select();
    if (
      selected.stores.size !== current.stores.size ||
      [...selected.stores].some(([path, store]) => {
        const next = current.stores.get(path);
        return (
          !next ||
          store.target.agentId !== next.target.agentId ||
          store.rows.size !== next.rows.size ||
          [...store.rows].some(([key, row]) => next.rows.get(key)?.generation !== row.generation)
        );
      })
    ) {
      continue;
    }
    const hits = pages
      .flatMap(({ path, page }) =>
        page.hits.flatMap((hit) => {
          const row = current.stores.get(path)?.rows.get(hit.sessionKey);
          return row ? [{ hit, row }] : [];
        }),
      )
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
      const row = record && current.presentation.present(record);
      return row ? [row] : [];
    });
    const archivedTranscriptsExcluded = pages.reduce(
      (count, { page }) => count + (page.archivedTranscriptsExcluded ?? 0),
      0,
    );
    params.onResult({
      results: matches.map((match) => match.hit),
      sessions,
      ...(pages.some(({ page }) => page.indexing) ? { indexing: true } : {}),
      ...(archivedTranscriptsExcluded ? { archivedTranscriptsExcluded } : {}),
      ...(hits.length > limit || pages.some(({ page }) => page.truncated)
        ? { truncated: true }
        : {}),
    });
    return;
  }
  throw new Error("Session search scope changed while reading; retry the request");
}
