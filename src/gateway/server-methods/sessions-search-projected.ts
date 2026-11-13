import type {
  SessionsSearchParams,
  SessionsSearchResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { withAgentRosterFactsBatch } from "../../agents/agent-scope-config.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import type { SessionStoreTarget } from "../../config/sessions/targets.js";
import { filterSessionEntries } from "../session-list-filters.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import type { SelectionRow } from "../session-row-projection-record.js";
import { registerSerializedSessionRowArray } from "../session-row-serialization.js";
import {
  prepareProjectedSessionList,
  prepareSessionSearchIdentityNames,
} from "../session-utils-list.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

/** Search all selected resident metadata; only matching rows cross the wire. */
export async function searchProjectedSessionTranscripts(params: {
  query: string;
  limit?: number;
  acceptsSerializedJson?: boolean;
  scope: NonNullable<SessionsSearchParams["scope"]>;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  onResult: (result: SessionsSearchResult) => void;
}) {
  const projection = requireSessionRowProjection(params.context);
  let searchIdentities: Awaited<ReturnType<typeof prepareSessionSearchIdentityNames>> | undefined;
  type SelectedScope = {
    witness?: {
      revision: object;
      cfg: typeof projection.state.cfg;
      identities: object | undefined;
      audience: string;
    };
    stores: Map<string, { target: SessionStoreTarget; rows: Map<string, SelectionRow> }>;
    count: number;
  };
  const select = (previous?: SelectedScope) => {
    const { prepared, presentation, filters } = prepareProjectedSessionList({
      projection,
      opts: params.scope,
      context: params.context,
      client: params.client,
      now: Date.now(),
      searchIdentities,
    });
    const state = projection.state;
    // Reuse only within this request, after reacquiring current viewer authority.
    // Invitations and clock/runtime-dependent scopes still reselect every row.
    const witness =
      presentation.sharing.sessionCap !== "invited" &&
      !params.scope.search &&
      !params.scope.spawnedBy &&
      !params.scope.activeOnly &&
      params.scope.activeMinutes === undefined
        ? {
            revision: state.revision,
            cfg: state.cfg,
            identities: state.rowContext.identityProjection?.revision,
            audience: presentation.sharing.getCacheKey(),
          }
        : undefined;
    if (
      witness &&
      previous?.witness &&
      witness.revision === previous.witness.revision &&
      witness.cfg === previous.witness.cfg &&
      witness.identities === previous.witness.identities &&
      witness.audience === previous.witness.audience
    ) {
      return { ...previous, presentation, unchanged: true };
    }
    const { entries } = withAgentRosterFactsBatch(prepared.cfg, () =>
      // Transcript search consumes membership, not the list's owner-facet presentation.
      filterSessionEntries(filters, undefined, false),
    );
    const stores: SelectedScope["stores"] = previous?.stores ?? new Map();
    let count = 0;
    let unchanged = true;
    for (const [key] of entries) {
      const row = prepared.getTarget(key);
      if (!row) {
        continue;
      }
      count++;
      if (previous) {
        // The selection owner yields unique physical rows. Recheck every current
        // member and generation without allocating another copy of the same maps.
        const store = stores.get(row.storeTarget.storePath);
        unchanged &&=
          store?.target.agentId === row.storeTarget.agentId &&
          store.rows.get(row.key)?.generation === row.generation;
        continue;
      }
      const store = stores.get(row.storeTarget.storePath) ?? {
        target: row.storeTarget,
        rows: new Map<string, SelectionRow>(),
      };
      store.rows.set(row.key, row);
      stores.set(row.storeTarget.storePath, store);
    }
    return {
      witness,
      stores,
      count,
      presentation,
      unchanged: unchanged && (!previous || count === previous.count),
    };
  };
  const limit = params.limit ?? 10;
  const matchingHits = (
    selected: ReturnType<typeof select>,
    pages: Array<{ path: string; page: Awaited<ReturnType<typeof searchSessionTranscripts>> }>,
  ) =>
    pages
      .flatMap(({ path, page }) =>
        page.hits.flatMap((hit) => {
          const row = selected.stores.get(path)?.rows.get(hit.sessionKey);
          return row ? [{ hit, row }] : [];
        }),
      )
      // oxlint-disable-next-line unicorn/no-array-sort -- flatMap returns a fresh, private array.
      .sort(
        (left, right) =>
          right.hit.score - left.hit.score ||
          right.hit.timestamp - left.hit.timestamp ||
          left.hit.messageId.localeCompare(right.hit.messageId),
      );
  for (let attempt = 0; attempt < 2; attempt++) {
    do {
      await projection.ensureMaterialized();
      if (params.scope.search?.trim()) {
        searchIdentities = await prepareSessionSearchIdentityNames(projection, params.scope);
      }
    } while (
      projection.needsMaterialization ||
      (searchIdentities && searchIdentities.cfg !== projection.state.cfg)
    );
    const selected = select();
    // Filter every physical store before LIMIT. Never dispatch an empty key set.
    const pages = await Promise.all(
      Array.from(selected.stores, async ([path, { target, rows }]) => ({
        path,
        page: await searchSessionTranscripts(
          {
            ...target,
            sessionKeys: [...rows.keys()],
            query: params.query,
            match: "prefix",
            limit,
          },
          { agentId: target.agentId, path: target.storePath },
        ),
      })),
    );
    if (getSessionRowProjection(params.context) !== projection) {
      throw new Error("Session search owner changed while reading; retry the request");
    }
    if (
      projection.needsMaterialization ||
      (searchIdentities && searchIdentities.cfg !== projection.state.cfg)
    ) {
      continue;
    }
    // Reacquire viewer identity, roles, sharing, and presentation after the await.
    // A changed scope invalidates the entire page, including counts and truncation.
    const current = select(selected);
    if (!current.unchanged) {
      continue;
    }
    const hits = matchingHits(current, pages);
    const matches = hits.slice(0, limit);
    const matchedRows = new Set(matches.map(({ row }) => row));
    const published = await withReadySessionRows(
      projection,
      () => {
        projection.setArchivePageSize(matchedRows.size);
        return [...matchedRows].map((row) => ({
          agentId: row.agentId,
          key: row.key,
          storePath: row.storeTarget.storePath,
        }));
      },
      (read) => {
        if (getSessionRowProjection(params.context) !== projection) {
          throw new Error("Session search owner changed while reading; retry the request");
        }
        if (searchIdentities && searchIdentities.cfg !== projection.state.cfg) {
          return false;
        }
        const refreshed = select(selected);
        if (!refreshed.unchanged) {
          return false;
        }
        const sessions = [...matchedRows].flatMap((target) => {
          const record = read.describe({
            ...target,
            storePath: target.storeTarget.storePath,
          });
          const row = record && refreshed.presentation.present(record);
          return row ? [row] : [];
        });
        const archivedTranscriptsExcluded = pages.reduce(
          (count, { page }) => count + (page.archivedTranscriptsExcluded ?? 0),
          0,
        );
        if (params.acceptsSerializedJson) {
          registerSerializedSessionRowArray(sessions);
        }
        params.onResult({
          results: matches.map((match) => match.hit),
          sessions,
          ...(pages.some(({ page }) => page.indexing) ? { indexing: true } : {}),
          ...(archivedTranscriptsExcluded ? { archivedTranscriptsExcluded } : {}),
          ...(hits.length > limit || pages.some(({ page }) => page.truncated)
            ? { truncated: true }
            : {}),
        });
        return true;
      },
      { selection: true },
    );
    if (published) {
      return;
    }
  }
  throw new Error("Session search scope changed while reading; retry the request");
}
