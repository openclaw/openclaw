import { serialize } from "node:v8";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createKeyedFifoLeaseRegistry } from "../shared/keyed-fifo-lease.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  SQLITE_WORKER_MAX_QUEUED_BYTES,
  SQLITE_WORKER_MAX_REQUESTS,
} from "./sqlite-worker-broker.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES, SqliteWorkerError } from "./sqlite-worker-contract.js";
import type { DatabasePathIdentity } from "./sqlite-worker-identity.js";

type PendingOperation = { context: OpenClawStateWorkerContext; settled: Promise<void> };

const leases = createKeyedFifoLeaseRegistry(Symbol.for("openclaw.webPushStoreLeases"));
const admissions = resolveGlobalSingleton(Symbol.for("openclaw.webPushStoreAdmissions"), () => {
  const state = { count: 0, bytes: 0, pending: new Set<PendingOperation>() };
  registerOpenClawStateDatabaseAsyncResource({
    async close(identity?: DatabasePathIdentity) {
      await Promise.all(
        [...state.pending]
          .filter(
            (operation) => !identity || operation.context.admission.identity.key === identity.key,
          )
          .map((operation) => operation.settled),
      );
    },
  });
  return state;
});

async function runAdmittedScope<T>(
  context: OpenClawStateWorkerContext,
  input: unknown,
  operation: (releaseBudget: () => void) => Promise<T>,
): Promise<T> {
  context.admission.assertCurrent();
  const bytes = serialize(input).byteLength;
  if (
    bytes > SQLITE_WORKER_MAX_MESSAGE_BYTES ||
    admissions.count >= SQLITE_WORKER_MAX_REQUESTS ||
    admissions.bytes + bytes > SQLITE_WORKER_MAX_QUEUED_BYTES
  ) {
    throw new SqliteWorkerError("Web Push storage admission capacity reached", "overloaded");
  }
  const { identity } = context.admission;
  const lease = expectDefined(
    leases.reserve([identity.key, `path:${identity.canonicalPath}`]),
    "Web Push storage identity lease",
  );
  const settled = createDeferredCore();
  const pending = { context, settled: settled.promise };
  admissions.pending.add(pending);
  admissions.count += 1;
  admissions.bytes += bytes;
  let budgetHeld = true;
  const releaseBudget = () => {
    if (budgetHeld) {
      budgetHeld = false;
      admissions.count -= 1;
      admissions.bytes -= bytes;
    }
  };
  try {
    await lease.wait();
    context.admission.assertCurrent();
    return await operation(releaseBudget);
  } finally {
    releaseBudget();
    lease.release();
    admissions.pending.delete(pending);
    settled.resolve();
  }
}

function runScope<T>(
  context: OpenClawStateWorkerContext,
  input: unknown,
  operation: (releaseBudget: () => void) => Promise<T>,
): Promise<T> {
  const run = () => runAdmittedScope(context, input, operation);
  const maintenance = context.maintenanceScope;
  return maintenance ? maintenance.run(() => maintenance.track(run())) : run();
}

/** Binding writers and snapshot consumers share one short admission interval. */
export function runWebPushStoreMutation<T>(
  context: OpenClawStateWorkerContext,
  input: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  return runScope(context, input, operation);
}

export type WebPushSnapshotAction<T> = { start: () => T | Promise<T> };

/** Finish policy preparation and start the effect before allowing the next binding mutation. */
export async function useWebPushStoreSnapshot<Snapshot, T>(
  context: OpenClawStateWorkerContext,
  input: unknown,
  read: () => Promise<Snapshot>,
  prepare: (
    snapshot: Snapshot,
    assertCurrent: () => void,
  ) => WebPushSnapshotAction<T> | undefined | Promise<WebPushSnapshotAction<T> | undefined>,
): Promise<T | undefined> {
  const begun = await runScope(context, input, async (releaseBudget) => {
    const snapshot = await read();
    const prepared = prepare(snapshot, () => context.admission.assertCurrent());
    const action = prepared instanceof Promise ? await prepared : prepared;
    context.admission.assertCurrent();
    // The read is settled. A synchronous start may enqueue its own subsequent write.
    releaseBudget();
    return { value: action?.start() };
  });
  // Provider completion must not hold the binding lease or delay browser registration.
  return begun.value;
}
