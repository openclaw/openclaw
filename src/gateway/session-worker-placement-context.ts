import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  registerOpenClawStateDatabaseLifecycleListener,
  requireOpenClawStateDatabaseIdentity,
} from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { SessionWorkerPlacementContext } from "./worker-environments/session-placement-lifecycle.js";

export type { SessionWorkerPlacementContext } from "./worker-environments/session-placement-lifecycle.js";

const localPlacementState = resolveGlobalSingleton(
  Symbol.for("openclaw.localSessionWorkerPlacementContext"),
  (): {
    placement?: {
      store: ReturnType<typeof createWorkerSessionPlacementStore>;
      path: string;
      identityKey: string;
    };
  } => ({}),
  (state) => {
    state.placement = undefined;
  },
);

registerOpenClawStateDatabaseLifecycleListener((event) => {
  const placement = localPlacementState.placement;
  if (
    placement &&
    event.kind !== "opened" &&
    event.kind !== "open-error" &&
    (event.path === placement.path || event.identity?.key === placement.identityKey)
  ) {
    localPlacementState.placement = undefined;
  }
});

/** Uses the live Gateway owner when present; embedded runtimes share the same lightweight DB. */
export function resolveSessionWorkerPlacementContext(
  owner?: GatewayRequestContext,
): SessionWorkerPlacementContext {
  const gatewayContext = getPluginRuntimeGatewayRequestScope()?.context ?? owner;
  if (gatewayContext?.workerSessionPlacementService) {
    return gatewayContext;
  }
  if (!localPlacementState.placement) {
    const database = openOpenClawStateDatabase();
    localPlacementState.placement = {
      store: createWorkerSessionPlacementStore({ database }),
      path: database.path,
      identityKey: requireOpenClawStateDatabaseIdentity(database).key,
    };
  }
  return { workerSessionPlacementService: localPlacementState.placement.store };
}
