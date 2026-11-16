import type { PreparedReadinessChecker, ReadinessChecker } from "./readiness.js";

export function createPreparedReadinessFixture(
  read: ReadinessChecker = () => ({ ready: true, coreReady: true, failing: [], uptimeMs: 0 }),
): PreparedReadinessChecker {
  return Object.assign(read, { prepare: async () => ({ publish: read }) });
}
