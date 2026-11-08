export { isSessionRunStateActive } from "../../../src/shared/session-run-state.js";

/** Chat-only presentation: settlement still owns an active, abortable run. */
export function isSessionRunVisuallyActive(active: boolean, phase?: string): boolean {
  return active && phase !== "finishing" && phase !== "answer";
}
