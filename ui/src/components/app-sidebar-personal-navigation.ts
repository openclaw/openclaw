import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { parseSidebarEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type {
  SessionConnectionScope,
  SessionListSnapshot,
} from "../lib/sessions/session-capability.ts";
import { buildReconciledSidebarZone } from "./app-sidebar-session-navigation-logic.ts";
import type { SidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import { applySidebarSessionOwnerFilter } from "./app-sidebar-session-ownership.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SessionOwnerFilterController } from "./session-owner-filter-controller.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

type PersonalNavigationHost = {
  readonly pinnedSessions: SidebarPinnedSessions;
  readonly sidebarSnapshot: SidebarSnapshotModel | null;
  readonly sidebarPluginSnapshot: Pick<SidebarSnapshotModel, "entries" | "plugins"> | null;
  readonly sidebarEntries: readonly string[];
  readonly sessionOwnerFilterId: string | null;
  readonly sessionDataContext:
    | Pick<ApplicationContext, "sessions" | "gateway" | "plugins">
    | undefined;
  readonly navigationCatalog: { readonly dashboards: SessionListSnapshot | null };
  getRouteSessionKey(): string;
  getSessionNavigationState(): SidebarSessionNavigationState;
  findSidebarSessionByKey(key: string): SidebarRecentSession | undefined;
  pluginNavigation(): Parameters<typeof buildReconciledSidebarZone>[0]["pluginNavigation"];
};

/** Descriptor snapshots last one connection; loaded rows always supersede them. */
export class SidebarPinnedSessions implements ReactiveController {
  private source?: ApplicationContext["sessions"];
  private scope: SessionConnectionScope | null = null;
  private readonly requested = new Set<string>();
  private readonly rows = new Map<string, GatewaySessionRow>();

  constructor(
    private readonly host: ReactiveControllerHost & {
      readonly isConnected: boolean;
      readonly sessionDataContext: PersonalNavigationHost["sessionDataContext"];
    },
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.host.requestUpdate();
  }

  hostUpdate(): void {
    if (
      this.scope &&
      (!this.source?.isConnectionScopeCurrent(this.scope) ||
        this.source !== this.host.sessionDataContext?.sessions)
    ) {
      this.clear();
    }
  }

  get(key: string): GatewaySessionRow | undefined {
    const source = this.host.sessionDataContext?.sessions;
    if (source !== this.source || !this.scope || !source?.isConnectionScopeCurrent(this.scope)) {
      this.clear();
      this.source = source;
      this.scope = source?.captureConnectionScope() ?? null;
    }
    const scope = this.scope;
    if (!this.host.isConnected || !source || !scope) {
      return undefined;
    }
    if (!this.requested.has(key)) {
      this.requested.add(key);
      void source.describe({ key }).then(
        (result) => {
          if (
            result.session &&
            this.source === source &&
            this.host.sessionDataContext?.sessions === source &&
            this.scope === scope &&
            source.isConnectionScopeCurrent(scope)
          ) {
            // A title/icon may be stale until the row loads or the connection changes.
            this.rows.set(key, result.session);
            if (this.host.isConnected) {
              this.host.requestUpdate();
            }
          }
        },
        () => {
          /* Missing or failed pins stay saved, invisible, and silent. */
        },
      );
    }
    return this.rows.get(key);
  }

  private clear(): void {
    this.source = undefined;
    this.scope = null;
    this.requested.clear();
    this.rows.clear();
  }
}

export function personalSidebarZone(host: PersonalNavigationHost, rows: SidebarRecentSession[]) {
  const pins = host.sidebarEntries.flatMap((value) => {
    const entry = parseSidebarEntry(value);
    if (entry?.type !== "session") {
      return [];
    }
    const loaded = host.findSidebarSessionByKey(entry.key);
    const snapshot = loaded
      ? undefined
      : (host.navigationCatalog.dashboards?.result?.sessions.find((row) => row.key === entry.key) ??
        host.pinnedSessions.get(entry.key));
    const row =
      loaded ??
      (snapshot ? host.getSessionNavigationState().toSidebarSession(snapshot) : undefined);
    return row ? [row] : [];
  });
  return buildReconciledSidebarZone({
    sidebarEntries: host.sidebarEntries,
    rows: [...pins, ...rows],
    pluginNavigation: host.pluginNavigation(),
    pluginTabs: host.sessionDataContext?.gateway.snapshot.hello?.controlUiTabs,
    snapshot: host.sidebarSnapshot
      ? { model: host.sidebarSnapshot, selectedKey: host.getRouteSessionKey() }
      : undefined,
    pendingPlugins:
      host.sessionDataContext?.plugins.registryStatus !== "complete"
        ? host.sidebarPluginSnapshot
        : null,
  });
}

export function projectUnpinnedSessionRows(
  rows: readonly SidebarRecentSession[],
): SidebarRecentSession[] {
  return rows.map((row) => ({
    ...row,
    pinned: false,
    children: projectUnpinnedSessionRows(row.children),
  }));
}

export function personalSidebarOwnerFilterId(
  host: PersonalNavigationHost & {
    readonly sidebarAgentsMode: "chip" | "roster";
    readonly sessionOwnerFilter: SessionOwnerFilterController;
    expandedAgentId(): string;
  },
): string | null {
  if (host.sidebarSnapshot) {
    return host.sidebarSnapshot.ownerId;
  }
  const agentId = host.sidebarAgentsMode === "roster" ? "*" : host.expandedAgentId();
  const hasMultipleOwners = host.sessionOwnerFilter.hasMultipleOwners(agentId);
  const ownerId = host.sessionOwnerFilter.ownerId;
  const context = host.sessionDataContext;
  // Solo installs must include legacy sessions without owner metadata.
  return ownerId ===
    (context ? gatewayPresentationScope(context.gateway).displayUser?.id : undefined) &&
    context?.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities === false &&
    !hasMultipleOwners
    ? null
    : ownerId;
}

export function personalSidebarOwnerProjection(
  host: PersonalNavigationHost,
  projected: SidebarRecentSession[],
  ownerFacet: SessionsListResult["owners"],
) {
  const context = host.sessionDataContext;
  const self = context ? gatewayPresentationScope(context.gateway).displayUser : null;
  return applySidebarSessionOwnerFilter({
    projected,
    ownerFacet,
    selectedOwnerId: host.sessionOwnerFilterId,
    selectedProfileId: host.sessionOwnerFilterId === self?.id ? self.id : undefined,
    self,
  });
}
