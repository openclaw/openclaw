// Observation and fault hooks for the work-dispatch suites, which run over the
// REAL continuation custody store. Suites wrap `updateContinuationRecords`
// with `wrapCustodyStoreForWorkDispatch` inside `vi.mock`:
//
//   vi.mock("./custody/custody-store.js", async (importOriginal) =>
//     (await import("./work-dispatch-flow-mock.test-support.js"))
//       .wrapCustodyStoreForWorkDispatch(await importOriginal()));
//
// Every write still commits in the real store. The hooks only observe applied
// writes, or put a real concurrent writer (or a refused write) in front of one.
// The recipient-authority capture and checks read the real agent database the
// same way, so suites count them with `wrapWorkRecipientAuthorityForWorkDispatch`.
import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";
import type * as CustodyStore from "./custody/custody-store.js";
import type {
  ContinuationRecord,
  ContinuationRecordUpdate,
} from "./custody/custody-store.types.js";
import type * as WorkRecipientAuthority from "./work-recipient-authority.js";

type CustodyStoreModule = typeof CustodyStore;

export type WorkDispatchCustodyHooks = {
  /** Called once per record of every applied update, in commit order. */
  onApplied?: (update: ContinuationRecordUpdate, record: ContinuationRecord) => void;
  /** Called before each update is handed to the store; may commit a concurrent write. */
  beforeUpdate?: (updates: readonly ContinuationRecordUpdate[]) => Promise<void> | void;
  /** Refuse every update with this reason, committing nothing. */
  refuseUpdatesWith?: string;
  /** Put a real concurrent revision bump in front of the next N single-record updates. */
  revisionConflictsRemaining: number;
  /**
   * The Gateway dies as a matching update is issued: it never commits and the call never settles,
   * so nothing after it runs in the dying process. A dead process has nothing in flight.
   */
  diesBefore?: (updates: readonly ContinuationRecordUpdate[]) => boolean;
};

/**
 * The session store the suites' mocked path owner names. Absolute under the hermetic state dir:
 * the recipient-authority capture and checks open its real database.
 */
export const WORK_DISPATCH_STORE_PATH = path.join(
  resolveStateDir(),
  "work-dispatch",
  "sessions.json",
);

export const workDispatchCustodyHooks: WorkDispatchCustodyHooks = {
  revisionConflictsRemaining: 0,
};

// Custody commands run on the shared-state worker, so their replies arrive as
// real macrotasks that fake timers never advance. Captured before any suite
// installs fake timers.
const realSetImmediate = globalThis.setImmediate;
const realNow = performance.now.bind(performance);
/** Generous bound on one settle, in real milliseconds, for slow CI hosts. */
const SETTLE_DEADLINE_MS = 30_000;
let custodyCommandsInFlight = 0;
const custodyCommandNamesInFlight = new Map<string, number>();

/**
 * Let background dispatch work reach its next fake-timer boundary: yield real
 * macrotasks until no custody command has been in flight for a while.
 * Work parked on a fake timer stays parked, as in production between ticks.
 */
export async function settleWorkDispatchCustody(): Promise<void> {
  // Quiet means no command in flight across several turns and a few real
  // milliseconds, so a cold dynamic import between two commands is not
  // mistaken for the end of the chain.
  let idleTurns = 0;
  let idleSince = realNow();
  const deadline = realNow() + SETTLE_DEADLINE_MS;
  while ((idleTurns < 5 || realNow() - idleSince < 2) && realNow() < deadline) {
    await new Promise<void>((resolve) => {
      realSetImmediate(resolve);
    });
    if (custodyCommandsInFlight === 0) {
      idleTurns += 1;
    } else {
      idleTurns = 0;
      idleSince = realNow();
    }
  }
  if (custodyCommandsInFlight !== 0) {
    throw new Error(
      `custody commands did not settle: ${[...custodyCommandNamesInFlight].map(([name, count]) => `${name}x${count}`).join(", ")}`,
    );
  }
}

function countInFlight<Args extends unknown[], Result>(
  name: string,
  run: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    custodyCommandsInFlight += 1;
    custodyCommandNamesInFlight.set(name, (custodyCommandNamesInFlight.get(name) ?? 0) + 1);
    try {
      return await run(...args);
    } finally {
      custodyCommandsInFlight -= 1;
      const remaining = (custodyCommandNamesInFlight.get(name) ?? 1) - 1;
      if (remaining === 0) {
        custodyCommandNamesInFlight.delete(name);
      } else {
        custodyCommandNamesInFlight.set(name, remaining);
      }
    }
  };
}

