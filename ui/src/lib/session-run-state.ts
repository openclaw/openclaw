export { isSessionRunActive } from "../../../src/shared/session-run-state.js";

/** Presentation only: settlement still owns an active, abortable run. */
export function isSessionRunVisuallyActive(active: boolean, phase?: string): boolean {
  return active && phase !== "finishing" && phase !== "answer";
}
