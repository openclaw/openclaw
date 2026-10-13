import { types } from "node:util";
import type {
  PluginGatewayAccessAuthority,
  PluginGatewayAccessPolicy,
} from "./gateway-access-policy.types.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import type { PluginInstanceHandle } from "./plugin-instance-scope.js";

// Native AbortSignal composition stores internal WeakRefs. Recursively proxying
// those values makes Node's eventual GC cleanup call a retired plugin instance.
const signalRelays = new WeakMap<AbortSignal, () => void>();
const signalRelayCleanup = new FinalizationRegistry<() => void>((release) => release());

function observeNativeAbort(source: AbortSignal, relay: WeakRef<() => void>, token: object) {
  const onAbort = () => {
    try {
      relay.deref()?.();
    } finally {
      release();
    }
  };
  function release() {
    EventTarget.prototype.removeEventListener.call(source, "abort", onAbort);
    signalRelayCleanup.unregister(token);
  }
  EventTarget.prototype.addEventListener.call(source, "abort", onAbort, { once: true });
  return release;
}

function bindAccessSignal(signal: AbortSignal, instance: PluginInstanceHandle): AbortSignal {
  if (types.isProxy(signal) || !(signal instanceof AbortSignal)) {
    throw new TypeError("Gateway access authority requires a native AbortSignal");
  }
  const source = AbortSignal.any([signal, instance.lifecycle.signal]);
  const controller = new AbortController();
  const relay = () => {
    let reason: unknown;
    try {
      // Reading/projecting a plugin-owned reason can execute accessors or Proxy
      // traps. It retains ordinary admission even though native cleanup does not.
      instance.run(() => {
        reason = instance.wrap(source.reason);
      });
    } catch {
      reason = new PluginInstanceUnavailableError(instance.pluginId);
    }
    controller.abort(reason);
    signalRelays.delete(controller.signal);
  };
  if (source.aborted) {
    relay();
    return controller.signal;
  }
  const token = {};
  const release = observeNativeAbort(source, new WeakRef(relay), token);
  signalRelays.set(controller.signal, relay);
  signalRelayCleanup.register(relay, release, token);
  return controller.signal;
}

function bindAccessAuthority(
  authority: PluginGatewayAccessAuthority | undefined,
  instance: PluginInstanceHandle,
): PluginGatewayAccessAuthority | undefined {
  if (!authority) {
    return undefined;
  }
  const grantId = authority.grantId;
  if (grantId !== undefined && typeof grantId !== "string") {
    throw new TypeError("Gateway access grant identity must be a string");
  }
  return {
    grantId,
    signal: bindAccessSignal(authority.signal, instance),
    assertCurrent: () =>
      instance.run(() => {
        authority.assertCurrent();
      }),
  };
}

/** Preserve native signals while every plugin callback retains its original owner. */
export function bindPluginGatewayAccessPolicy(
  policy: PluginGatewayAccessPolicy,
  instance: PluginInstanceHandle | undefined,
): PluginGatewayAccessPolicy {
  if (!instance) {
    return policy;
  }
  const bound: PluginGatewayAccessPolicy = {
    authorize(context) {
      return instance.run(() => bindAccessAuthority(policy.authorize(context), instance));
    },
  };
  const resume = instance.run(() => policy.resume);
  if (resume) {
    bound.resume = (context) =>
      instance.run(() => bindAccessAuthority(resume.call(policy, context), instance));
  }
  return bound;
}
