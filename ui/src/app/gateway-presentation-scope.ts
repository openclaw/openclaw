import type { ApplicationGateway } from "./gateway.ts";
import type { AuthenticatedUser } from "./user-profile.ts";

type GatewayPresentationScope = {
  readonly key: number;
  displayUser: AuthenticatedUser | null;
  readyOnce: boolean;
};
type OwnedPresentationScope = {
  scope: GatewayPresentationScope;
  revision: number;
  userId?: string;
};

const scopes = new WeakMap<ApplicationGateway, OwnedPresentationScope>();
let nextScopeKey = 0;

/** Stable page scope and display identity; never an authentication source. */
export function gatewayPresentationScope(
  gateway: ApplicationGateway,
): Readonly<GatewayPresentationScope> {
  const revision = gateway.connectionRevision;
  const snapshot = gateway.snapshot;
  const ready = snapshot.phase === "connected" && snapshot.client?.recoveryScopeReady !== false;
  const user = snapshot.phase === "connected" ? (snapshot.selfUser ?? null) : undefined;
  const userId = user?.id;
  const previous = scopes.get(gateway);
  if (
    !previous ||
    previous.revision !== revision ||
    (userId !== undefined && previous.userId !== undefined && previous.userId !== userId)
  ) {
    const next = {
      scope: { key: ++nextScopeKey, displayUser: user ?? null, readyOnce: ready },
      revision,
      userId,
    };
    scopes.set(gateway, next);
    return next.scope;
  }
  // First authentication completes the existing owner; reconnects may temporarily
  // clear selfUser without retiring that owner's mounted pages or loader results.
  previous.userId ??= userId;
  previous.scope.readyOnce ||= ready;
  if (user !== undefined) {
    previous.scope.displayUser = user;
  } else if (snapshot.phase !== "reconnecting" && snapshot.phase !== "reload-required") {
    previous.scope.displayUser = null;
  }
  return previous.scope;
}
