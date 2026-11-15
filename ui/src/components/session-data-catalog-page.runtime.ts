import type {
  SessionsCatalogListParams,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";
import { mergeSessionCatalogPage } from "./session-data-catalog-page-merge.ts";
import type { SessionCatalogDataOwner } from "./session-data-catalog.ts";

/** Execute an admitted incremental page; fresh-window reauthorization stays with the owner. */
export async function loadSessionCatalogPage({
  owner,
  client,
  request,
  cursors,
  discovering,
  isCurrent,
}: {
  owner: SessionCatalogDataOwner;
  client: GatewayBrowserClient;
  request: SessionsCatalogListParams & { catalogId: string };
  cursors: Record<string, string>;
  discovering: boolean;
  isCurrent: () => boolean;
}): Promise<void> {
  const catalogId = request.catalogId;
  const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", request);
  if (!isCurrent()) {
    return;
  }
  const page = result.catalogs.find((candidate) => candidate.id === catalogId);
  const current = owner.sessionCatalogs.find((candidate) => candidate.id === catalogId);
  if (!current) {
    return;
  }
  const discoveryPages = owner.sessionCatalogLive.discoveryPages;
  const merged = mergeSessionCatalogPage({
    current,
    page,
    cursors,
    previousCursors: new Map(
      current.hosts.flatMap((host) => {
        const discovery = discoveryPages.get(sessionCatalogHostKey(catalogId, host.hostId));
        return discovery ? [[host.hostId, discovery.cursors] as const] : [];
      }),
    ),
  });
  for (const hostId of merged.repeatedHostIds) {
    discoveryPages.delete(sessionCatalogHostKey(catalogId, hostId));
  }
  for (const [hostId, cursor] of Object.entries(cursors)) {
    if (!merged.advancedHostIds.includes(hostId)) {
      continue;
    }
    const key = sessionCatalogHostKey(catalogId, hostId);
    const discovery = discoveryPages.get(key);
    const previous = current.hosts.find((host) => host.hostId === hostId);
    const nextHost = merged.catalog.hosts.find((host) => host.hostId === hostId);
    const depth = (discovery?.depth ?? owner.sessionCatalogPageDepths.get(key) ?? 0) + 1;
    if (
      discovering &&
      previous?.sessions.length === 0 &&
      nextHost?.sessions.length === 0 &&
      !owner.sessionCatalogPageDepths.has(key)
    ) {
      if (nextHost.nextCursor) {
        const seenCursors = discovery?.cursors ?? new Set<string>();
        seenCursors.add(cursor);
        discoveryPages.set(key, {
          headCursor: discovery?.headCursor ?? cursor,
          nextCursor: nextHost.nextCursor,
          depth,
          cursors: seenCursors,
        });
      } else {
        // Renew the sweep at the next invalidation: membership can change behind a cursor.
        discoveryPages.delete(key);
      }
    } else {
      discoveryPages.delete(key);
      owner.sessionCatalogPageDepths.set(key, depth);
    }
  }
  owner.sessionCatalogs = owner.sessionCatalogs.map((candidate) =>
    candidate.id === catalogId ? merged.catalog : candidate,
  );
  owner.requestSessionDataUpdate();
  owner.sessionCatalogRevision += 1;
}
