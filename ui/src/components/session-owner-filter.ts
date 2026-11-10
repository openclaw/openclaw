import { createEffect, onCleanup } from "solid-js";
import type { SessionsListResult } from "../api/types.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { isRestrictedSessionGuest } from "../app/operator-access.ts";
import {
  loadStoredSidebarSessionOwnerFilter,
  storeSidebarSessionOwnerFilter,
  type SidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";

/** Saved query membership stays synchronous, including the first session-list subscription. */
export class SessionOwnerFilter {
  private value: SidebarSessionOwnerFilter & { scope: string | null } = {
    ownerId: null,
    involvingMe: false,
    scope: null,
  };
  private userIntent = false;
  private ownerFacet: { agentId: string; multiple: boolean } | null = null;
  private admittedHello: ApplicationGateway["snapshot"]["hello"] = null;

  constructor(
    private readonly getGateway: () => ApplicationGateway | undefined,
    private readonly notify: () => void,
  ) {}

  get selfUserId(): string | undefined {
    const gateway = this.getGateway();
    if (gateway?.snapshot.phase === "connected") {
      const viewerId = gateway.snapshot.hello?.auth?.profileActivityViewerId;
      if (viewerId !== undefined) {
        return viewerId ?? undefined;
      }
    }
    return gateway ? gatewayPresentationScope(gateway).displayUser?.id.trim() : undefined;
  }

  read() {
    const gateway = this.getGateway();
    const selfUserId = this.selfUserId;
    const hello = gateway?.snapshot.phase === "connected" ? gateway.snapshot.hello : undefined;
    const viewerId = hello?.auth?.profileActivityViewerId;
    const scope =
      gateway && selfUserId ? JSON.stringify([gateway.connection.gatewayUrl, selfUserId]) : null;
    const scopeChanged = scope !== this.value.scope;
    let value = this.value;
    if (scopeChanged) {
      value = {
        ...(gateway && selfUserId
          ? loadStoredSidebarSessionOwnerFilter(gateway.connection.gatewayUrl, selfUserId, {
              guest: typeof viewerId === "string" || isRestrictedSessionGuest(hello?.auth ?? null),
            })
          : { ownerId: null, involvingMe: false }),
        scope,
      };
    }
    // Admit restored/prior-authority choices once per authenticated hello. Explicit
    // choices within that hello retain their visible server denial instead of resetting.
    if (gateway && hello && (scopeChanged || hello !== this.admittedHello)) {
      this.admittedHello = hello;
      if (typeof viewerId === "string" && value.ownerId && value.ownerId !== viewerId) {
        value = { ownerId: null, involvingMe: true, scope };
        storeSidebarSessionOwnerFilter(gateway.connection.gatewayUrl, viewerId, value);
      }
    }
    if (value !== this.value) {
      this.userIntent = false;
      this.ownerFacet = null;
      this.value = value;
    }
    return value;
  }

  hasMultipleOwners(agentId: string): boolean {
    this.read();
    return this.ownerFacet?.agentId === agentId && this.ownerFacet.multiple;
  }

  observeOwnerFacet(agentId: string, owners: SessionsListResult["owners"]): void {
    this.read();
    // Filtered rows never replace the complete owner facet that selected their query.
    if (owners !== undefined) {
      const selfUserId = this.selfUserId;
      this.ownerFacet = {
        agentId,
        multiple: owners.some((owner) => owner.type !== "human" || owner.id !== selfUserId),
      };
    }
  }

  takeUserIntent(): boolean {
    const intent = this.userIntent;
    this.userIntent = false;
    return intent;
  }

  set(ownerId: string | null, involvingMe = false): void {
    this.read();
    this.value = {
      ownerId: involvingMe ? null : ownerId?.trim() || null,
      involvingMe,
      scope: this.value.scope,
    };
    this.userIntent = true;
    const gateway = this.getGateway();
    const selfUserId = this.selfUserId;
    if (gateway && selfUserId) {
      storeSidebarSessionOwnerFilter(gateway.connection.gatewayUrl, selfUserId, this.value);
    }
    this.notify();
  }
}

/** Solid owns query refresh observation; the session capability owns reads and admission. */
export function createSessionOwnerFilterQuery(
  filter: SessionOwnerFilter,
  getHost: () => {
    isConnected: boolean;
    sidebarSessionOwnerFilter(): SidebarSessionOwnerFilter;
    sessionData: {
      resetSessionList(): void;
      refreshSidebarSessions(): Promise<void>;
      scheduleSidebarSessions(): Promise<void>;
    };
  },
) {
  let previous: string | undefined;
  createEffect(
    () => {
      const host = getHost();
      const query = host.sidebarSessionOwnerFilter();
      return {
        host,
        current: JSON.stringify([query.ownerId, query.involvingMe, filter.read().scope]),
      };
    },
    ({ host, current }) => {
      const userIntent = filter.takeUserIntent();
      if (!host.isConnected) {
        previous = undefined;
        return;
      }
      const prior = previous;
      previous = current;
      if (prior !== current) {
        if (prior) {
          host.sessionData.resetSessionList();
        }
        void (userIntent
          ? host.sessionData.refreshSidebarSessions()
          : host.sessionData.scheduleSidebarSessions());
      }
    },
  );
  onCleanup(() => {
    filter.takeUserIntent();
  });
}
