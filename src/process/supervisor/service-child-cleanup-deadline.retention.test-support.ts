import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { collectForRetentionCheck } from "../../test-utils/retention.js";
import { createServiceChildCleanupDeadline } from "./service-child-cleanup-deadline.js";

const storage = new AsyncLocalStorage<object>();
const enabled = () => true;
const noEffect = () => {};

function fixture() {
  const owner = createServiceChildCleanupDeadline({ enabled, expire: noEffect, force: noEffect });
  const caller = {};
  const reference = new WeakRef(caller);
  storage.run(caller, () => {
    owner.begin();
    owner.clear();
  });
  return { owner, reference };
}

const retained = fixture();
await collectForRetentionCheck("service-child-cleanup-deadline");
assert.equal(retained.reference.deref(), undefined, "Cleared deadline must release its caller");
assert.equal(typeof retained.owner.at, "number");
process.stdout.write(JSON.stringify({ callerReleased: true }));
