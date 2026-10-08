import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";

export type GatewayConnectionSnapshot = Pick<ApplicationGatewaySnapshot, "client" | "phase">;

export type GatewayConnectionScope = {
  readonly client: GatewayBrowserClient;
  readonly epoch: number;
};

export function createGatewayConnectionLifecycle(snapshot: GatewayConnectionSnapshot) {
  let client = snapshot.client;
  let connected = snapshot.phase === "connected";
  let epoch = 0;
  let disposed = false;

  return {
    get epoch() {
      return epoch;
    },
    capture(this: void) {
      return !disposed && connected && client ? { client, epoch } : null;
    },
    isCurrent(this: void, scope: GatewayConnectionScope) {
      return !disposed && connected && client === scope.client && epoch === scope.epoch;
    },
    invalidate(this: void) {
      if (!disposed) {
        epoch += 1;
      }
    },
    transition(this: void, next: GatewayConnectionSnapshot) {
      if (disposed) {
        return false;
      }
      const nextConnected = next.phase === "connected";
      const changed = client !== next.client || connected !== nextConnected;
      if (changed) {
        epoch += 1;
      }
      client = next.client;
      connected = nextConnected;
      return changed;
    },
    dispose(this: void) {
      if (!disposed) {
        disposed = true;
        epoch += 1;
      }
    },
  };
}
