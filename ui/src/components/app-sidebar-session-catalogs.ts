import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { repoName } from "../lib/session-display.ts";
import type {
  CatalogSessionContinuedDetail,
  CatalogSessionKey,
} from "../lib/sessions/catalog-key.ts";
import { buildCatalogSessionKey, parseCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";

export function formatSidebarTimestamp(timestampMs: number | null | undefined): string {
  const now = Date.now();
  if (
    timestampMs != null &&
    Number.isFinite(timestampMs) &&
    timestampMs <= now &&
    now - timestampMs < 60_000
  ) {
    return t("common.now");
  }
  return formatRelativeTimestamp(timestampMs, {
    fallback: "",
    suffix: timestampMs != null && timestampMs > now,
  });
}

export function normalizeCatalogTimestamp(timestamp: number | undefined): number | undefined {
  return timestamp !== undefined && timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

export function findCatalogSessionHovercardRow(params: {
  catalogs: readonly SessionCatalog[];
  sessionKey: string;
  liveRow?: SidebarSessionHovercardRow;
}): SidebarSessionHovercardRow | undefined {
  const catalogKey = parseCatalogSessionKey(params.sessionKey);
  for (const catalog of params.catalogs) {
    for (const host of catalog.hosts) {
      for (const session of host.sessions) {
        const key =
          session.sessionKey ??
          buildCatalogSessionKey({
            catalogId: catalog.id,
            hostId: host.hostId,
            threadId: session.threadId,
          });
        const matchesCatalogKey =
          // Routed catalog keys keep agent ownership; source lookup ignores only that prefix.
          catalogKey?.catalogId === catalog.id &&
          catalogKey.hostId === host.hostId &&
          catalogKey.threadId === session.threadId;
        if (key !== params.sessionKey && !matchesCatalogKey) {
          continue;
        }
        const cwd = normalizeOptionalString(session.cwd);
        const branch = normalizeOptionalString(session.gitBranch);
        // A catalog cwd is authoritative workspace context, but it does not by
        // itself prove repository identity; only projected Git facts do that.
        return {
          ...params.liveRow,
          hasActiveRun: params.liveRow?.hasActiveRun === true,
          hasAutomation: params.liveRow?.hasAutomation === true,
          label: params.liveRow?.label ?? (session.name || session.threadId),
          // Once adopted, even an unset live color overrides stale catalog metadata.
          color: params.liveRow ? params.liveRow.color : session.color,
          createdActor: params.liveRow?.createdActor ?? session.createdActor,
          createdAt: params.liveRow?.createdAt ?? normalizeCatalogTimestamp(session.createdAt),
          updatedAt: params.liveRow?.updatedAt ?? normalizeCatalogTimestamp(session.updatedAt),
          workContext: cwd
            ? branch || session.pullRequest
              ? {
                  kind: "project",
                  name: repoName(cwd),
                  path: cwd,
                  ...(branch ? { branch } : {}),
                }
              : { kind: "workspace", name: repoName(cwd), path: cwd }
            : params.liveRow?.workContext,
        };
      }
    }
  }
  return params.liveRow;
}

/** Session keys already adopted into OpenClaw sessions; the regular list hides
    these so each adopted session stays a single selectable catalog row. */
export function adoptedCatalogSessionKeys(catalogs: readonly SessionCatalog[]): Set<string> {
  const keys = new Set<string>();
  for (const catalog of catalogs) {
    for (const host of catalog.hosts) {
      for (const session of host.sessions) {
        if (session.sessionKey) {
          keys.add(session.sessionKey);
        }
      }
    }
  }
  return keys;
}

export function catalogErrorMessages(catalog: SessionCatalog): string[] {
  const messages = new Set<string>();
  const add = (error: SessionCatalog["error"]) => {
    if (error) {
      messages.add(formatUiError(`[${error.code}] ${error.message}`));
    }
  };
  add(catalog.error);
  for (const host of catalog.hosts) {
    // A disconnected empty host is normal fleet state, not a provider failure.
    // Cached rows still expose the host-level offline badge when the host is visible.
    if (host.error?.code !== "NODE_OFFLINE") {
      add(host.error);
    }
  }
  return [...messages];
}

export type SidebarSessionCatalog = SessionCatalog & { visibleHosts: SessionCatalogHost[] };

type SessionVisibilityRow = Pick<GatewaySessionRow, "key" | "archived" | "snoozedUntil">;

/** Section peers and rendering share the same nonempty, owner-filtered catalogs. */
export function projectSidebarSessionCatalogs(
  catalogs: readonly SessionCatalog[],
  ownerId: string | null,
  liveRows: readonly GatewaySessionRow[],
  isSessionHidden?: (row: SessionVisibilityRow) => boolean,
): SidebarSessionCatalog[] {
  // The current list wins over cached agent lists, including an unset live owner.
  const liveRowsByKey = new Map(liveRows.toReversed().map((row) => [row.key, row]));
  return catalogs.flatMap((catalog) => {
    const visibleHosts = visibleCatalogHosts(
      catalog.hosts,
      ownerId,
      liveRowsByKey,
      isSessionHidden,
    );
    return visibleHosts.length > 0 ? [{ ...catalog, visibleHosts }] : [];
  });
}

function visibleCatalogHosts(
  hosts: readonly SessionCatalogHost[],
  ownerId: string | null,
  liveRowsByKey: ReadonlyMap<string, GatewaySessionRow>,
  isSessionHidden?: (row: SessionVisibilityRow) => boolean,
): SessionCatalogHost[] {
  const visible: SessionCatalogHost[] = [];
  for (const host of hosts) {
    const sessions = host.sessions.filter((session) => {
      const adoptedRow = session.sessionKey ? liveRowsByKey.get(session.sessionKey) : undefined;
      // A committed archive can leave the loaded roster before the catalog refreshes.
      // Its adopted key still belongs to the canonical session lifecycle owner.
      if (session.sessionKey && isSessionHidden?.(adoptedRow ?? { key: session.sessionKey })) {
        return false;
      }
      if (!ownerId) {
        return true;
      }
      const effectiveOwnerId = adoptedRow ? adoptedRow.owner?.actor.id : session.createdActor?.id;
      return effectiveOwnerId === ownerId;
    });
    if (sessions.length > 0) {
      visible.push(sessions.length === host.sessions.length ? host : { ...host, sessions });
    }
  }
  return visible;
}

export type CatalogBackingSessionDisplay = {
  catalogIdentityKey: string;
  catalogMenu: CatalogSessionMenuRequest;
  rowRef?: (element: Element | undefined) => void;
  pullRequest?: SessionCatalogSession["pullRequest"];
};

export type CatalogSessionMenuRequest = {
  key: CatalogSessionKey;
  agentId: string;
  routeId: "chat" | "new-session";
  navigation: ApplicationNavigationOptions;
  canOpenTerminal: boolean;
  canDelete: boolean;
  name: string;
  meta: string;
};

/** Stamps a freshly adopted session key onto its catalog row so the sidebar
    binds it before the next catalog poll confirms the adoption. */
export function bindAdoptedCatalogSession(
  catalogs: readonly SessionCatalog[],
  detail: CatalogSessionContinuedDetail,
): SessionCatalog[] {
  return catalogs.map((catalog) =>
    catalog.id === detail.catalogId
      ? {
          ...catalog,
          hosts: catalog.hosts.map((host) =>
            host.hostId === detail.hostId
              ? {
                  ...host,
                  sessions: host.sessions.map((session) =>
                    session.threadId === detail.threadId
                      ? { ...session, sessionKey: detail.sessionKey }
                      : session,
                  ),
                }
              : host,
          ),
        }
      : catalog,
  );
}
