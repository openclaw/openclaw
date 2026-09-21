import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { types } from "node:util";
import { createPluginRecord } from "./loader-records.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";

const context = {
  config: {},
  profile: {
    profileId: "access-signal-profile",
    emails: ["access-signal@example.test"],
    assignedRole: "guest",
  },
  requiredByRole: true,
};

function createRegisteredPolicy() {
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
  api.registerGatewayAccessPolicy({
    authorize() {
      return Object.freeze({
        assertCurrent() {
          grant.signal.throwIfAborted();
          lifetime.signal.throwIfAborted();
        },
        signal: AbortSignal.any([grant.signal, lifetime.signal]),
      });
    },
  });
  const registration = builder.registry.gatewayAccessPolicies[0];
  assert.ok(registration);
  const authorize = () => {
    const authority = registration.policy.authorize(context);
    assert.ok(authority);
    assert.equal(types.isProxy(authority.signal), false, "Native cleanup must not enter a proxy");
    authority.assertCurrent();
    return authority;
  };
  return { grant, lifetime, instance, registration, authorize };
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
  const policy = createRegisteredPolicy();
  const authority = policy.authorize();
  const hostInvalidated = new AbortController();
  const hostSignal = AbortSignal.any([hostInvalidated.signal, authority.signal]);
  const onAbort = () => undefined;
  hostSignal.addEventListener("abort", onAbort, { once: true });
  assert.equal(hostSignal.aborted, false);

  // Preserve the failing order: requester release, service stop, instance retirement, GC.
  hostSignal.removeEventListener("abort", onAbort);
  // A pending Promise is valid abort data; projecting it must not retain plugin work.
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
    const retainedSignal = policy.authorize().signal;
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
  const nextSignal = nextPolicy.authorize().signal;
  assert.deepEqual((await nextPolicy.instance.dispose()).errors, []);
  assert.equal(nextPolicy.grant.signal.aborted, false);
  assert.equal(nextSignal.aborted, true, "Plugin retirement must end still-live access");
}

const scenario = process.argv[2];
if (scenario === "retirement") {
  await collect(await retireRegisteredPolicy());
} else {
  assert.equal(scenario, "live-grant");
  await observeLiveGrant();
}
console.log(JSON.stringify({ scenario, node: process.version, nativeCleanupCompleted: true }));
