import type {
  SessionsSearchParams,
  SessionsSearchResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { withAgentRosterFactsBatch } from "../../agents/agent-scope-config.js";
import { captureLifecycleDatabaseScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import { transcriptSearchLane } from "../../config/sessions/session-transcript-worker-resources.js";
import type { SessionStoreTarget } from "../../config/sessions/targets.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { filterSessionEntries } from "../session-list-filters.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import { deriveSessionTitle } from "../session-utils-core.js";
import { resolveGatewaySessionDisplayName } from "../session-utils-display.js";
import {
  prepareProjectedSessionList,
  prepareSessionSearchIdentityNames,
} from "../session-utils-list.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

/** Search all selected resident metadata; only matching rows cross the wire. */
export async function searchProjectedSessionTranscripts(params: {
  query: string;
  limit?: number;
  scope: NonNullable<SessionsSearchParams["scope"]>;
  personalPins?: ReadonlyMap<string, number> | null;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  onResult: (result: SessionsSearchResult) => void;
}) {
  const projection = requireSessionRowProjection(params.context);
  const selection = {
    metadataOnly: !params.scope.search?.trim() && params.scope.hasBoard === undefined,
    includeCatalog: true,
  };
  let searchIdentities: Awaited<ReturnType<typeof prepareSessionSearchIdentityNames>> | undefined;
  const select = () => {
    const { prepared, presentation, filters } = prepareProjectedSessionList({
      projection,
      opts: params.scope,
      personalPins: params.personalPins,
      context: params.context,
      client: params.client,
      now: Date.now(),
      searchIdentities,
      metadataPrepared: true,
    });
    const { entries } = withAgentRosterFactsBatch(prepared.cfg, () =>
      filterSessionEntries(filters),
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
  const sameSelection = (previous: ReturnType<typeof select>, current: ReturnType<typeof select>) =>
    previous.stores.size === current.stores.size &&
    [...previous.stores].every(([path, store]) => {
      const next = current.stores.get(path);
      return (
        next !== undefined &&
        store.target.agentId === next.target.agentId &&
        store.rows.size === next.rows.size &&
        [...store.rows].every(([key, row]) => next.rows.get(key)?.generation === row.generation)
      );
    });
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
  return projection.withSelectionPreparation(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      do {
        await projection.prepareSelection(selection);
        if (params.scope.search?.trim()) {
          searchIdentities = await prepareSessionSearchIdentityNames(
            projection,
            params.scope,
            true,
          );
        }
      } while (
        projection.needsSelectionPreparation(selection) ||
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
        projection.needsSelectionPreparation(selection) ||
        (searchIdentities && searchIdentities.cfg !== projection.state.cfg)
      ) {
        continue;
      }
      // Reacquire viewer identity, roles, sharing, and presentation after the await.
      // A changed scope invalidates the entire page, including counts and truncation.
      const current = select();
      if (!sameSelection(selected, current)) {
        continue;
      }
      const hits = matchingHits(current, pages);
      const matches = hits.slice(0, limit);
      const matchedRows = new Set(matches.map(({ row }) => row));
      // Resolve only missing titles for distinct, admitted hits on the globally ranked page.
      // Reuse the physical stores that produced those hits, not a store inferred from a key.
      type HitRow = (typeof matches)[number]["row"];
      const untitledByStore = new Map<SessionStoreTarget, HitRow[]>();
      const rowsWithCurrentHits = new Set(
        matches
          .filter(({ hit, row }) => hit.sessionId === row.entry.sessionId)
          .map(({ row }) => row),
      );
      for (const row of rowsWithCurrentHits) {
        if (
          isIncognitoSessionKey(row.key) ||
          deriveSessionTitle(
            row.entry,
            undefined,
            resolveGatewaySessionDisplayName(row.key, row.entry),
          )
        ) {
          continue;
        }
        const store = current.stores.get(row.storeTarget.storePath)!.target;
        const rows = untitledByStore.get(store);
        if (rows) {
          rows.push(row);
        } else {
          untitledByStore.set(store, [row]);
        }
      }
      const titles = new Map<HitRow, string>();
      if (untitledByStore.size) {
        const { withSessionHistoryWorkerDatabase } =
          await import("../../config/sessions/session-transcript-worker-runtime.js");
        const signal = getAsyncWorkSignal();
        await Promise.all(
          Array.from(untitledByStore, async ([store, rows]) => {
            const { path, env } = captureLifecycleDatabaseScope({
              agentId: store.agentId,
              databaseAgentId: store.agentId,
              path: store.storePath,
            });
            const read = await withSessionHistoryWorkerDatabase(
              { agentId: store.agentId, path, env },
              (worker) =>
                worker.readSearchTitles(
                  {
                    env,
                    sessions: rows.map((row) => ({
                      sessionKey: row.key,
                      sessionId: row.entry.sessionId,
                    })),
                  },
                  signal,
                ),
              transcriptSearchLane,
            ).catch(() => {
              signal?.throwIfAborted();
              // Optional naming must not discard otherwise valid search hits.
              return [];
            });
            for (const [index, title] of read.entries()) {
              if (title) {
                titles.set(rows[index]!, title);
              }
            }
          }),
        );
      }
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
          const refreshed = select();
          if (!sameSelection(selected, refreshed)) {
            return false;
          }
          const sessions = [...matchedRows].flatMap((target) => {
            const record = read.describe({
              ...target,
              storePath: target.storeTarget.storePath,
            });
            const row =
              record &&
              refreshed.presentation.present(record, {
                includeDerivedTitles: true,
                personalPins: params.personalPins,
              });
            if (!row) {
              return [];
            }
            const title = row.sessionId === target.entry.sessionId ? titles.get(target) : undefined;
            return [row.derivedTitle || !title ? row : { ...row, derivedTitle: title }];
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
          return true;
        },
        { selection },
      );
      if (published) {
        return;
      }
    }
    throw new Error("Session search scope changed while reading; retry the request");
  });
}
