import { notifyListeners, registerListener } from "../../shared/listeners.js";
import type { RespondFn } from "../server-methods/response-types.js";

export type GatewayPolicyClient = {
  invalidated?: boolean;
  invalidatedReason?: string;
  /** Committed source invalidation is independent of a tentative transport fence. */
  sourceInvalidated?: boolean;
  socket: { close: (code: number, reason: string) => void };
};

const policyMethods = new Set([
  "config.set",
  "config.patch",
  "config.apply",
  "secrets.reload",
  "secrets.store.set",
  "secrets.store.delete",
  "device.pair.remove",
  "device.token.rotate",
  "device.token.revoke",
]);
type PolicyResponse = { readonly pending: boolean; hold: () => void; finish: () => void };
type PolicyClientState = { pending: number; close?: () => void };
const responses = new WeakMap<RespondFn, PolicyResponse>();
const clients = new WeakMap<GatewayPolicyClient, PolicyClientState>();
const invalidationListeners = new WeakMap<GatewayPolicyClient, Set<() => void>>();

export function hasCurrentGatewayPolicyClientSource(client: GatewayPolicyClient): boolean {
  return !(client.sourceInvalidated ?? client.invalidated ?? false);
}

/** Accepted work follows authentication invalidation even after its transport disconnects. */
export function onGatewayPolicyClientInvalidated(
  client: GatewayPolicyClient,
  listener: () => void,
): () => void {
  if (!hasCurrentGatewayPolicyClientSource(client)) {
    listener();
    return () => {};
  }
  let listeners = invalidationListeners.get(client);
  if (!listeners) {
    listeners = new Set();
    invalidationListeners.set(client, listeners);
  }
  const unsubscribe = registerListener(listeners, listener);
  return () => {
    unsubscribe();
    if (listeners.size === 0 && invalidationListeners.get(client) === listeners) {
      invalidationListeners.delete(client);
    }
  };
}

/** The dispatcher owns response completion, including throws and handlers that return silently. */
export function registerGatewayPolicyResponse(
  method: string,
  client: GatewayPolicyClient,
  respond: RespondFn,
): PolicyResponse | undefined {
  if (!policyMethods.has(method)) {
    return undefined;
  }
  let state: PolicyClientState | undefined;
  const response: PolicyResponse = {
    get pending() {
      return state !== undefined;
    },
    hold() {
      if (state) {
        return;
      }
      if (client.invalidated) {
        throw new Error("client authorization is no longer active");
      }
      state = clients.get(client) ?? { pending: 0 };
      state.pending++;
      clients.set(client, state);
    },
    finish() {
      responses.delete(respond);
      if (!state) {
        return;
      }
      const completed = state;
      state = undefined;
      if (--completed.pending === 0) {
        clients.delete(client);
        completed.close?.();
      }
    },
  };
  responses.set(respond, response);
  return response;
}

/** Claim only at the mutation owner, after request validation and before publication can revoke it. */
export function holdGatewayPolicyResponse(respond: RespondFn | undefined): void {
  if (respond) {
    responses.get(respond)?.hold();
  }
}

/** Fence requests immediately; tentative reloads preserve already accepted source authority. */
export function invalidateGatewayPolicyClient(
  client: GatewayPolicyClient,
  policy: {
    reason: string;
    code: number;
    message: string;
    close?: () => void;
    revokeSource?: boolean;
  },
): void {
  client.sourceInvalidated =
    (client.sourceInvalidated ?? client.invalidated ?? false) || policy.revokeSource !== false;
  client.invalidated = true;
  client.invalidatedReason ??= policy.reason;
  if (client.sourceInvalidated) {
    const listeners = invalidationListeners.get(client);
    invalidationListeners.delete(client);
    notifyListeners(listeners ?? [], undefined);
  }
  const close = () => {
    try {
      if (policy.close) {
        policy.close();
      } else {
        client.socket.close(policy.code, policy.message);
      }
    } catch {
      // The connection may have closed independently while its write completed.
    }
  };
  const state = clients.get(client);
  if (state) {
    state.close ??= close;
  } else {
    close();
  }
}
