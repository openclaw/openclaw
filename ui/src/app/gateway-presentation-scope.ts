import { readOfflineStorageScope } from "./boot-record.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import type { AuthenticatedUser } from "./user-profile.ts";

type GatewayPresentationScope = {
  readonly key: number;
  displayUser: AuthenticatedUser | null;
  readyOnce: boolean;
};
type OwnedPresentationScope = {
  scope: GatewayPresentationScope;
  revision: number | undefined;
  userId?: string;
  recoveryScope?: string;
};
type GatewayPresentationSource = {
  readonly snapshot: Pick<ApplicationGatewaySnapshot, "client" | "phase"> &
    Partial<Pick<ApplicationGatewaySnapshot, "hello" | "selfUser">>;
  readonly connectionRevision?: number;
};

const scopes = new WeakMap<GatewayPresentationSource, OwnedPresentationScope>();
let nextScopeKey = 0;

/** Stable page scope and display identity; never an authentication source. */
export function gatewayPresentationScope(
  gateway: GatewayPresentationSource,
): Readonly<GatewayPresentationScope> {
  const revision = gateway.connectionRevision;
  const snapshot = gateway.snapshot;
  const ready = snapshot.phase === "connected" && snapshot.client?.recoveryScopeReady !== false;
  const user = snapshot.phase === "connected" ? snapshot.selfUser : undefined;
  const userId = user?.id;
  const recoveryScope = snapshot.client?.offlineRecoveryRetired
    ? undefined
    : (snapshot.hello?.auth?.recoveryScope ?? readOfflineStorageScope({ client: snapshot.client }));
  const previous = scopes.get(gateway);
  if (
    !previous ||
    previous.revision !== revision ||
    (previous.recoveryScope !== undefined &&
      recoveryScope !== undefined &&
      previous.recoveryScope !== recoveryScope) ||
    (snapshot.client?.offlineRecoveryRetired === true && previous.recoveryScope !== undefined) ||
    (userId !== undefined && previous.userId !== undefined && previous.userId !== userId)
  ) {
    const next = {
      scope: { key: ++nextScopeKey, displayUser: user ?? null, readyOnce: ready },
      revision,
      userId,
      recoveryScope,
    };
    scopes.set(gateway, next);
    return next.scope;
  }
  // Transport/startup phases may temporarily clear selfUser, including after
  // hello while users.self is pending. Keep display identity in this scope until
  // explicit profileless resolution or stop; it never grants request authority.
  previous.userId ??= userId;
  previous.recoveryScope ??= recoveryScope;
  previous.scope.readyOnce ||= ready;
  if (user !== undefined) {
    previous.scope.displayUser = user;
  } else if (snapshot.phase === "stopped") {
    previous.scope.displayUser = null;
  }
  return previous.scope;
}
