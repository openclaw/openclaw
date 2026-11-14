import { types } from "node:util";
import type { GatewayOperatorAccessCause } from "../../packages/gateway-protocol/src/connect-error-details.js";
import {
  assertOperatorAccessDecision,
  type OperatorAccessDecision,
} from "../infra/operator-access-decision.js";
import type {
  PluginGatewayAccessAuthority,
  PluginGatewayAccessPolicy,
} from "./gateway-access-policy.types.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import {
  pluginInvocationContext,
  runOutsidePluginInvocationScope,
  type PluginInstanceHandle,
} from "./plugin-instance-scope.js";

const accessInstances = new WeakMap<PluginGatewayAccessAuthority, PluginInstanceHandle>();

/** Sharing a policy result never bypasses the invocation's own plugin admission. */
export function assertBoundGatewayAccessDecision(
  authority: PluginGatewayAccessAuthority,
  decision: OperatorAccessDecision | undefined,
  assertCurrent: () => void,
): void {
  const instance = accessInstances.get(authority);
  if (!instance || !instance.acceptingCalls || instance.owner?.revoked) {
    return assertCurrent();
  }
  const scope = pluginInvocationContext.getStore();
  assertOperatorAccessDecision(decision, assertCurrent, scope, pluginInstanceInvocation.getStore());
}

/** Policy evaluation owns fresh admission; a caller's finished turn conveys no authority. */
function runAccessPolicy<T>(instance: PluginInstanceHandle, run: () => T): T {
  return runOutsidePluginInvocationScope(() => instance.run(run));
}

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

function bindAccessSignal(
  signal: AbortSignal,
  instance: PluginInstanceHandle,
  recordFailure: (cause: GatewayOperatorAccessCause) => void,
): AbortSignal {
  if (types.isProxy(signal) || !(signal instanceof AbortSignal)) {
    throw new TypeError("Gateway access authority requires a native AbortSignal");
  }
  const source = AbortSignal.any([signal, instance.lifecycle.signal]);
  const controller = new AbortController();
  const relay = () => {
    recordFailure(
      instance.disposing || instance.lifecycle.signal.aborted
        ? "plugin-lifetime-retired"
        : "grant-revoked",
    );
    let reason: unknown;
    try {
      // Reading/projecting a plugin-owned reason can execute accessors or Proxy
      // traps. It retains ordinary admission even though native cleanup does not.
      runAccessPolicy(instance, () => {
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
  const assertCurrent = () => {
    authority.assertCurrent();
  };
  let failureCause: GatewayOperatorAccessCause | undefined;
  const bound: PluginGatewayAccessAuthority = {
    grantId,
    signal: bindAccessSignal(authority.signal, instance, (cause) => {
      failureCause ??= cause;
    }),
    get failureCause() {
      return failureCause;
    },
    assertCurrent: () => {
      try {
        return runAccessPolicy(instance, assertCurrent);
      } catch (error) {
        if (instance.disposing || instance.lifecycle.signal.aborted) {
          failureCause ??= "plugin-lifetime-retired";
        } else if (authority.signal.aborted) {
          failureCause ??= "grant-revoked";
        }
        throw error;
      }
    },
  };
  accessInstances.set(bound, instance);
  return bound;
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
      return runAccessPolicy(instance, () =>
        bindAccessAuthority(policy.authorize(context), instance),
      );
    },
  };
  const resume = runAccessPolicy(instance, () => policy.resume);
  if (resume) {
    bound.resume = (context) =>
      runAccessPolicy(instance, () => bindAccessAuthority(resume.call(policy, context), instance));
  }
  return bound;
}
