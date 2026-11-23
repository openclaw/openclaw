import type { SessionCatalogProfileRelation } from "../../../../packages/gateway-protocol/src/index.js";
import type { BoardFace } from "../board/settings.ts";

type SessionNavigationHandoffOwner = {
  readonly snapshot: {
    readonly client: object | null;
    readonly hello: object | null;
  };
};

export const SESSION_NAVIGATION_INTENT_EVENT = "openclaw:session-navigation-intent";
export type SessionNavigationIntent = {
  agentId?: string;
  commit: () => boolean;
  face: BoardFace;
  sessionKey: string;
};
type SessionNavigationIntentOwner = {
  readonly isConnected: boolean;
  readonly activeRouteId?: unknown;
  readonly sessionKey?: unknown;
};
const sessionNavigationHandoffs = new WeakMap<
  SessionNavigationHandoffOwner,
  {
    pathname: string;
    sessionKey: string;
    catalogProfileRelation?: SessionCatalogProfileRelation;
    client: object | null;
    hello: object | null;
  }
>();
const sessionNavigationIntents = new WeakMap<SessionNavigationIntentOwner, object>();

export function runSessionNavigationIntent(
  owner: SessionNavigationIntentOwner,
  intent: SessionNavigationIntent,
): void {
  const token = {};
  const activeRouteId = owner.activeRouteId;
  const sourceSessionKey = owner.sessionKey;
  sessionNavigationIntents.set(owner, token);
  const guarded = {
    ...intent,
    commit: () => {
      if (
        !owner.isConnected ||
        owner.activeRouteId !== activeRouteId ||
        owner.sessionKey !== sourceSessionKey ||
        sessionNavigationIntents.get(owner) !== token
      ) {
        return false;
      }
      sessionNavigationIntents.delete(owner);
      return intent.commit();
    },
  };
  const event = new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
    cancelable: true,
    detail: guarded,
  });
  globalThis.dispatchEvent(event);
  if (!event.defaultPrevented) {
    guarded.commit();
  }
}

export function prepareSessionNavigationHandoff(
  owner: SessionNavigationHandoffOwner,
  pathname: string,
  sessionKey: string,
  catalogProfileRelation?: SessionCatalogProfileRelation,
): void {
  const { client, hello } = owner.snapshot;
  const handoff = {
    pathname,
    sessionKey,
    client,
    hello,
    ...(catalogProfileRelation
      ? { catalogProfileRelation: structuredClone(catalogProfileRelation) }
      : {}),
  };
  sessionNavigationHandoffs.set(owner, handoff);
}

export function consumeSessionNavigationHandoff(
  owner: SessionNavigationHandoffOwner,
  pathname: string,
  expectedSessionKey?: string,
): { sessionKey: string; catalogProfileRelation?: SessionCatalogProfileRelation } | undefined {
  const handoff = sessionNavigationHandoffs.get(owner);
  if (
    !handoff ||
    handoff.pathname !== pathname ||
    (expectedSessionKey !== undefined && handoff.sessionKey !== expectedSessionKey)
  ) {
    sessionNavigationHandoffs.delete(owner);
    return undefined;
  }
  sessionNavigationHandoffs.delete(owner);
  // Browser clients survive transport reconnects, so hello identity must also
  // match before an old connection can bypass authoritative route resolution.
  const { client, hello } = owner.snapshot;
  if (handoff.client !== client || handoff.hello !== hello) {
    return undefined;
  }
  return handoff;
}
