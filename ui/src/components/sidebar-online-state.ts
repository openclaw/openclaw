import type { ApplicationGateway } from "../app/gateway.ts";
import { projectOnlinePresenceViewers, profilePresenceViewer } from "../lib/presence-users.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { SidebarOnlineOrder } from "./sidebar-online-order.ts";

const onlineOrders = new WeakMap<
  HTMLElement,
  {
    gateway: ApplicationGateway | undefined;
    revision: number | undefined;
    viewerId: string | undefined;
    order: SidebarOnlineOrder;
  }
>();

export function sidebarOnlineOrder(host: AppSidebarRenderHost): SidebarOnlineOrder {
  const element = host.hostElement;
  const gateway = host.sessionDataContext?.gateway;
  const revision = gateway?.connectionRevision;
  const viewerId = host.sidebarSnapshot?.footer?.id ?? gateway?.snapshot.selfUser?.id;
  let cached = onlineOrders.get(element);
  if (
    !cached ||
    cached.gateway !== gateway ||
    cached.revision !== revision ||
    cached.viewerId !== viewerId
  ) {
    cached = { gateway, revision, viewerId, order: new SidebarOnlineOrder() };
    onlineOrders.set(element, cached);
  }
  return cached.order;
}

export function resolveSidebarOnline(host: AppSidebarRenderHost) {
  const saved = host.sidebarSnapshot;
  return sidebarOnlineOrder(host).resolve({
    users:
      saved?.onlineUsers ??
      (host.sessionData.presencePayload
        ? projectOnlinePresenceViewers(host.sessionData.presencePayload)
        : null),
    counts: saved ? new Map(saved.onlineCounts) : host.sessionData.ownerCounts.counts,
    countsFailed: !saved && host.sessionData.ownerCounts.error !== null,
    presentation: saved ? "snapshot" : "live",
    sortMode: host.people.sortMode,
    statusFilter: host.people.statusFilter,
    offlineUsers:
      saved?.offlineUsers ??
      (host.peopleView?.directory()?.result?.profiles ?? [])
        .filter((profile) => !profile.mergedInto)
        .map(profilePresenceViewer),
    presenceFilter: host.people.presenceFilter,
  });
}