export function resetWorkDispatchCustodyHooks(): void {
  delete workDispatchCustodyHooks.onApplied;
  delete workDispatchCustodyHooks.beforeUpdate;
  delete workDispatchCustodyHooks.refuseUpdatesWith;
  delete workDispatchCustodyHooks.diesBefore;
  workDispatchCustodyHooks.revisionConflictsRemaining = 0;
}

/** The transition names the dispatch-ordering assertions observe. */
export function describeWorkTransition(update: ContinuationRecordUpdate): string | undefined {
  const { patch } = update;
  if (patch.phase === "Continuation wake delivered (durable mark)") {
    return "delivered-mark-committed";
  }
  if (patch.phase === "Continuation fold note delivered (durable mark)") {
    return "fold-delivered-mark-committed";
  }
  if (patch.status === "succeeded") {
    return `flow-finished:${patch.phase ?? "unknown"}`;
  }
  return undefined;
}

// Synchronous exports stay unwrapped: an async wrapper would hand callers a
// Promise where they expect a value (a record id, a database path).
const SYNCHRONOUS_CUSTODY_EXPORTS = new Set([
  "newContinuationRecordId",
  "resolveContinuationCustodyDatabasePath",
]);

export function wrapCustodyStoreForWorkDispatch(actual: CustodyStoreModule): CustodyStoreModule {
  const updateContinuationRecords: CustodyStoreModule["updateContinuationRecords"] = async (
    updates,
    params,
    options,
  ) => {
    const hooks = workDispatchCustodyHooks;
    await hooks.beforeUpdate?.(updates);
    const first = updates[0];
    if (hooks.refuseUpdatesWith !== undefined && first) {
      return {
        outcome: "invalid_transition",
        recordId: first.recordId,
        reason: hooks.refuseUpdatesWith,
      };
    }
    if (hooks.revisionConflictsRemaining > 0 && updates.length === 1 && first) {
      hooks.revisionConflictsRemaining -= 1;
      // A concurrent writer commits at the caller's expected revision first.
      await actual.updateContinuationRecords(
        [{ ...first, patch: { updatedAt: params.now } }],
        params,
        options,
      );
    }
    const result = await actual.updateContinuationRecords(updates, params, options);
    if (result.outcome === "applied" && hooks.onApplied) {
      for (const record of result.records) {
        const update = updates.find((candidate) => candidate.recordId === record.recordId);
        if (update) {
          hooks.onApplied(update, record);
        }
      }
    }
    return result;
  };
  const wrapped: Record<string, unknown> = { ...actual, updateContinuationRecords };
  for (const [name, value] of Object.entries(wrapped)) {
    if (typeof value === "function" && !SYNCHRONOUS_CUSTODY_EXPORTS.has(name)) {
      wrapped[name] = countInFlight(name, value as (...args: unknown[]) => Promise<unknown>);
    }
  }
  const counted = countInFlight("updateContinuationRecords", updateContinuationRecords);
  // Outside the in-flight accounting: the settle never waits on a dead process's write.
  wrapped.updateContinuationRecords = ((updates, params, options) =>
    workDispatchCustodyHooks.diesBefore?.(updates)
      ? new Promise<never>(() => {})
      : counted(
          updates,
          params,
          options,
        )) satisfies CustodyStoreModule["updateContinuationRecords"];
  // SAFETY: every export keeps its signature; functions only gain in-flight accounting.
  return wrapped as CustodyStoreModule;
}

/** Every recipient-authority read or capture counts as an in-flight command for the settle. */
export function wrapWorkRecipientAuthorityForWorkDispatch(
  actual: typeof WorkRecipientAuthority,
): typeof WorkRecipientAuthority {
  const wrapped = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function"
        ? countInFlight(name, value as (...args: unknown[]) => Promise<unknown>)
        : value,
    ]),
  );
  // SAFETY: every export is async and keeps its signature; it only gains in-flight accounting.
  return wrapped as typeof WorkRecipientAuthority;
}

/** Commit a revision bump on every live work record, as a concurrent writer would. */
export async function bumpLiveWorkRecordRevisions(
  actual: Pick<CustodyStoreModule, "listContinuationRecords" | "updateContinuationRecords">,
): Promise<void> {
  const live = await actual.listContinuationRecords({
    kinds: ["work"],
    statuses: ["queued", "running"],
  });
  for (const record of live) {
    await actual.updateContinuationRecords(
      [
        {
          recordId: record.recordId,
          ownerSessionKey: record.ownerSessionKey,
          expectedRevision: record.revision,
          patch: { updatedAt: record.updatedAt },
        },
      ],
      { now: record.updatedAt },
    );
  }
}
