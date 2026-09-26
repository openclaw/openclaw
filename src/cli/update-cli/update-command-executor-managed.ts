import { isDeepStrictEqual } from "node:util";
import {
  snapshotUpdateInitialStoreTransport,
  type UpdateInitialStoreTransport,
  type UpdateManagedGenerationIssuer,
} from "../../infra/update-initial-store-transport.js";
import type {
  createManagedHandoffLeaseStore,
  ManagedHandoffLease,
} from "../../infra/update-managed-service-handoff-lease.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

/** Part of the admitted executor lifetime, never an original cancellation receipt. */
export async function admitManagedUpdateCommandGeneration(params: {
  issuer: UpdateManagedGenerationIssuer;
  input: Parameters<UpdateManagedGenerationIssuer>[0];
  assertNative: () => void;
  closeEffects: (cause: Error) => void;
}) {
  const { assertNative, closeEffects } = params;
  const input = structuredClone(params.input);
  if (
    !process.connected ||
    input.lease.helper.pid !== process.ppid ||
    input.lease.executor.pid !== process.pid ||
    input.lease.version !== 2 ||
    input.lease.action.kind !== "update" ||
    input.lease.action.mutationProtocol !== "original-cancellation-v1"
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Managed generation requires its live bound child.",
    );
  }
  assertNative();
  const issued = await params.issuer(structuredClone(input));
  // Capture methods once; a later caller mutation cannot replace this admission.
  const route = {
    assertCurrent: issued.assertCurrent.bind(issued),
    retire: issued.retire.bind(issued),
    select: issued.select.bind(issued),
    terminal: issued.terminal.bind(issued),
    revoke: issued.revoke.bind(issued),
  };
  let failure: Error | undefined;
  let sealed = false;
  let revoked: Promise<void> | undefined;
  let phase: "ready" | "retiring" | "retired" | "selecting" | "terminal" = "ready";
  let transition: string | undefined;
  let selected = snapshotUpdateInitialStoreTransport(input.initialStores);
  function assertCurrent() {
    if (failure) {
      throw failure;
    }
    if (sealed) {
      throw new UpdateCommandRecoveryPendingError("Managed generation is closed.");
    }
    if (!process.connected || process.ppid !== input.lease.helper.pid) {
      throw new UpdateCommandRecoveryPendingError("Managed generation control disconnected.");
    }
    assertNative();
    route.assertCurrent();
  }
  function requestCancellation(cause: Error): Promise<void> {
    if (revoked) {
      return revoked;
    }
    if (sealed) {
      return Promise.reject(new UpdateCommandRecoveryPendingError("Managed generation is closed."));
    }
    failure = cause;
    // No await/message enqueue precedes local refusal. The original synchronous
    // cancellation API is intentionally not registered for this borrowed child.
    closeEffects(cause);
    revoked = Promise.resolve().then(() => route.revoke(cause));
    void revoked.catch(() => {});
    return revoked;
  }
  assertCurrent();
  return {
    assertCurrent,
    requestCancellation,
    seal() {
      sealed = true;
      return failure;
    },
    get cause() {
      return failure;
    },
    async beforeRetire(id: string, current: UpdateInitialStoreTransport) {
      assertCurrent();
      if (phase !== "ready" || !isDeepStrictEqual(current, selected)) {
        throw new UpdateCommandRecoveryPendingError("Managed retirement changed its selection.");
      }
      phase = "retiring";
      transition = id;
      await route.retire(id, selected);
      assertCurrent();
      phase = "retired";
    },
    async select(id: string, current: UpdateInitialStoreTransport) {
      assertCurrent();
      const successor = snapshotUpdateInitialStoreTransport(current);
      const previous = selected.selection;
      const next = successor.selection;
      if (
        phase !== "retired" ||
        id !== transition ||
        !isDeepStrictEqual(previous.privateRoot, next.privateRoot) ||
        !isDeepStrictEqual(previous.handoff, next.handoff) ||
        previous.installation.path !== next.installation.path ||
        previous.state.databasePath !== next.state.databasePath ||
        previous.state.parentIdentity !== next.state.parentIdentity
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Managed selection changed its retired transition.",
        );
      }
      phase = "selecting";
      await route.select(id, successor);
      assertCurrent();
      selected = successor;
      phase = "ready";
      transition = undefined;
    },
    async terminal(current: UpdateInitialStoreTransport) {
      assertCurrent();
      if (phase !== "ready" || !isDeepStrictEqual(current, selected)) {
        throw new UpdateCommandRecoveryPendingError("Managed terminal generation is unresolved.");
      }
      phase = "terminal";
      await route.terminal(snapshotUpdateInitialStoreTransport(selected));
      assertCurrent();
    },
  };
}

