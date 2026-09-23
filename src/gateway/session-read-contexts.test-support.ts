import type { SessionRowProjection } from "./session-row-projection.js";

const projections = new Set<SessionRowProjection>();
const profileSubscriptions = new Set<() => void>();

export function trackSessionReadProjection(projection: SessionRowProjection): void {
  projections.add(projection);
}

export function trackSessionReadProfileSubscription(stop: () => void): void {
  profileSubscriptions.add(stop);
}

export async function disposeSessionReadContexts() {
  const disposing = [...projections];
  for (const projection of disposing) {
    projection.dispose();
  }
  for (const stop of profileSubscriptions) {
    stop();
  }
  projections.clear();
  profileSubscriptions.clear();
  // Disposal stops publications; accepted reads still own native database custody.
  const settled = await Promise.allSettled(
    disposing.map((projection) => projection.ensureMaterialized()),
  );
  const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) {
    throw new AggregateError(errors, "Session read fixture cleanup failed");
  }
}
