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

type PolicyRevision = Readonly<{ revision: string }>;
type PublishedPolicyRevision = {
  instance: PluginInstanceHandle;
  current: PolicyRevision | undefined;
};
const policyRevisions = new WeakMap<PluginGatewayAccessPolicy, PublishedPolicyRevision>();

/** Reads only host-owned publication state; never invokes plugin code on a cache hit. */
export function readGatewayAccessPolicyRevision(
  policy: PluginGatewayAccessPolicy,
): PolicyRevision | undefined {
  const publication = policyRevisions.get(policy);
  if (!publication) {
    return undefined;
  }
  const instance = publication.instance;
  return instance.acceptingCalls && !instance.owner?.revoked && !instance.lifecycle.signal.aborted
    ? publication.current
    : undefined;
}

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
  runPolicy: <T>(run: () => T) => T,
): PluginGatewayAccessAuthority | undefined {
  if (!authority) {
    return undefined;
  }
  const grantId = authority.grantId;
  if (grantId !== undefined && typeof grantId !== "string") {
    throw new TypeError("Gateway access grant identity must be a string");
  }
  let recheckValidUntil: number | undefined;
  return {
    grantId,
    signal: bindAccessSignal(authority.signal, instance),
    get recheckValidUntil() {
      return recheckValidUntil;
    },
    assertCurrent: () =>
      runPolicy(() => {
        recheckValidUntil = undefined;
        authority.assertCurrent();
        const validity = authority.recheckValidUntil;
        if (
          validity !== undefined &&
          (typeof validity !== "number" || Number.isNaN(validity) || validity < 0)
        ) {
          throw new TypeError(
            "Gateway access recheck validity must be a Unix-ms deadline or Infinity",
          );
        }
        recheckValidUntil = validity;
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
  const publication: PublishedPolicyRevision = { instance, current: undefined };
  const runPolicy = <T>(run: () => T): T => {
    try {
      return instance.run(run);
    } catch (error) {
      publication.current = undefined;
      throw error;
    }
  };
  const bound: PluginGatewayAccessPolicy = {
    authorize(context) {
      return runPolicy(() => bindAccessAuthority(policy.authorize(context), instance, runPolicy));
    },
  };
  const resume = runPolicy(() => policy.resume);
  if (resume) {
    bound.resume = (context) =>
      runPolicy(() => bindAccessAuthority(resume.call(policy, context), instance, runPolicy));
  }
  const subscribeRevision = runPolicy(() => policy.subscribeRevision);
  if (subscribeRevision) {
    const unsubscribe = runPolicy(() =>
      subscribeRevision.call(policy, (revision) => {
        publication.current = undefined;
        if (
          !instance.acceptingCalls ||
          instance.owner?.revoked ||
          instance.lifecycle.signal.aborted
        ) {
          return;
        }
        if (revision !== undefined && (typeof revision !== "string" || revision.length === 0)) {
          throw new TypeError(
            "Gateway access policy revision must be a nonempty string or undefined",
          );
        }
        if (revision !== undefined) {
          publication.current = Object.freeze({ revision });
        }
      }),
    );
    if (typeof unsubscribe !== "function") {
      publication.current = undefined;
      throw new TypeError("Gateway access policy revision subscription requires an unsubscribe");
    }
    policyRevisions.set(bound, publication);
    instance.lifecycle.onDispose(() => {
      publication.current = undefined;
      instance.runCleanup(unsubscribe);
    });
  }
  return bound;
}
