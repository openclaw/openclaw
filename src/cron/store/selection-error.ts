import type { CronStoreSelection } from "./selection.types.js";

/** An operator choice pauses cron without requiring Gateway recovery. */
export class CronStoreSelectionRequiredError extends Error {
  readonly code = "CRON_STORE_SELECTION_REQUIRED";
  constructor(readonly selection: Extract<CronStoreSelection, { status: "unresolved" }>) {
    super(selection.message);
    this.name = "CronStoreSelectionRequiredError";
  }
}
