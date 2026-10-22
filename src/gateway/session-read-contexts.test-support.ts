import { captureAsyncWorkTracker, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const projections = new Set<SessionRowProjection>();
const profileSubscriptions = new Set<() => void>();
const scopeProjections = new WeakMap<AbortSignal, Set<SessionRowProjection>>();
const closing = new WeakMap<SessionRowProjection, Promise<void>>();

async function disposeProjections(owned: Iterable<SessionRowProjection>) {
  const settled = await Promise.allSettled(
    [...owned].map((projection) => {
      let pending = closing.get(projection);
      if (!pending) {
        projection.dispose();
        // Disposal stops publications; accepted reads still own native database custody.
        pending = projection.ensureMaterialized();
        closing.set(projection, pending);
      }
      return pending;
    }),
  );
  const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) {
    throw new AggregateError(errors, "Session read fixture cleanup failed");
  }
}

export function trackSessionReadProjection(projection: SessionRowProjection): void {
  projections.add(projection);
  const signal = getAsyncWorkSignal();
  if (!signal) {
    return;
  }
  let owned = scopeProjections.get(signal);
  if (!owned) {
    owned = new Set();
    scopeProjections.set(signal, owned);
    const track = captureAsyncWorkTracker();
    const scope = owned;
    const dispose = () => {
      // State fixtures drain this scope before revoking their database readers.
      // Keep failures in `closing` so afterEach reports them after joining all reads.
      void track(() => disposeProjections(scope)).catch(() => {});
    };
    signal.addEventListener("abort", dispose, { once: true });
  }
  owned.add(projection);
  if (signal.aborted) {
    void captureAsyncWorkTracker()(() => disposeProjections([projection])).catch(() => {});
  }
}

export function trackSessionReadProfileSubscription(stop: () => void): void {
  profileSubscriptions.add(stop);
}

export async function disposeSessionReadContexts() {
  const disposing = [...projections];
  for (const stop of profileSubscriptions) {
    stop();
  }
  projections.clear();
  profileSubscriptions.clear();
  await disposeProjections(disposing);
}
