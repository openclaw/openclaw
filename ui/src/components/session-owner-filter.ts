import { createEffect, createSignal, onCleanup } from "solid-js";
import type { SessionsListResult } from "../api/types.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { isRestrictedSessionGuest } from "../app/operator-access.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
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

  constructor(
    private readonly getGateway: () => ApplicationGateway | undefined,
    private readonly notify: () => void,
  ) {}

  get selfUserId(): string | undefined {
    const gateway = this.getGateway();
    return gateway ? gatewayPresentationScope(gateway).displayUser?.id.trim() : undefined;
  }

  read() {
    const gateway = this.getGateway();
    const selfUserId = this.selfUserId;
    const scope =
      gateway && selfUserId ? JSON.stringify([gateway.connection.gatewayUrl, selfUserId]) : null;
    if (scope !== this.value.scope) {
      this.userIntent = false;
      this.ownerFacet = null;
      this.value = {
        ...(gateway && selfUserId
          ? loadStoredSidebarSessionOwnerFilter(gateway.connection.gatewayUrl, selfUserId, {
              guest: isRestrictedSessionGuest(gateway.snapshot.hello?.auth ?? null),
            })
          : { ownerId: null, involvingMe: false }),
        scope,
      };
    }
    return this.value;
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

  set(ownerId: string | null, involvingMe = false, options?: { automatic: true }): void {
    this.read();
    this.value = {
      ownerId: involvingMe ? null : ownerId?.trim() || null,
      involvingMe,
      scope: this.value.scope,
    };
    this.userIntent ||= !options?.automatic;
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
  getFacet: () => Omit<SessionListSnapshot, "agentId"> | undefined,
) {
  let previous: string | undefined;
  let pending: Promise<void> | null = null;
  const [settled, setSettled] = createSignal(0);
  createEffect(
    () => {
      settled();
      const host = getHost();
      const query = host.sidebarSessionOwnerFilter();
      return {
        host,
        current: JSON.stringify([query.ownerId, query.involvingMe, filter.read().scope]),
        facet: getFacet(),
      };
    },
    ({ host, current, facet }) => {
      const userIntent = filter.takeUserIntent();
      if (!host.isConnected) {
        previous = undefined;
        pending = null;
        return;
      }
      const prior = previous;
      previous = current;
      if (prior !== current) {
        if (prior) {
          host.sessionData.resetSessionList();
        }
        const request = userIntent
          ? host.sessionData.refreshSidebarSessions()
          : host.sessionData.scheduleSidebarSessions();
        pending = request;
        void request.finally(() => {
          if (pending === request) {
            pending = null;
            setSettled((value) => value + 1);
          }
        });
      } else if (
        !pending &&
        facet &&
        !facet.loading &&
        !facet.startupPending &&
        !facet.error &&
        facet.readSucceeded !== false &&
        facet.result?.owners &&
        filter.read().ownerId &&
        filter.read().ownerId !== filter.selfUserId &&
        !facet.result.owners.some((owner) => owner.id === filter.read().ownerId)
      ) {
        filter.set(null, false, { automatic: true });
      }
    },
  );
  onCleanup(() => {
    pending = null;
    filter.takeUserIntent();
  });
}
