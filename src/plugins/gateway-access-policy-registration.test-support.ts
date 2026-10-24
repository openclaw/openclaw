import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { types } from "node:util";
import { readGatewayAccessPolicyRevision } from "./gateway-access-policy-registration.js";
import type {
  PluginGatewayAccessAuthority,
  PluginGatewayAccessPolicy,
} from "./gateway-access-policy.types.js";
import { createPluginRecord } from "./loader-records.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";

const grantId = "780a6c68-5d66-4df6-b4e8-dba6d24264a2";

const context = {
  config: {},
  profile: {
    profileId: "access-signal-profile",
    emails: ["access-signal@example.test"],
    assignedRole: "guest",
  },
  requiredByRole: true,
};

const resumedContext = {
  ...context,
  profile: { ...context.profile, assignedRole: "staff" },
  requiredByRole: false,
  grantId,
};

function assertNativeAuthority(authority: PluginGatewayAccessAuthority | undefined) {
  assert.ok(authority);
  assert.equal(authority.grantId, grantId, "Registration must preserve the original grant");
  assert.equal(types.isProxy(authority.signal), false, "Native cleanup must not enter a proxy");
  authority.assertCurrent();
  return authority;
}

function createRegisteredPolicy(resumable = true, revisioned = false) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "person-access",
    source: "native-access-signal-test",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {}, registrationMode: "full" });
  const instance = getPluginInstance(record);
  assert.ok(instance, "Registration must use the production PluginInstance owner");
  const grant = new AbortController();
  const lifetime = new AbortController();
  let validUntil = Infinity;
  let publication: ((revision: string | undefined) => void) | undefined;
  let unsubscribed = false;
  let failAssertion = false;
  const createAuthority = () =>
    Object.freeze({
      grantId,
      assertCurrent() {
        assert(!failAssertion, "Synthetic policy unavailable");
        grant.signal.throwIfAborted();
        lifetime.signal.throwIfAborted();
      },
      get recheckValidUntil() {
        assert(instance.hasActiveCall, "Plugin validity getters need a live instance scope");
        return revisioned ? validUntil : undefined;
      },
      signal: AbortSignal.any([grant.signal, lifetime.signal]),
    });
  const originalPolicy: PluginGatewayAccessPolicy = {
    authorize(currentContext) {
      return currentContext.requiredByRole ? createAuthority() : undefined;
    },
    resume(currentContext) {
      assert.equal(this, originalPolicy, "Resume must retain its plugin receiver");
      assert.deepEqual(currentContext, resumedContext);
      return currentContext.grantId === grantId ? createAuthority() : undefined;
    },
  };
  if (revisioned) {
    originalPolicy.subscribeRevision = (publish) => {
      assert(instance.hasActiveCall, "Subscription setup needs a live instance scope");
      publication = publish;
      publish("initial");
      return () => {
        unsubscribed = true;
      };
    };
  }
  if (!resumable) {
    delete originalPolicy.resume;
  }
  api.registerGatewayAccessPolicy(originalPolicy);
  const registration = builder.registry.gatewayAccessPolicies[0];
  assert.ok(registration);
  const authorize = () => assertNativeAuthority(registration.policy.authorize(context));
  const resume = () => assertNativeAuthority(registration.policy.resume?.(resumedContext));
  return {
    grant,
    lifetime,
    instance,
    registration,
    authorize,
    resume,
    publish: (revision: string | undefined) => publication?.(revision),
    setValidity: (value: number) => {
      validUntil = value;
    },
    failAssertion: () => {
      failAssertion = true;
    },
    isUnsubscribed: () => unsubscribed,
  };
}

type Policy = ReturnType<typeof createRegisteredPolicy>;
type References = Record<string, WeakRef<object>>;

async function collect(references: References) {
  const gc = globalThis.gc;
  assert.ok(gc, "The retention child requires --expose-gc");
  const control = new WeakRef({ unowned: true });
  // Match the existing native service-retention proof's bounded GC convergence.
  for (let pass = 0; pass < 32; pass += 1) {
    await setImmediate();
    gc();
  }
  await setImmediate();
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  for (const [name, reference] of Object.entries(references)) {
    assert.equal(reference.deref(), undefined, `${name} must collect`);
  }
}

class RevocationReason extends Promise<void> {
  #message = "Access ended";

  read() {
    return this.#message;
  }
}