type Outcome<T> = { result: T } | { error: Error };
type ManagedGeneration = Awaited<ReturnType<typeof admitManagedUpdateCommandGeneration>>;

/** Synchronously close cancellation admission before awaiting the final accepted ACK.
 * This also catches cancellation queued after terminal's last assertion. */
export async function completeManagedUpdateCommandOutcome<T>(
  managed: ManagedGeneration | undefined,
  outcome: Outcome<T>,
): Promise<Outcome<T>> {
  if (managed && "error" in outcome) {
    void managed.requestCancellation(outcome.error).catch(() => {});
  }
  const cause = managed?.seal();
  const merged = cause
    ? {
        error:
          "error" in outcome && outcome.error !== cause
            ? new AggregateError(
                [outcome.error, cause],
                "Managed update failed during cancellation",
              )
            : cause,
      }
    : outcome;
  return revokeManagedUpdateCommandOutcome(managed, merged);
}

export async function revokeManagedUpdateCommandOutcome<T>(
  managed: ManagedGeneration | undefined,
  outcome: Outcome<T>,
): Promise<Outcome<T>> {
  if (managed && "error" in outcome) {
    try {
      await managed.requestCancellation(outcome.error);
    } catch (cause) {
      return {
        error: new AggregateError(
          [outcome.error, cause],
          "Managed revoke commit was not confirmed",
        ),
      };
    }
  }
  return outcome;
}

/** Called after the executor's command and descendant joins, while IPC is live. */
export async function finishManagedUpdateCommandGeneration<T>(
  managed: ManagedGeneration | undefined,
  originalOutcome: Outcome<T>,
  current: UpdateInitialStoreTransport | undefined,
  assertReady: () => void,
): Promise<Outcome<T>> {
  let outcome = originalOutcome;
  if (managed && "result" in outcome) {
    try {
      assertReady();
      if (!current) {
        throw new UpdateCommandRecoveryPendingError("Managed terminal selection is missing.");
      }
      await managed.terminal(current);
    } catch (cause) {
      outcome = {
        error:
          cause instanceof Error
            ? cause
            : new Error("Managed terminal admission failed", { cause }),
      };
    }
  }
  return revokeManagedUpdateCommandOutcome(managed, outcome);
}

export function readManagedUpdateCommandRetainedLease(
  store: ReturnType<typeof createManagedHandoffLeaseStore>,
  key: string,
  lease: ManagedHandoffLease,
) {
  const retained = store.read(key);
  if (
    retained.kind !== "current" ||
    retained.lease.version !== 2 ||
    retained.lease.action.kind !== "update" ||
    retained.lease.action.mutationProtocol !== "original-cancellation-v1" ||
    retained.lease.owner !== lease.owner ||
    !isDeepStrictEqual(retained.lease.helper, lease.helper) ||
    !isDeepStrictEqual(retained.lease.executor, lease.executor) ||
    !store.acceptParentBoundExecutor(retained.lease)
  ) {
    throw new UpdateCommandRecoveryPendingError("Managed helper retained pair changed.");
  }
  return retained.lease;
}

export function assertManagedAdmission(
  issuer: UpdateManagedGenerationIssuer | undefined,
  managed: ManagedGeneration | undefined,
  complete: boolean,
): void {
  if (issuer && (!managed || !complete)) {
    throw new UpdateCommandRecoveryPendingError("Managed generation admission is incomplete.");
  }
}

/** Managed target planning is explicit; missing plan is not a no-pair selection. */
export function assertManagedUpdateCommandPlan(
  issuer: UpdateManagedGenerationIssuer | undefined,
  plan: { serviceRoot?: string } | undefined,
): void {
  if (issuer && !Object.hasOwn(plan ?? {}, "serviceRoot")) {
    throw new UpdateCommandRecoveryPendingError("Managed service-root plan is missing.");
  }
}

/** Refuse redirected roots before the direct-original acquisition fallback. */
export function assertManagedUpdateCommandRoot(
  issuer: UpdateManagedGenerationIssuer | undefined,
  found: ReturnType<ReturnType<typeof createManagedHandoffLeaseStore>["read"]>,
  key: string,
): void {
  if (
    issuer &&
    (found.kind !== "current" ||
      found.lease.key !== key ||
      found.lease.helper.pid !== process.ppid ||
      found.lease.executor.pid !== process.pid)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Managed planned installation is not the bound root.",
    );
  }
}