async function retireRegisteredPolicy(): Promise<References> {
  const policy = createRegisteredPolicy(false);
  assert.equal(typeof policy.registration.policy.resume, "undefined");
  const authority = policy.authorize();
  const hostInvalidated = new AbortController();
  const hostSignal = AbortSignal.any([hostInvalidated.signal, authority.signal]);
  const onAbort = () => undefined;
  hostSignal.addEventListener("abort", onAbort, { once: true });
  assert.equal(hostSignal.aborted, false);

  // Preserve the failing order: requester release, service stop, instance retirement, GC.
  hostSignal.removeEventListener("abort", onAbort);
  const reason = new RevocationReason(() => undefined);
  policy.grant.abort(reason);
  policy.lifetime.abort();
  assert.equal(authority.signal.aborted, true);
  const exposedReason: unknown = authority.signal.reason;
  assert.ok(exposedReason instanceof RevocationReason);
  assert.notEqual(exposedReason, reason);
  const readReason = exposedReason.read.bind(exposedReason);
  assert.equal(readReason(), "Access ended");
  assert.deepEqual((await policy.instance.dispose()).errors, []);
  assert.throws(
    () => policy.registration.policy.authorize(context),
    PluginInstanceUnavailableError,
  );
  assert.throws(authority.assertCurrent, PluginInstanceUnavailableError);
  assert.throws(readReason, PluginInstanceUnavailableError);
  assert.equal(authority.signal.reason, exposedReason);
  assert.equal(hostSignal.aborted, true);
  return {
    hostSignal: new WeakRef(hostSignal),
    authority: new WeakRef(authority),
    policySignal: new WeakRef(authority.signal),
  };
}

function completeCapture(policy: Policy): References {
  const authority = policy.authorize();
  const hostSignal = AbortSignal.any([authority.signal]);
  const onAbort = () => undefined;
  hostSignal.addEventListener("abort", onAbort, { once: true });
  hostSignal.removeEventListener("abort", onAbort);
  return {
    authority: new WeakRef(authority),
    policySignal: new WeakRef(authority.signal),
    hostSignal: new WeakRef(hostSignal),
  };
}

async function observeLiveGrant() {
  const policy = createRegisteredPolicy();
  try {
    const completed = completeCapture(policy);
    assert.equal(policy.registration.policy.authorize(resumedContext), undefined);
    const retainedSignal = policy.resume().signal;
    await collect(completed);
    assert.equal(policy.grant.signal.aborted, false, "Collection must not end the live grant");
    assert.equal(retainedSignal.aborted, false);
    policy.grant.abort("Expired grant");
    assert.equal(retainedSignal.aborted, true, "Signal-only custody must retain its native relay");
    assert.equal(retainedSignal.reason, "Expired grant");
  } finally {
    assert.deepEqual((await policy.instance.dispose()).errors, []);
  }

  const nextPolicy = createRegisteredPolicy();
  const nextAuthority = nextPolicy.resume();
  const nextSignal = nextAuthority.signal;
  assert.deepEqual((await nextPolicy.instance.dispose()).errors, []);
  assert.equal(nextPolicy.grant.signal.aborted, false);
  assert.equal(nextSignal.aborted, true, "Plugin retirement must end still-live access");
  assert.throws(nextPolicy.resume, PluginInstanceUnavailableError);
  assert.throws(nextAuthority.assertCurrent, PluginInstanceUnavailableError);
}

async function observePolicyRevision() {
  const policy = createRegisteredPolicy(true, true);
  const bound = policy.registration.policy;
  const initial = readGatewayAccessPolicyRevision(bound);
  assert.deepEqual(initial, { revision: "initial" });
  const authority = policy.authorize();
  assert.equal(authority.recheckValidUntil, Infinity);
  policy.setValidity(1234);
  assert.equal(authority.recheckValidUntil, Infinity, "Host reads never execute a plugin getter");
  authority.assertCurrent();
  assert.equal(authority.recheckValidUntil, 1234);
  policy.publish(undefined);
  assert.equal(readGatewayAccessPolicyRevision(bound), undefined);
  policy.publish("next");
  assert.notEqual(readGatewayAccessPolicyRevision(bound), initial);
  policy.failAssertion();
  assert.throws(authority.assertCurrent, /Synthetic policy unavailable/);
  assert.equal(readGatewayAccessPolicyRevision(bound), undefined);
  assert.equal(authority.recheckValidUntil, undefined);
  policy.publish("restored");
  assert.deepEqual(readGatewayAccessPolicyRevision(bound), { revision: "restored" });
  assert.deepEqual((await policy.instance.dispose()).errors, []);
  assert.equal(policy.isUnsubscribed(), true);
  assert.equal(readGatewayAccessPolicyRevision(bound), undefined);
  policy.publish("late");
  assert.equal(readGatewayAccessPolicyRevision(bound), undefined);
  assert.throws(authority.assertCurrent, PluginInstanceUnavailableError);
}

const scenario = process.argv[2];
if (scenario === "retirement") {
  await collect(await retireRegisteredPolicy());
} else if (scenario === "revision") {
  await observePolicyRevision();
} else {
  assert.equal(scenario, "live-grant");
  await observeLiveGrant();
}
console.log(JSON.stringify({ scenario, node: process.version, nativeCleanupCompleted: true }));
